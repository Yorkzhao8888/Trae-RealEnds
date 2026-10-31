/**
 * uendos CLI — UendOS 壳工程命令行
 *
 * 设计原则：
 *   1. 零依赖（只用 Node 内置模块），团队无需先装一堆工具链；
 *   2. 配置驱动，开发者只改 uendos.config.json；
 *   3. 所有产物可复现：`uendos sync --check` 可在 CI 里拦住手改。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CAPABILITIES, CONTRACT_VERSION, PROFILES, PROFILE_NAMES, validateConfig } from '../../contract/src/index.js';
import { composeShellFile, shellFileName, SHELL_VERSION } from '../../shell/src/index.js';
import { runConformance } from '../../conformance/src/index.js';
import { assetFiles } from './assets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = resolve(HERE, '../templates');
const CONFIG_NAME = 'uendos.config.json';
const TEXT_EXT = new Set(['.json', '.js', '.mjs', '.cjs', '.html', '.sh', '.css', '.md', '.wxml', '.wxss', '.yml', '.yaml']);

// ---------------------------------------------------------------- 参数
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; i++; } else { flags[key] = true; }
  }
  return { pos, flags };
}

const log = (s = '') => console.log(s);
const okMark = (s) => log(`✓ ${s}`);
const badMark = (s) => log(`✗ ${s}`);

function fail(msg) {
  const e = new Error(msg);
  e.uendos = true;
  throw e;
}

function projectDir(flags) {
  return resolve(flags.dir || process.cwd());
}

function loadConfig(flags) {
  const p = join(projectDir(flags), CONFIG_NAME);
  if (!existsSync(p)) fail(`未找到 ${CONFIG_NAME}（先在工程目录执行 uendos init）`);
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { fail(`${CONFIG_NAME} 不是合法 JSON：${e.message}`); }
  return { cfg, path: p };
}

function saveConfig(path, cfg) {
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}

// ---------------------------------------------------------------- 模板
function renderTokens(text, t) {
  return text
    .replaceAll('{{brand}}', t.brand)
    .replaceAll('{{displayName}}', t.displayName)
    .replaceAll('{{appId}}', t.appId)
    .replaceAll('{{accent}}', t.accent)
    .replaceAll('{{shellFile}}', t.shellFile)
    .replaceAll('{{primaryEndUrl}}', t.primaryEndUrl)
    .replaceAll('{{projectName}}', t.projectName)
    .replaceAll('{{mpAppId}}', t.mpAppId)
    .replaceAll('{{allowHosts}}', t.allowHosts)
    .replaceAll('{{endKey}}', t.endKey)
    .replaceAll('{{contractVersion}}', CONTRACT_VERSION);
}

function walk(dir, fn) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

function renderProject(dir, tokens) {
  walk(dir, (p) => {
    if (p.includes(`${join(dir, 'node_modules')}`)) return;
    if (!TEXT_EXT.has(extname(p))) return;
    const raw = readFileSync(p, 'utf8');
    if (!raw.includes('{{')) return;
    writeFileSync(p, renderTokens(raw, tokens));
  });
}

// portal：启动即进主端（原生插件可用，推荐）；
// launcher：先落本机选择页，记住上次端（远程页能否用原生插件取决于 Capacitor 注入，需真机验证）。
function applyLaunchMode(dir, mode) {
  const p = join(dir, 'capacitor.config.json');
  if (!existsSync(p)) return;
  const conf = JSON.parse(readFileSync(p, 'utf8'));
  if (mode === 'launcher' && conf.server) delete conf.server.url;
  writeFileSync(p, JSON.stringify(conf, null, 2) + '\n');
}

function readScripts(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')).scripts || {}; } catch (e) { return {}; }
}

function ensureDeps(dir) {
  if (existsSync(join(dir, 'node_modules'))) return;
  run('npm', ['install'], dir);
}

function ensurePlatform(dir, kind) {
  if (existsSync(join(dir, kind))) return;
  const scripts = readScripts(dir);
  if (scripts[`add:${kind}`]) run('npm', [`run`, `add:${kind}`], dir);
  else run('npx', ['cap', 'add', kind], dir);
}

const SIGN_ENV = ['UENDOS_KEYSTORE', 'UENDOS_KEYSTORE_PASSWORD', 'UENDOS_KEY_ALIAS', 'UENDOS_KEY_PASSWORD'];

function assertSignEnv() {
  const missing = SIGN_ENV.filter((k) => !process.env[k]);
  if (missing.length) fail(`release 签名缺少环境变量：${missing.join('、')}`);
}

function ensureSigning(dir) {
  assertSignEnv();
  const ks = resolve(dir, process.env.UENDOS_KEYSTORE);
  if (!existsSync(ks)) fail(`keystore 不存在：${ks}`);
  const gradlePath = join(dir, 'android', 'uendos-signing.gradle');
  const ksPath = ks.replace(/\\/g, '/');
  writeFileSync(gradlePath, [
    '// 由 uendos pack --release 生成：凭据只从环境变量读取，不落盘。',
    `def uendosKeystore = file(${JSON.stringify(ksPath)})`,
    'def uendosStorePassword = System.getenv(\'UENDOS_KEYSTORE_PASSWORD\')',
    'def uendosKeyAlias = System.getenv(\'UENDOS_KEY_ALIAS\')',
    'def uendosKeyPassword = System.getenv(\'UENDOS_KEY_PASSWORD\')',
    '',
    'android {',
    '    signingConfigs {',
    '        release {',
    '            storeFile uendosKeystore',
    '            storePassword uendosStorePassword',
    '            keyAlias uendosKeyAlias',
    '            keyPassword uendosKeyPassword',
    '        }',
    '    }',
    '    buildTypes {',
    '        release {',
    '            signingConfig signingConfigs.release',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n'));
  const appGradle = join(dir, 'android', 'app', 'build.gradle');
  const raw = readFileSync(appGradle, 'utf8');
  if (!raw.includes('uendos-signing.gradle')) {
    writeFileSync(appGradle, `${raw.trimEnd()}\n\napply from: '../uendos-signing.gradle'\n`);
  }
  okMark(`release 签名已接入（keystore: ${ks}）`);
}

// 首次打包时把 assets/icon.png 生成到各平台资源；之后不再覆盖开发者自定义图标
function ensureBrandAssets(dir) {
  if (!existsSync(join(dir, 'android')) || !existsSync(join(dir, 'assets', 'icon.png'))) return;
  const marker = join(dir, 'android', '.uendos-assets');
  if (existsSync(marker)) return;
  const scripts = readScripts(dir);
  if (!scripts.assets) {
    log('· 未配置 scripts.assets，跳过平台图标生成');
    return;
  }
  run('npm', ['run', 'assets'], dir);
  writeFileSync(marker, 'generated by uendos\n');
}

// ---------------------------------------------------------------- sync
export function syncProject(cfg, dir, { check = false } = {}) {
  const file = shellFileName(cfg);
  const body = composeShellFile(cfg);
  const out = join(dir, 'shell', file);
  mkdirSync(join(dir, 'shell'), { recursive: true });

  if (check) {
    const cur = existsSync(out) ? readFileSync(out, 'utf8') : '';
    if (cur !== body) fail(`产物与配置不一致：${out}（运行 uendos sync）`);
    return out;
  }

  writeFileSync(out, body);
  // App 模板：顺带写入 dist（Capacitor webDir）
  if (existsSync(join(dir, 'dist'))) writeFileSync(join(dir, 'dist', file), body);
  // PC 模板：写运行时配置，main.js 启动时读取
  if ((cfg.targets || []).includes('pc')) {
    const primary = cfg.primaryEnd || Object.keys(cfg.ends)[0];
    writeFileSync(join(dir, 'uendos.runtime.json'), JSON.stringify({
      brand: cfg.brand,
      displayName: cfg.displayName,
      accent: cfg.accent,
      primaryEnd: primary,
      ends: cfg.ends,
      shellFile: file,
    }, null, 2) + '\n');
  }
  return out;
}

// ---------------------------------------------------------------- init
function parseEnds(spec) {
  const ends = {};
  // 兼容中文逗号：开发者从文档/聊天里粘贴端定义时经常带「，」
  for (const seg of spec.split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
    const parts = seg.split(':');
    if (parts.length < 2) fail(`端定义不合法：${seg}（应为 id:url 或 id:name:url）`);
    let id, name, url;
    if (parts.length === 2) { id = parts[0]; url = parts[1]; name = id.toUpperCase(); }
    else { id = parts[0]; name = parts[1]; url = parts.slice(2).join(':'); }
    if (!/^[a-z]{2,4}$/.test(id)) fail(`端 id 不合法：${id}（2–4 位小写字母）`);
    let parsed;
    try { parsed = new URL(url); } catch (e) { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) fail(`端 ${id} 的 url 必须是 http(s) 绝对地址`);
    ends[id] = { name, url };
  }
  if (!Object.keys(ends).length) fail('至少要定义一个端');
  return ends;
}

function cmdInit(pos, flags) {
  const name = pos[0] || flags.name;
  if (!name) fail('用法：uendos init <项目名> --brand <brand> --ends "hp:个人端:https://...，ep:企业端:https://..." --targets app');
  const brand = flags.brand || name.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 12);
  const profile = flags.profile || 'pro';
  const profileDef = PROFILES[profile];
  if (!profileDef) fail(`未知 profile：${profile}（${PROFILE_NAMES.join(' / ')}）`);
  const targets = String(flags.targets || (flags.profile ? profileDef.targets.join(',') : 'app'))
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const t of targets) {
    if (!['app', 'pc', 'mp'].includes(t)) fail(`未知 target：${t}（app / pc / mp）`);
    if (!profileDef.allowedTargets.includes(t)) {
      fail(`profile=${profile} 不允许 target=${t}（允许：${profileDef.allowedTargets.join('/')}）`);
    }
    if (!existsSync(join(TEMPLATES, t))) fail(`模板缺失：${t}`);
  }
  const ends = parseEnds(flags.ends || `hp:个人端:https://hp.${brand}.example.com/`);
  const dir = resolve(flags.dir || name);
  if (existsSync(join(dir, CONFIG_NAME))) fail(`${dir} 已存在 ${CONFIG_NAME}，拒绝覆盖`);

  const appId = flags['app-id'] || `com.uendos.${brand.replace(/-/g, '')}`;
  const displayName = flags.display || ends[Object.keys(ends)[0]].name;
  const accent = flags.accent || '#4C8DFF';
  const launchMode = flags['launch-mode'] || profileDef.launchMode;
  if (!['portal', 'launcher'].includes(launchMode)) fail(`未知 launch-mode：${launchMode}（portal / launcher）`);
  // 品牌名允许连字符，但别名必须是标识符：acme → acmeOS，ci-smoke → ciSmokeOS
  const aliasBase = brand.replace(/-+([a-z0-9])/g, (_, c) => c.toUpperCase());
  const cfg = {
    schemaVersion: 1,
    brand,
    displayName,
    alias: `${aliasBase.slice(0, 14)}OS`,
    prefix: brand,
    accent,
    statusBarStyle: 'dark',
    endKey: `${brand}.end`,
    contractVersion: CONTRACT_VERSION,
    profile,
    targets,
    packageId: appId,
    launchMode,
    ends,
  };

  const hosts = Object.values(ends).map((e) => {
    try { return new URL(e.url).host; } catch (err) { return null; }
  }).filter(Boolean);

  const tokens = {
    brand,
    displayName,
    appId,
    accent,
    shellFile: shellFileName(cfg),
    primaryEndUrl: cfg.ends[Object.keys(cfg.ends)[0]].url,
    projectName: name,
    mpAppId: flags['mp-appid'] || 'touristappid',
    allowHosts: [...new Set(hosts)].map((h) => JSON.stringify(h)).join(','),
    endKey: cfg.endKey,
    contractVersion: CONTRACT_VERSION,
  };

  mkdirSync(dir, { recursive: true });
  for (const t of targets) cpSync(join(TEMPLATES, t), dir, { recursive: true });
  renderProject(dir, tokens);
  saveConfig(join(dir, CONFIG_NAME), cfg);

  if (targets.includes('app')) {
    applyLaunchMode(dir, launchMode);
    const a = assetFiles(dir, { brand, accent });
    if (a.written.length) okMark(`品牌资源已生成：${a.written.map((p) => basename(p)).join('、')}（${a.dir}）`);
  }

  okMark(`工程已创建：${dir}`);
  okMark(`品牌 ${brand} · 端 ${Object.keys(ends).join('/')} · ${profileDef.label}（${profile}） · target ${targets.join('/')} · 启动 ${launchMode}`);
  const out = syncProject(cfg, dir);
  okMark(`品牌桥已生成：${out}（${(readFileSync(out, 'utf8').length / 1024).toFixed(1)} KB）`);
  log('\n下一步：cd ' + dir + ' && npm install && uendos doctor');
}

// ---------------------------------------------------------------- add-end
function cmdAddEnd(pos, flags) {
  const id = pos[0] || flags.id;
  if (!id || !/^[a-z]{2,4}$/.test(id)) fail('用法：uendos add-end <id> --name <名称> --url <https://...>');
  if (!flags.url) fail('缺少 --url');
  const { cfg, path } = loadConfig(flags);
  cfg.ends[id] = { name: flags.name || id.toUpperCase(), url: flags.url };
  saveConfig(path, cfg);
  syncProject(cfg, projectDir(flags));
  okMark(`已添加端 ${id} → ${flags.url}`);
}

// ---------------------------------------------------------------- doctor
async function headOk(url, timeoutMs = 6000) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (r.status >= 200 && r.status < 400) return { ok: true, status: r.status };
    if (r.status === 405) {
      const g = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      return { ok: g.status >= 200 && g.status < 400, status: g.status };
    }
    return { ok: false, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: e && e.message };
  }
}

async function cmdDoctor(flags) {
  const { cfg, path } = loadConfig(flags);
  const dir = projectDir(flags);
  let failed = 0;
  const report = (ok, msg) => { (ok ? okMark : badMark)(msg); if (!ok) failed++; };

  const v = validateConfig(cfg, { allowHttp: !!flags['allow-http'] });
  report(v.ok, v.ok ? `配置合法（契约 ${cfg.contractVersion || CONTRACT_VERSION}）` : `配置错误：${v.errors.join('；')}`);

  try {
    const out = syncProject(cfg, dir, { check: true });
    report(true, `品牌桥与配置一致：shell/${basename(out)}`);
  } catch (e) {
    report(false, e.message);
  }

  if (cfg.profile) {
    const p = PROFILES[cfg.profile];
    report(!!p, p ? `版本档位：${cfg.profile}（${p.label}）` : `未知 profile：${cfg.profile}`);
    if (p) {
      const bad = (cfg.targets || []).filter((t) => !p.allowedTargets.includes(t));
      report(bad.length === 0, bad.length ? `档位不允许的 target：${bad.join('/')}` : `档位 target 合法：${(cfg.targets || []).join('/')}`);
    }
  } else {
    log('· 未设置 profile（旧配置按 pro 能力全集处理）');
  }

  for (const t of cfg.targets || []) {
    if (t === 'app') {
      report(existsSync(join(dir, 'capacitor.config.json')), 'App 模板：capacitor.config.json 存在');
      report(existsSync(join(dir, 'assets', 'icon.png')), '品牌资源：assets/icon.png 存在');
      if (cfg.launchMode === 'launcher') {
        let cap = {};
        try { cap = JSON.parse(readFileSync(join(dir, 'capacitor.config.json'), 'utf8')); } catch (e) {}
        report(!(cap.server && cap.server.url), 'launcher 模式：未固定主端 URL（由本机选择页接管）');
      }
    }
    if (t === 'pc') report(existsSync(join(dir, 'main.js')), 'PC 模板：main.js 存在');
    if (t === 'mp') report(existsSync(join(dir, 'project.config.json')), '小程序模板：project.config.json 存在');
  }

  if (flags.offline) {
    log('· 已跳过端地址连通性检查（--offline）');
  } else {
    for (const [id, end] of Object.entries(cfg.ends)) {
      const r = await headOk(end.url);
      report(r.ok, `端 ${id} 可达：${end.url}${r.ok ? ` (${r.status})` : `（${r.error || r.status}）`}`);
    }
  }

  log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  if (failed) process.exitCode = 1;
}

// ---------------------------------------------------------------- conformance
async function cmdConformance(flags) {
  const dir = projectDir(flags);
  let file = flags.file;
  if (!file) {
    try { loadConfig(flags); } catch (e) { /* 允许直接传文件 */ }
  }
  if (!file) {
    let cfg;
    try { cfg = loadConfig(flags).cfg; } catch (e) { cfg = null; }
    if (cfg) file = join(dir, 'shell', shellFileName(cfg));
    else {
      const f = readdirSync(join(dir, 'shell')).find((n) => n.endsWith('-shell.js'));
      if (!f) fail('未找到品牌桥（先 uendos sync）');
      file = join(dir, 'shell', f);
    }
  }
  const r = await runConformance(file);
  if (flags.json) log(JSON.stringify(r, null, 2));
  else {
    for (const x of r.results) log(`${x.ok ? '✓' : '✗'} ${x.name}${x.ok ? '' : ` — ${x.detail}`}`);
    log(`\n${r.ok ? '通过' : '失败'}：${r.passed} 通过 / ${r.failed} 失败`);
  }
  if (!r.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------- profile
function cmdProfile(flags) {
  if (flags.json) return log(JSON.stringify(PROFILES, null, 2));
  log('档位         默认 target        允许 target        端能力');
  for (const name of PROFILE_NAMES) {
    const p = PROFILES[name];
    const denied = CAPABILITIES.filter((c) => !p.capabilities.includes(c));
    log(`${name.padEnd(10)} ${p.targets.join('/').padEnd(18)} ${p.allowedTargets.join('/').padEnd(18)} ${p.capabilities.length}/${CAPABILITIES.length}` +
      (denied.length ? `（不含：${denied.join('/')}）` : '（全量）'));
  }
  log('\n用法：uendos init <项目名> --profile lite|standard|pro');
  log('说明：profile 只裁剪构建期产物与默认能力集，不是权限边界；租户/角色权限仍由云根校验。');
}

// ---------------------------------------------------------------- assets
function cmdAssets(flags) {
  const { cfg } = loadConfig(flags);
  const r = assetFiles(projectDir(flags), { brand: cfg.brand, accent: cfg.accent, force: !!flags.force });
  if (r.written.length) okMark(`已生成：${r.written.map((p) => basename(p)).join('、')}（${r.dir}）`);
  else log(`· 资源已存在（${r.dir}）；加 --force 覆盖`);
  log('下一步：npm install && npm run assets（把源图展开到 Android/iOS 各尺寸）');
}

// ---------------------------------------------------------------- pack
function run(cmd, args, cwd) {
  log(`$ ${cmd} ${args.join(' ')}  (cwd=${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`${cmd} 退出码 ${r.status}`);
}

function cmdPack(flags) {
  const dir = projectDir(flags);
  const release = !!flags.release;
  const target = flags.target || 'app';
  if (target === 'app') {
    if (!existsSync(join(dir, 'capacitor.config.json'))) fail('缺少 capacitor.config.json：先 uendos init');
    if (release) assertSignEnv();
    ensureDeps(dir);
    const scripts = readScripts(dir);
    if (scripts['prepare:web']) run('npm', ['run', 'prepare:web'], dir);
    ensurePlatform(dir, 'android');
    if (release) ensureSigning(dir);
    ensureBrandAssets(dir);
    run('npx', ['cap', 'sync', 'android'], dir);
    run('./gradlew', [release ? 'assembleRelease' : 'assembleDebug', '--no-daemon'], join(dir, 'android'));
    log(release
      ? '\nAPK（已签名）：android/app/build/outputs/apk/release/app-release.apk'
      : '\nAPK：android/app/build/outputs/apk/debug/app-debug.apk');
  } else if (target === 'ios') {
    if (process.platform !== 'darwin') fail('iOS 打包需要 macOS + Xcode（CI 请用 macos runner）');
    if (!existsSync(join(dir, 'capacitor.config.json'))) fail('缺少 capacitor.config.json：先 uendos init');
    ensureDeps(dir);
    const scripts = readScripts(dir);
    if (scripts['prepare:web']) run('npm', ['run', 'prepare:web'], dir);
    ensurePlatform(dir, 'ios');
    run('npx', ['cap', 'sync', 'ios'], dir);
    const ws = 'ios/App/App.xcworkspace';
    if (release) {
      run('xcodebuild', ['-workspace', ws, '-scheme', 'App', '-configuration', 'Release',
        '-archivePath', 'build/App.xcarchive', 'archive', '-allowProvisioningUpdates'], dir);
      log('\n归档：build/App.xcarchive');
      log('导出 IPA：Xcode Organizer，或 xcodebuild -exportArchive -exportOptionsPlist <plist>');
    } else {
      run('xcodebuild', ['-workspace', ws, '-scheme', 'App', '-configuration', 'Debug',
        '-sdk', 'iphonesimulator', '-derivedDataPath', 'build', 'build'], dir);
      log('\n.app：build/Build/Products/Debug-iphonesimulator/App.app');
    }
  } else if (target === 'pc') {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (!pkg.scripts || !pkg.scripts.dist) fail('package.json 缺少 scripts.dist（electron-builder）');
    run('npm', ['run', 'dist'], dir);
  } else if (target === 'mp') {
    log('小程序不走本地打包：用微信开发者工具导入项目根（project.config.json）后上传。');
    log('AppID 与业务域名需在微信后台配置，CLI 不代持凭证。');
  } else {
    fail(`未知 target：${target}`);
  }
}

// ---------------------------------------------------------------- publish
function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(readFileSync(file));
  return h.digest('hex');
}

function cmdPublish(flags) {
  const { cfg } = loadConfig(flags);
  const file = flags.file;
  if (!file || !existsSync(file)) fail('缺少 --file <安装包路径>');
  const manifestPath = resolve(flags.manifest || join(projectDir(flags), 'btos-app-store/data/apps.json'));
  if (!existsSync(manifestPath)) fail(`找不到清单：${manifestPath}（用 --manifest 指定）`);

  const size = statSync(file).size;
  const sum = sha256(file);
  const name = basename(file);
  const version = flags.version || cfg.version || JSON.parse(readFileSync(join(projectDir(flags), 'package.json'), 'utf8')).version;
  const itemId = flags.item || `${cfg.brand}-app-android`;
  const status = flags.status || 'beta';

  let url = flags.url;
  if (!url) {
    const dl = flags['download-dir'];
    if (!dl) fail('缺少 --url 或 --download-dir');
    mkdirSync(dl, { recursive: true });
    cpSync(file, join(dl, name));
    url = `https://cajob.cewaysoft.com/download/latest/${name}`;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const item = manifest.items.find((x) => x.id === itemId);
  if (!item) fail(`清单里没有条目 ${itemId}`);
  Object.assign(item, { version, size, sha256: sum, url, status, platformLabel: item.platformLabel });
  manifest.generatedAt = new Date().toISOString();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  okMark(`已更新 ${itemId}：v${version} · ${status} · ${size} B · ${sum.slice(0, 12)}…`);
  log(`  url: ${url}`);
}

// ---------------------------------------------------------------- help
function help() {
  log(`UendOS CLI v${SHELL_VERSION}（契约 ${CONTRACT_VERSION}）

用法：
  uendos init <项目名> --brand <brand> --ends "hp:个人端:https://a，ep:企业端:https://b" [--targets app,pc,mp] [--app-id com.x.y] [--dir .]
  uendos add-end <id> --name <名称> --url <https://...>
  uendos sync [--check]          生成 shell/<brand>-shell.js（--check 供 CI 校验一致性）
  uendos doctor [--offline]      配置 / 产物 / 端地址 / 模板体检
  uendos conformance [--json]    跑 39 项契约断言
  uendos assets [--force]        按品牌色生成 assets/icon.png 与 splash.png
  uendos profile [--json]        查看 lite / standard / pro 三档默认 target 与能力集
  uendos pack --target <app|ios|pc|mp> [--release]
  uendos publish --file <包> --item <apps.json 条目> --manifest <清单> --url <下载地址> [--status beta]

init 选项：--profile lite|standard|pro（默认 pro，决定默认 target 与端能力集）
           --launch-mode portal|launcher（默认 portal）
  portal   启动直接进主端（原生插件可用）
  launcher 先落本机选择页，记住上次所选端（?picker=1 强制回选择页）

release 签名（--release）环境变量：
  UENDOS_KEYSTORE / UENDOS_KEYSTORE_PASSWORD / UENDOS_KEY_ALIAS / UENDOS_KEY_PASSWORD

环境变量：配置文件固定 uendos.config.json。`);
}

// ---------------------------------------------------------------- main
export async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos.shift() || 'help';
  if (flags.help || cmd === 'help' || cmd === '-h') return help();
  switch (cmd) {
    case 'init': return cmdInit(pos, flags);
    case 'add-end': return cmdAddEnd(pos, flags);
    case 'sync': {
      const { cfg } = loadConfig(flags);
      const out = syncProject(cfg, projectDir(flags), { check: !!flags.check });
      okMark(`${flags.check ? '产物一致' : '已生成'}：${out}`);
      return;
    }
    case 'doctor': return cmdDoctor(flags);
    case 'conformance': return cmdConformance(flags);
    case 'profile': return cmdProfile(flags);
    case 'assets': return cmdAssets(flags);
    case 'pack': return cmdPack(flags);
    case 'publish': return cmdPublish(flags);
    default: return help();
  }
}
