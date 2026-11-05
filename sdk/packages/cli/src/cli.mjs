/**
 * uendos CLI — UendOS 壳工程命令行
 *
 * 设计原则：
 *   1. 零依赖（只用 Node 内置模块），团队无需先装一堆工具链；
 *   2. 配置驱动，开发者只改 uendos.config.json；
 *   3. 所有产物可复现：`uendos sync --check` 可在 CI 里拦住手改。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, extname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  CAPABILITIES, CONTRACT_VERSION, PROFILES, PROFILE_NAMES, SCHEMA_VERSION,
  resolveEntry, resolveTheme, validateConfig, validatePluginManifest,
} from '../../contract/src/index.js';
import { composeShellFile, shellFileName, SHELL_VERSION } from '../../shell/src/index.js';
import { runConformance } from '../../conformance/src/index.js';
import { assetFiles } from './assets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = resolve(HERE, '../templates');
const CONFIG_NAME = 'uendos.config.json';
const LOCK_NAME = 'uendos.plugins.lock';
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
    const val = next && !next.startsWith('--') ? (i++, next) : true;
    if (flags[key] === undefined) flags[key] = val;
    else if (Array.isArray(flags[key])) flags[key].push(val);
    else flags[key] = [flags[key], val];
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

// ---------------------------------------------------------------- 插件
// 插件必须已 npm install 到工程（或工作区），只用包名，不手写能力声明。
function locatePlugin(dir, name) {
  let cur = dir;
  while (true) {
    const p = join(cur, 'node_modules', ...name.split('/'));
    if (existsSync(join(p, 'uendos.plugin.json'))) return p;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  fail(`插件未安装：${name}（先 npm install ${name}）`);
}

// 只读工程内已装版本，找不到返回 null（供 update 比较新旧，不抛错）
function installedManifest(dir, name) {
  const p = join(dir, 'node_modules', ...name.split('/'), 'uendos.plugin.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// 依赖先注册：config 里的顺序不决定激活顺序，按 requires 拓扑排序；缺依赖或成环直接失败。
function orderPlugins(list) {
  const byId = new Map(list.map((p) => [p.id, p]));
  const done = new Set();
  const visiting = [];
  const out = [];
  function visit(id) {
    if (done.has(id)) return;
    const at = visiting.indexOf(id);
    if (at >= 0) fail(`插件依赖存在循环：${[...visiting.slice(at), id].join(' → ')}`);
    visiting.push(id);
    for (const dep of byId.get(id).manifest.requires || []) {
      if (!byId.has(dep)) fail(`插件 ${id} 依赖的 ${dep} 未在配置中（先安装并 uendos plugin add ${dep}）`);
      visit(dep);
    }
    visiting.pop();
    done.add(id);
    out.push(byId.get(id));
  }
  for (const p of list) visit(p.id);
  return out;
}

function resolvePlugins(cfg, dir) {
  const out = [];
  for (const name of cfg.plugins || []) {
    const pdir = locatePlugin(dir, name);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(pdir, 'uendos.plugin.json'), 'utf8'));
    } catch (e) {
      fail(`插件 ${name} 的 uendos.plugin.json 无法解析：${e.message}`);
    }
    const v = validatePluginManifest(manifest, { name, profile: cfg.profile });
    if (!v.ok) fail(`插件 ${name} 声明不合法：${v.errors.join('；')}`);
    const rtPath = join(pdir, manifest.runtime);
    if (!existsSync(rtPath)) fail(`插件 ${name} 缺少 runtime：${manifest.runtime}`);
    const runtime = readFileSync(rtPath, 'utf8');
    if (!runtime.trim()) fail(`插件 ${name} 的 runtime 为空`);
    out.push({
      id: name,
      version: manifest.version,
      runtime,
      runtimePath: rtPath,
      assertsPath: manifest.asserts ? join(pdir, manifest.asserts) : null,
      manifest,
    });
  }
  return orderPlugins(out);
}

async function loadAssertions(p) {
  if (!existsSync(p.assertsPath)) fail(`插件 ${p.id} 的断言文件不存在：${p.assertsPath}`);
  const mod = await import(pathToFileURL(p.assertsPath).href);
  const arr = mod.default || mod.assertions;
  if (!Array.isArray(arr)) fail(`插件 ${p.id} 的断言文件必须默认导出数组`);
  return arr;
}

// ---------------------------------------------------------------- 插件锁
// 锁住的是「版本 + 运行时内容哈希」：只锁版本挡不住代码被替换。
function runtimeIntegrity(text) {
  return `sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function lockEntry(p) {
  const entry = {
    version: p.version,
    integrity: runtimeIntegrity(p.runtime),
    env: p.manifest.env || [],
    capabilities: p.manifest.capabilities,
    methods: p.manifest.methods,
  };
  if (p.manifest.requires && p.manifest.requires.length) entry.requires = p.manifest.requires;
  return entry;
}

function readLock(dir) {
  const p = join(dir, LOCK_NAME);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (!raw || !raw.plugins || typeof raw.plugins !== 'object') fail(`${LOCK_NAME} 结构不合法（缺少 plugins）`);
    return raw;
  } catch (e) {
    if (e.uendos) throw e;
    fail(`${LOCK_NAME} 不是合法 JSON：${e.message}`);
  }
}

function lockDiff(dir, plugins) {
  const errors = [];
  const lock = readLock(dir);
  if (!plugins.length) {
    if (lock) errors.push(`${LOCK_NAME} 存在但配置没有插件（运行 uendos sync 清理）`);
    return errors;
  }
  if (!lock) return [`插件锁缺失（运行 uendos sync 生成 ${LOCK_NAME}）`];
  for (const p of plugins) {
    const e = lock.plugins[p.id];
    if (!e) { errors.push(`插件锁缺少 ${p.id}（运行 uendos sync）`); continue; }
    if (e.version !== p.version) errors.push(`${p.id} 版本与锁不一致：锁 ${e.version} / 实装 ${p.version}`);
    if (e.integrity !== runtimeIntegrity(p.runtime)) errors.push(`${p.id} 运行时与锁不一致（插件被改动或重装）`);
  }
  for (const id of Object.keys(lock.plugins)) {
    if (!plugins.some((p) => p.id === id)) errors.push(`插件锁含未配置插件：${id}`);
  }
  return errors;
}

function writeLock(dir, plugins) {
  const entries = plugins.map((p) => [p.id, lockEntry(p)]);
  writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ version: 1, plugins: Object.fromEntries(entries) }, null, 2) + '\n');
}

function syncLock(dir, plugins, check) {
  const errors = lockDiff(dir, plugins);
  if (check) {
    if (errors.length) fail(`插件锁不一致：${errors.join('；')}`);
    return;
  }
  const lockPath = join(dir, LOCK_NAME);
  if (!plugins.length) {
    if (existsSync(lockPath)) unlinkSync(lockPath);
    return;
  }
  if (errors.length) writeLock(dir, plugins);
}

// ---------------------------------------------------------------- picker
const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// 选择页是 sync 产物：文案、分组、顺序、是否记忆都由 uendos.config.json 决定。
function renderPicker(cfg) {
  const e = resolveEntry(cfg);
  const data = {
    title: e.title,
    subtitle: e.subtitle,
    rememberLast: e.rememberLast,
    order: e.order,
    groups: e.groups,
    rest: e.rest,
    ends: cfg.ends,
    endKey: cfg.endKey,
    shellFile: shellFileName(cfg),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(cfg.displayName)} · 选择身份</title>
<script src="./${shellFileName(cfg)}"></script>
<style>
  /* 颜色、圆角、字号全部来自 ShellCore.applyTheme 写入的 CSS 变量（配置 → theme） */
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; min-height: 100%; background: var(--uendos-bg); color: var(--uendos-ink);
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .page { padding: 32px 22px calc(28px + env(safe-area-inset-bottom)); }
  .head { display: flex; align-items: center; gap: 12px; margin: 16px 0 32px; }
  .mark { width: 44px; height: 44px; border-radius: calc(var(--uendos-radius) * 0.75); background: var(--uendos-accent); color: var(--uendos-bg);
    font-weight: 700; font-size: var(--uendos-fs-xl); display: grid; place-items: center; }
  .head b { font-size: var(--uendos-fs-lg); }
  .head span { display: block; font-size: var(--uendos-fs-xs); color: var(--uendos-ink-muted); letter-spacing: 2px; margin-top: 2px; }
  h1 { font-size: var(--uendos-fs-xl); margin: 0 0 6px; }
  .tip { color: var(--uendos-ink-muted); font-size: var(--uendos-fs-base); margin-bottom: 20px; }
  .grid { display: grid; gap: 12px; }
  .grouplabel { color: var(--uendos-ink-muted); font-size: var(--uendos-fs-sm); margin: 8px 0 -4px; letter-spacing: 1px; }
  .card { display: flex; align-items: center; gap: 14px; padding: 16px 18px; border: 1px solid var(--uendos-line);
    border-radius: var(--uendos-radius); background: var(--uendos-surface); color: inherit; text-decoration: none; width: 100%;
    text-align: left; font: inherit; transition: transform .12s, border-color .12s; }
  .card:active { transform: scale(.985); border-color: var(--uendos-accent); }
  .txt b { font-size: var(--uendos-fs-base); }
  .txt i { display: block; font-style: normal; font-size: var(--uendos-fs-sm); color: var(--uendos-ink-muted); margin-top: 3px; }
  .arrow { margin-left: auto; color: var(--uendos-ink-muted); font-size: var(--uendos-fs-lg); }
  .foot { margin-top: 28px; color: var(--uendos-ink-muted); font-size: var(--uendos-fs-sm); line-height: 1.7; text-align: center; }
</style>
</head>
<body>
<div class="page">
  <div class="head">
    <div class="mark">${esc(cfg.displayName)}</div>
    <div><b>${esc(cfg.displayName)}</b><span>UENDOS SHELL</span></div>
  </div>
  <h1>${esc(e.title)}</h1>
  <div class="tip">${esc(e.subtitle)}</div>
  <div class="grid" id="ends"></div>
  <div class="foot">壳版本 v${CONTRACT_VERSION} · 由 uendos 生成</div>
</div>
<script>
(function () {
  var D = ${json};
  var box = document.getElementById('ends');
  var ends = D.ends || {};

  // launcher 模式：记住上次选择的端；?picker=1 可强制回到本页
  if (D.rememberLast) {
    try {
      var saved = localStorage.getItem(D.endKey);
      if (saved && ends[saved] && location.search.indexOf('picker=1') < 0) {
        location.replace(ends[saved].url);
        return;
      }
    } catch (e) {}
  }

  function card(id) {
    var e = ends[id];
    var btn = document.createElement('button');
    btn.className = 'card';
    btn.innerHTML = '<div class="txt"><b></b><i></i></div><div class="arrow">›</div>';
    btn.querySelector('b').textContent = e.name;
    btn.querySelector('i').textContent = id.toUpperCase();
    btn.onclick = function () {
      try { if (D.rememberLast) localStorage.setItem(D.endKey, id); } catch (err) {}
      if (window.Shell) window.Shell.call('core.switchEnd', { id: id });
      else location.replace(e.url);
    };
    return btn;
  }

  (D.groups || []).forEach(function (g) {
    var ids = (g.ends || []).filter(function (id) { return ends[id]; });
    if (!ids.length) return;
    if (g.label) {
      var label = document.createElement('div');
      label.className = 'grouplabel';
      label.textContent = g.label;
      box.appendChild(label);
    }
    ids.forEach(function (id) { box.appendChild(card(id)); });
  });
  (D.rest || []).forEach(function (id) { if (ends[id]) box.appendChild(card(id)); });

  if (!box.children.length) {
    box.innerHTML = '<div class="tip">未读取到端配置，请检查品牌桥是否加载。</div>';
  }
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- sync
export function syncProject(cfg, dir, { check = false } = {}) {
  const file = shellFileName(cfg);
  const plugins = resolvePlugins(cfg, dir);
  syncLock(dir, plugins, check);
  const pluginCaps = [...new Set(plugins.flatMap((p) => p.manifest.capabilities))];
  // 只在这里拦 caps 相关错误，避免把历史工程里其它宽松项（如 http 端地址）也一并拦掉
  if (cfg.caps !== undefined) {
    const capErrors = validateConfig(cfg, { allowHttp: true, capabilities: pluginCaps })
      .errors.filter((e) => e.startsWith('caps'));
    if (capErrors.length) fail(`能力白名单不合法：${capErrors.join('；')}`);
  }
  const body = composeShellFile(cfg, { plugins });
  const out = join(dir, 'shell', file);
  const withPicker = (cfg.targets || []).includes('app');
  const pickerOut = join(dir, 'shell', 'picker.html');
  const pickerBody = withPicker ? renderPicker(cfg) : '';
  mkdirSync(join(dir, 'shell'), { recursive: true });

  if (check) {
    const pairs = [[out, body]];
    if (withPicker) pairs.push([pickerOut, pickerBody]);
    for (const [target, expected] of pairs) {
      const cur = existsSync(target) ? readFileSync(target, 'utf8') : '';
      if (cur !== expected) fail(`产物与配置不一致：${target}（运行 uendos sync）`);
    }
    return out;
  }

  writeFileSync(out, body);
  if (withPicker) writeFileSync(pickerOut, pickerBody);
  // App 模板：顺带写入 dist（Capacitor webDir）
  if (existsSync(join(dir, 'dist'))) {
    writeFileSync(join(dir, 'dist', file), body);
    if (withPicker) writeFileSync(join(dir, 'dist', 'picker.html'), pickerBody);
  }
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

  let pluginList = [];
  let pluginError = '';
  try { pluginList = resolvePlugins(cfg, dir); } catch (e) { pluginError = e.message; }
  const pluginCaps = [...new Set(pluginList.flatMap((p) => p.manifest.capabilities))];

  const v = validateConfig(cfg, { allowHttp: !!flags['allow-http'], capabilities: pluginCaps });
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

  const theme = resolveTheme(cfg.theme, cfg.accent);
  report(true, `主题：${theme.mode} · accent ${theme.tokens.accent} · 圆角 ${theme.tokens.radius}px · 字号 ${theme.tokens.fontScale}`);

  const entry = resolveEntry(cfg);
  report(true, `入口：${entry.order.length} 个端 · ${entry.groups.length} 组 · 顺序 ${entry.order.join('→')} · 记住上次 ${entry.rememberLast ? '是' : '否'}`);

  if ((cfg.plugins || []).length) {
    if (pluginError) report(false, `插件：${pluginError}`);
    else {
      report(true, `插件：${pluginList.length} 个 · ${pluginList.map((p) => `${p.id}@${p.version}`).join('、')}`);
      report(true, `生效能力集：内置 ${CAPABILITIES.length} 项 + 插件 ${pluginCaps.length} 项（${pluginCaps.join('/')}）`);
      for (const p of pluginList) {
        if (!p.assertsPath) log(`· 插件 ${p.id} 未提供断言（可选：manifest 加 "asserts": "conformance.mjs"）`);
        else if (!existsSync(p.assertsPath)) report(false, `插件 ${p.id} 的断言文件不存在：${p.assertsPath}`);
      }
      const lockErrors = lockDiff(dir, pluginList);
      report(lockErrors.length === 0, lockErrors.length
        ? `插件锁：${lockErrors.join('；')}`
        : `插件锁：${pluginList.length} 个一致（${LOCK_NAME}）`);
    }
  } else {
    log(`· 未配置插件（生效能力集：内置 ${CAPABILITIES.length} 项）`);
  }

  const allow = cfg.caps && Array.isArray(cfg.caps.allow) ? cfg.caps.allow : null;
  if (allow === null) {
    log('· 未配置能力白名单（全量）');
  } else {
    const baseCaps = (PROFILES[cfg.profile] && PROFILES[cfg.profile].capabilities) || CAPABILITIES;
    const keptBuiltin = CAPABILITIES.filter((c) => allow.includes(c)).length;
    const keptPlugin = pluginCaps.filter((c) => allow.includes(c));
    const kept = baseCaps.filter((c) => allow.includes(c)).length + keptPlugin.length;
    const total = baseCaps.length + pluginCaps.length;
    log(`能力白名单：allow ${allow.length} 项 · 生效 ${kept}/${total}（内置 ${keptBuiltin}/${CAPABILITIES.length}` +
      `${pluginCaps.length ? `，插件 ${keptPlugin.join('/') || '0 项'}` : ''}）`);
    if (!allow.length) log('! caps.allow 为空：全部可裁剪能力已关闭');
    log('  口径：构建期裁剪，不是权限边界；租户/角色授权仍由云根校验。');
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

  if (flags['release-check']) {
    const mp = join(dir, RELEASE_MANIFEST);
    if (!existsSync(mp)) report(false, `发布清单缺失：${RELEASE_MANIFEST}（先 uendos pack）`);
    else {
      let m = null;
      try { m = JSON.parse(readFileSync(mp, 'utf8')); } catch (e) { report(false, `发布清单不是合法 JSON：${e.message}`); }
      if (m) {
        report(true, `发布清单：v${m.version} · target ${Object.keys(m.targets || {}).join('/') || '无'}`);
        for (const [t, e] of Object.entries(m.targets || {})) {
          for (const a of e.artifacts || []) {
            const f = join(dir, a.path);
            if (!existsSync(f)) { report(false, `发布清单产物缺失：${a.path}`); continue; }
            report(statSync(f).size === a.size && sha256(f) === a.sha256, `${t} 产物与清单一致：${a.name}（${a.size} B）`);
          }
          if (!e.signed) log(`! ${t} 未签名或未验证（${e.signMode || '未知'}）：不可对外分发`);
        }
        if ((m.targets || {}).pc) {
          const relDir = join(dir, RELEASE_DIR);
          const yml = existsSync(relDir) && readdirSync(relDir).find((n) => /^latest(-mac|-linux)?\.yml$/.test(n));
          if (!yml) report(false, 'PC 更新源缺少 latest.yml');
          else {
            const v = (readFileSync(join(relDir, yml), 'utf8').match(/^version:\s*(.+)$/m) || [])[1];
            report(v === m.version, `PC 更新源版本：${yml} ${v || '缺失'}${v === m.version ? ' 与清单一致' : ` ≠ 清单 ${m.version}`}`);
          }
        }
      }
    }
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
  let cfg = null;
  try { cfg = loadConfig(flags).cfg; } catch (e) { /* 允许直接传文件 */ }
  if (!file) {
    if (cfg) file = join(dir, 'shell', shellFileName(cfg));
    else {
      const f = readdirSync(join(dir, 'shell')).find((n) => n.endsWith('-shell.js'));
      if (!f) fail('未找到品牌桥（先 uendos sync）');
      file = join(dir, 'shell', f);
    }
  }
  const plugins = [];
  if (cfg && (cfg.plugins || []).length) {
    for (const p of resolvePlugins(cfg, dir)) {
      plugins.push({
        id: p.id,
        capabilities: p.manifest.capabilities,
        assertions: p.assertsPath ? await loadAssertions(p) : [],
      });
    }
  }
  const r = await runConformance(file, { plugins, caps: cfg && cfg.caps ? cfg.caps.allow : undefined });
  if (flags.json) log(JSON.stringify(r, null, 2));
  else {
    for (const x of r.results) {
      const mark = x.skipped ? '·' : x.ok ? '✓' : '✗';
      log(`${mark} ${x.name}${x.ok || x.skipped ? '' : ` — ${x.detail}`}${x.skipped ? `（${x.detail}）` : ''}`);
    }
    const skip = r.skipped ? ` / ${r.skipped} 跳过` : '';
    log(`\n${r.ok ? '通过' : '失败'}：${r.passed} 通过${skip} / ${r.failed} 失败`);
  }
  if (!r.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------- upgrade / diff
const CONFIG_KEYS = [
  'schemaVersion', 'contractVersion', 'brand', 'displayName', 'alias', 'accent', 'prefix',
  'ends', 'endKey', 'targets', 'launchMode', 'profile', 'theme', 'entry', 'plugins', 'caps',
];

function expectedProducts(cfg, dir) {
  const plugins = resolvePlugins(cfg, dir);
  const file = shellFileName(cfg);
  const bridge = composeShellFile(cfg, { plugins });
  const withPicker = (cfg.targets || []).includes('app');
  const picker = withPicker ? renderPicker(cfg) : '';
  const items = [{ label: `shell/${file}`, path: join(dir, 'shell', file), body: bridge }];
  if (withPicker) items.push({ label: 'shell/picker.html', path: join(dir, 'shell', 'picker.html'), body: picker });
  if (existsSync(join(dir, 'dist'))) {
    items.push({ label: `dist/${file}`, path: join(dir, 'dist', file), body: bridge });
    if (withPicker) items.push({ label: 'dist/picker.html', path: join(dir, 'dist', 'picker.html'), body: picker });
  }
  return { items, plugins };
}

// 生成物变化通常是局部的：公共前缀/后缀之外就是增删块，足够定位手改。
function simpleLineDiff(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { removed: a.slice(pre, a.length - suf), added: b.slice(pre, b.length - suf) };
}

// 老工程升级：只补版本字段，未知键原样保留；产物与插件锁交给 sync 重新生成。
function cmdUpgrade(flags) {
  const { cfg, path } = loadConfig(flags);
  const dir = projectDir(flags);
  const changes = [];
  if (cfg.schemaVersion !== SCHEMA_VERSION) changes.push(['schemaVersion', cfg.schemaVersion, SCHEMA_VERSION]);
  if (cfg.contractVersion !== CONTRACT_VERSION) changes.push(['contractVersion', cfg.contractVersion, CONTRACT_VERSION]);
  const unknown = Object.keys(cfg).filter((k) => !CONFIG_KEYS.includes(k));

  if (changes.length) {
    const text = changes.map(([k, from, to]) => `${k} ${from == null ? '（缺失）' : from} → ${to}`).join('；');
    if (flags.check) log(`! 需要升级：${text}`);
    else {
      cpSync(path, `${path}.bak`);
      for (const [k, , to] of changes) cfg[k] = to;
      saveConfig(path, cfg);
      okMark(`配置已升级：${text}（备份 ${basename(path)}.bak）`);
    }
  } else {
    log('· 配置版本已是最新');
  }
  if (unknown.length) log(`· 保留未识别的键（需人工确认）：${unknown.join('/')}`);

  if (flags.check) {
    let drift = false;
    try {
      syncProject(cfg, dir, { check: true });
      log('· 产物与插件锁一致');
    } catch (e) {
      drift = true;
      badMark(`产物或插件锁不一致：${e.message}`);
    }
    if (changes.length || drift) process.exitCode = 1;
    return;
  }

  syncProject(cfg, dir);
  okMark('产物与插件锁已重新生成');
  log('下一步：uendos doctor --offline && uendos conformance');
}

function cmdDiff(flags) {
  const { cfg } = loadConfig(flags);
  const dir = projectDir(flags);
  const { items, plugins } = expectedProducts(cfg, dir);
  const products = items.map((it) => {
    const cur = existsSync(it.path) ? readFileSync(it.path, 'utf8') : '';
    const consistent = cur === it.body;
    return { file: it.label, consistent, ...(consistent ? { removed: [], added: [] } : simpleLineDiff(it.body, cur)) };
  });
  const lockIssues = plugins.length
    ? lockDiff(dir, plugins)
    : (readLock(dir) ? [`${LOCK_NAME} 存在但配置没有插件（运行 uendos sync 清理）`] : []);
  const report = { products, lock: { consistent: lockIssues.length === 0, issues: lockIssues } };

  if (flags.json) log(JSON.stringify(report, null, 2));
  else {
    for (const p of products) {
      if (p.consistent) { log(`· ${p.file} 一致`); continue; }
      log(`✗ ${p.file} 不一致（- ${p.removed.length} 行 / + ${p.added.length} 行）`);
      for (const line of p.removed.slice(0, 20)) log(`  - ${line}`);
      for (const line of p.added.slice(0, 20)) log(`  + ${line}`);
    }
    if (lockIssues.length) {
      log(`✗ 插件锁不一致（${LOCK_NAME}）`);
      for (const issue of lockIssues) log(`  - ${issue}`);
    } else {
      log(`· 插件锁一致${plugins.length ? `（${plugins.length} 个）` : '（未配置插件）'}`);
    }
    log('\n提示：运行 uendos sync 重新生成产物与锁。');
  }
  if (products.some((p) => !p.consistent) || lockIssues.length) process.exitCode = 1;
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
  const { cfg } = loadConfig(flags);
  // 出包前强制校验产物与配置一致，避免把旧桥打进安装包
  syncProject(cfg, dir, { check: true });
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
    const apk = join(dir, 'android', 'app', 'build', 'outputs', 'apk',
      release ? 'release/app-release.apk' : 'debug/app-debug.apk');
    if (!existsSync(apk)) fail(`打包成功但未找到 APK：${apk}`);
    const rec = recordRelease(dir, 'app', [apk], release, release ? 'release' : 'debug',
      release ? null : 'debug 签名，不可对外分发');
    const a0 = rec.items[0];
    okMark(`发布清单：${RELEASE_MANIFEST}（app · ${a0.name} · ${a0.size} B · ${a0.sha256.slice(0, 12)}…）`);
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
      log('· 归档目录不写入发布清单；导出 IPA 后再用 uendos publish --verify 校验');
    } else {
      run('xcodebuild', ['-workspace', ws, '-scheme', 'App', '-configuration', 'Debug',
        '-sdk', 'iphonesimulator', '-derivedDataPath', 'build', 'build'], dir);
      log('\n.app：build/Build/Products/Debug-iphonesimulator/App.app');
    }
  } else if (target === 'pc') {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (!pkg.scripts || !pkg.scripts.dist) fail('package.json 缺少 scripts.dist（electron-builder）');
    run('npm', ['run', 'dist'], dir);
    const files = pcArtifacts(dir);
    if (!files.length) fail('electron-builder 未产出安装包（检查 build.directories.output）');
    const rec = recordRelease(dir, 'pc', files, false, null, '未检测签名：取决于构建环境凭据');
    for (const a of rec.items) log(`  产物 ${a.name} · ${a.size} B · ${a.sha256.slice(0, 12)}…`);
    okMark(`发布清单：${RELEASE_MANIFEST}（pc · ${rec.items.length} 个产物 · ${rec.manifest.version}）`);
    const y = writeLatestYml(dir, projectVersion(dir));
    if (y && y.written) okMark(`更新源：${RELEASE_DIR}/${y.written}（v${projectVersion(dir)}）`);
    else if (y && y.skipped) log(`· 已存在 ${RELEASE_DIR}/${y.skipped}（electron-builder 生成，跳过）`);
    else log('· 未找到可写 latest.yml 的安装包');
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

// ---------------------------------------------------------------- 发布清单
const RELEASE_DIR = 'release';
const RELEASE_MANIFEST = 'release/MANIFEST.json';
const PC_EXTS = ['.dmg', '.zip', '.exe', '.AppImage', '.deb', '.rpm', '.pkg'];

function projectVersion(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || '0.0.0'; } catch (e) { return '0.0.0'; }
}

function sha512b64(file) {
  return crypto.createHash('sha512').update(readFileSync(file)).digest('base64');
}

// 同一工程的多个 target 累积到一份清单：app 出 APK、pc 出安装包，互不覆盖。
function recordRelease(dir, target, artifacts, signed, signMode, note) {
  const p = join(dir, RELEASE_MANIFEST);
  let m = { version: projectVersion(dir), generatedAt: null, targets: {} };
  if (existsSync(p)) {
    try {
      const old = JSON.parse(readFileSync(p, 'utf8'));
      if (old && old.targets && typeof old.targets === 'object') m = old;
    } catch (e) { /* 旧清单损坏则重建 */ }
  }
  m.version = projectVersion(dir);
  m.generatedAt = new Date().toISOString();
  const items = artifacts.filter((f) => existsSync(f)).map((f) => ({
    path: relative(dir, f).split(sep).join('/'),
    name: basename(f),
    size: statSync(f).size,
    sha256: sha256(f),
  }));
  m.targets[target] = { artifacts: items, signed, signMode, ...(note ? { note } : {}) };
  mkdirSync(join(dir, RELEASE_DIR), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  return { manifest: m, items };
}

function pcArtifacts(dir) {
  const out = join(dir, RELEASE_DIR);
  if (!existsSync(out)) return [];
  return readdirSync(out)
    .filter((n) => PC_EXTS.includes(extname(n)) && statSync(join(out, n)).isFile())
    .map((n) => join(out, n));
}

// electron-builder 已生成则跳过；没有才按 generic 更新源格式补一份。
function writeLatestYml(dir, version) {
  const out = join(dir, RELEASE_DIR);
  const existing = existsSync(out) && readdirSync(out).find((n) => /^latest(-mac|-linux)?\.yml$/.test(n));
  if (existing) return { skipped: existing };
  const picks = pcArtifacts(dir);
  if (!picks.length) return null;
  const name = process.platform === 'darwin' ? 'latest-mac.yml' : process.platform === 'win32' ? 'latest.yml' : 'latest-linux.yml';
  const primary = basename(picks[0]);
  const lines = [`version: ${version}`, 'files:'];
  for (const f of picks) {
    lines.push(`  - url: ${basename(f)}`, `    sha512: ${sha512b64(f)}`, `    size: ${statSync(f).size}`);
  }
  lines.push(`path: ${primary}`, `sha512: ${sha512b64(picks[0])}`, `releaseDate: '${new Date().toISOString()}'`);
  writeFileSync(join(out, name), `${lines.join('\n')}\n`);
  return { written: name };
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
  if (flags.verify) {
    const mp = resolve(flags['release-manifest'] || join(projectDir(flags), RELEASE_MANIFEST));
    if (!existsSync(mp)) fail(`找不到发布清单：${mp}（先 uendos pack）`);
    let rel;
    try { rel = JSON.parse(readFileSync(mp, 'utf8')); } catch (e) { fail(`发布清单不是合法 JSON：${e.message}`); }
    const hits = Object.entries(rel.targets || {}).flatMap(([t, e]) => (e.artifacts || []).map((a) => ({ t, a })));
    const hit = hits.find(({ a }) => a.name === name);
    if (!hit) fail(`发布清单里没有 ${name}（重新 uendos pack 后再发布）`);
    if (hit.a.size !== size || hit.a.sha256 !== sum) {
      fail(`产物与发布清单不一致：清单 ${hit.a.size} B / ${hit.a.sha256.slice(0, 12)}…，实物 ${size} B / ${sum.slice(0, 12)}…`);
    }
    okMark(`已校验发布清单：${hit.t} · ${name}（${size} B）`);
  }
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

// ---------------------------------------------------------------- plugin
// 构建期升级：装进工程 → 重新校验声明 → 重新 sync。插件代码不会在运行时远程加载，
// 变更随壳包一起发布（App/PC 沿用既有分发通道）。
function cmdPluginUpdate(names, flags, cfg, dir) {
  const list = [...(cfg.plugins || [])];
  if (!list.length) fail('配置里没有插件（先 uendos plugin add <包名>）');
  const targets = names.length ? names : list;
  for (const n of targets) if (!list.includes(n)) fail(`插件不在配置中：${n}`);
  if (flags.spec && targets.length > 1) fail('--spec 一次只能用于一个插件');
  if (flags.spec === true) fail('--spec 需要一个值（如 <包名>@1.2.0 或 file:./plugin.tgz）');

  const before = {};
  for (const n of targets) before[n] = (installedManifest(dir, n) || {}).version || null;

  for (const n of targets) {
    const spec = flags.spec ? String(flags.spec) : `${n}@latest`;
    run('npm', ['install', spec, '--save-exact', '--no-audit', '--no-fund'], dir);
  }

  const after = resolvePlugins(cfg, dir).filter((p) => targets.includes(p.id));
  syncProject(cfg, dir);
  for (const p of after) {
    const old = before[p.id];
    if (old === p.version) log(`· ${p.id}@${p.version}（已是最新）`);
    else okMark(`${p.id} ${old || '未安装'} → ${p.version}`);
  }
  log('插件变更随壳包发布：记得提交 package-lock.json 并重新出包。');
}

function pluginShortName(id) {
  const base = id.includes('/') ? id.split('/')[1] : id;
  return (base.replace(/^uendos-plugin-/, '') || base).replace(/[^a-z0-9-]/g, '');
}

function deriveCapability(base) {
  const c = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^[a-z]/.test(c) && c ? c : `plugin${c}`;
}

// 插件脚手架只生成「可安装的最小包」，不自动改配置：必须先 npm install 才能 plugin add。
function cmdPluginInit(name, flags, dir) {
  if (!name) fail('用法：uendos plugin init <包名> --capability <能力> [--dir <路径>]');
  const version = flags.version ? String(flags.version) : '0.1.0';
  const short = pluginShortName(name);
  const cap = flags.capability ? String(flags.capability) : deriveCapability(short);
  const env = flags.env
    ? String(flags.env).split(',').map((s) => s.trim()).filter(Boolean)
    : ['capacitor', 'electron', 'mp', 'web'];
  const outDir = resolve(dir, flags.dir ? String(flags.dir) : join('plugins', short));
  const manifest = {
    id: name,
    version,
    runtime: 'runtime.js',
    asserts: 'conformance.mjs',
    env,
    capabilities: [cap],
    methods: [`${cap}.ping`, `${cap}.status`],
  };
  const v = validatePluginManifest(manifest, { name });
  if (!v.ok) fail(`插件声明不合法：${v.errors.join('；')}`);
  if (existsSync(outDir) && !flags.force) fail(`目录已存在：${outDir}（加 --force 覆盖）`);

  const runtime = `// ${name} 插件运行时：由 uendos sync 包进函数作用域注入品牌桥（顶层 return 合法）。
// 方法返回完整结果对象：{ ok: true, data } 或 { ok: false, code, message }。
// 抛异常由运行时统一映射为 E_NATIVE。
return {
  version: '${version}',
  capabilities: { ${cap}: '\u2713' },
  methods: {
    '${cap}.ping': function () {
      return { ok: true, data: { pong: true, at: Date.now() } };
    },
    '${cap}.status': function () {
      return { ok: true, data: { ready: true } };
    },
  },
};
`;
  const asserts = `/**
 * ${name} 插件断言：uendos conformance 会合并到内置断言之后。
 * 每项形如 { name, run(Shell) }；run 抛异常即失败。
 */
export default [
  {
    name: '插件已注册且版本正确',
    run: (Shell) => {
      const p = (Shell.plugins || []).find((x) => x.id === '${name}');
      if (!p) throw new Error('Shell.plugins 里没有 ${name}');
      if (p.version !== '${version}') throw new Error('version=' + p.version);
    },
  },
  {
    name: '能力 ${cap} 已声明',
    run: (Shell) => {
      if (Shell.capabilities.${cap} !== '\u2713') throw new Error('${cap}=' + Shell.capabilities.${cap});
    },
  },
  {
    name: '${cap}.ping 正常返回',
    run: async (Shell) => {
      const r = await Shell.call('${cap}.ping');
      if (!r || !r.ok || !r.data || r.data.pong !== true) throw new Error(JSON.stringify(r));
    },
  },
];
`;
  const pkg = {
    name,
    version,
    private: true,
    description: `UendOS 插件：${cap}`,
    files: ['uendos.plugin.json', 'runtime.js', 'conformance.mjs'],
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'uendos.plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(join(outDir, 'runtime.js'), runtime);
  writeFileSync(join(outDir, 'conformance.mjs'), asserts);

  okMark(`已生成插件包 ${outDir}（${name}@${version}）`);
  log(`  能力 ${cap} · 方法 ${cap}.ping / ${cap}.status · 环境 ${env.join('/')}`);
  const rel = outDir.startsWith(`${dir}/`) ? `./${outDir.slice(dir.length + 1)}` : outDir;
  log('下一步：');
  log(`  npm install ${rel} --save-exact`);
  log(`  uendos plugin add ${name}`);
  log('  uendos doctor && uendos conformance');
}

function pluginHelp() {
  log(`uendos plugin — 插件管理（构建期注册，运行时禁止远程加载）

  uendos plugin list [--json]        列出配置中的插件、安装状态、环境、断言与锁
  uendos plugin init <包名>          生成插件包脚手架（--capability/--env/--dir/--version）
  uendos plugin add <包名>           把已安装的插件写入配置并重新生成品牌桥
  uendos plugin remove <包名>        从配置移除插件并重新生成品牌桥
  uendos plugin update [<包名>...]   构建期升级（默认 @latest），--spec 指定版本或 tarball

  插件包根目录需提供 uendos.plugin.json（id / version / runtime / asserts / env / capabilities / methods / requires）。
  uendos sync 会生成 ${LOCK_NAME}（版本 + 运行时哈希），sync --check 与 doctor 据此拦截漂移。`);
}

function cmdPluginList(flags) {
  const { cfg } = loadConfig(flags);
  const dir = projectDir(flags);
  const names = cfg.plugins || [];
  if (!names.length) {
    log('· 配置里没有插件（uendos plugin add <包名>）');
    return;
  }
  const rows = names.map((id) => {
    const m = installedManifest(dir, id);
    if (!m) return { id, installed: false, requires: [], locked: false };
    const asserts = m.asserts || null;
    const assertsExists = !!asserts && existsSync(join(dir, 'node_modules', ...id.split('/'), asserts));
    const lock = readLock(dir);
    const entry = lock && lock.plugins[id];
    const rtPath = join(dir, 'node_modules', ...id.split('/'), m.runtime);
    const rt = existsSync(rtPath) ? readFileSync(rtPath, 'utf8') : '';
    return {
      id,
      installed: true,
      version: m.version,
      env: m.env || [],
      capabilities: m.capabilities || [],
      requires: m.requires || [],
      asserts,
      assertsExists,
      locked: !!entry && entry.version === m.version && entry.integrity === runtimeIntegrity(rt),
    };
  });
  if (flags.json) return log(JSON.stringify(rows, null, 2));
  log(`插件（声明 ${rows.length} 个）`);
  for (const r of rows) {
    if (!r.installed) {
      log(`✗ ${r.id} 未安装（先 npm install ${r.id}）`);
      continue;
    }
    const env = r.env.length ? r.env.join('/') : '任意';
    const asserts = r.asserts ? `${r.asserts}${r.assertsExists ? '' : '（文件缺失）'}` : '未提供';
    const deps = r.requires.length ? `  依赖 ${r.requires.join('/')}` : '';
    const lock = r.locked ? '' : '  锁 ✗';
    log(`✓ ${r.id}@${r.version}  环境 ${env}  能力 ${r.capabilities.join('/')}  断言 ${asserts}${deps}${lock}`);
  }
}

function cmdPlugin(pos, flags) {
  const sub = pos[0];
  if (!sub) return pluginHelp();
  if (sub === 'list') return cmdPluginList(flags);
  if (sub === 'init') return cmdPluginInit(pos[1], flags, projectDir(flags));
  if (!['add', 'remove', 'update'].includes(sub)) {
    pluginHelp();
    fail(`未知子命令：${sub}`);
  }
  const { cfg, path } = loadConfig(flags);
  const dir = projectDir(flags);
  const list = [...(cfg.plugins || [])];

  if (sub === 'update') return cmdPluginUpdate(pos.slice(1), flags, cfg, dir);

  const name = pos[1];
  if (!name) fail(`用法：uendos plugin ${sub} <包名>`);
  if (sub === 'add') {
    if (cfg.profile === 'lite') fail('profile=lite 不允许插件（请先升档）');
    if (list.includes(name)) fail(`插件已在配置中：${name}`);
    const next = { ...cfg, plugins: [...list, name] };
    resolvePlugins(next, dir); // 先确认已安装且声明合法，再落配置
    cfg.plugins = next.plugins;
    saveConfig(path, cfg);
    syncProject(cfg, dir);
    okMark(`已添加插件 ${name}（记得提交 package-lock.json）`);
  } else {
    if (!list.includes(name)) fail(`插件不在配置中：${name}`);
    const dependents = list.filter((n) => {
      const m = installedManifest(dir, n);
      return m && Array.isArray(m.requires) && m.requires.includes(name);
    });
    if (dependents.length) fail(`插件 ${name} 被以下插件依赖：${dependents.join('、')}（先移除依赖方）`);
    cfg.plugins = list.filter((x) => x !== name);
    saveConfig(path, cfg);
    syncProject(cfg, dir);
    okMark(`已移除插件 ${name}`);
  }
}

// ---------------------------------------------------------------- help
function help() {
  log(`UendOS CLI v${SHELL_VERSION}（契约 ${CONTRACT_VERSION}）

用法：
  uendos init <项目名> --brand <brand> --ends "hp:个人端:https://a，ep:企业端:https://b" [--targets app,pc,mp] [--app-id com.x.y] [--dir .]
  uendos add-end <id> --name <名称> --url <https://...>
  uendos upgrade [--check]       迁移配置版本（备份 .bak）并重新生成产物与插件锁
  uendos diff [--json]           比对配置期望与现有产物/插件锁，不一致退出码 1
  uendos sync [--check]          生成 shell/<brand>-shell.js 与 shell/picker.html（--check 供 CI 校验一致性）
  uendos doctor [--offline] [--release-check]
                                 配置 / 产物 / 端地址 / 模板体检（--release-check 校验发布清单与更新源）
  uendos conformance [--json]    跑契约断言（内置 44 项 + 插件断言，能力被裁剪时跳过）
  uendos assets [--force]        按品牌色生成 assets/icon.png 与 splash.png
  uendos profile [--json]        查看 lite / standard / pro 三档默认 target 与能力集
  uendos plugin list [--json]    列出配置中的插件、安装状态、环境与断言
  uendos plugin init <包名>      生成插件包脚手架（manifest / runtime / 断言）
  uendos plugin add <包名>       把已安装的插件写入配置并重新生成品牌桥
  uendos plugin remove <包名>    从配置移除插件并重新生成品牌桥
  uendos plugin update [<包名>...] [--spec <npm spec>]
                                 构建期升级插件（默认 npm <包名>@latest），重新校验并 sync
  uendos pack --target <app|ios|pc|mp> [--release]
                                 出包并写 release/MANIFEST.json（PC 同时补 latest.yml）
  uendos publish --file <包> --item <apps.json 条目> --manifest <清单> --url <下载地址> [--status beta] [--verify]
                                 --verify 要求产物与 release/MANIFEST.json 的大小/哈希一致

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
    case 'upgrade': return cmdUpgrade(flags);
    case 'diff': return cmdDiff(flags);
    case 'sync': {
      const { cfg } = loadConfig(flags);
      const out = syncProject(cfg, projectDir(flags), { check: !!flags.check });
      okMark(`${flags.check ? '产物一致' : '已生成'}：${out}`);
      return;
    }
    case 'doctor': return cmdDoctor(flags);
    case 'conformance': return cmdConformance(flags);
    case 'profile': return cmdProfile(flags);
    case 'plugin': return cmdPlugin(pos, flags);
    case 'assets': return cmdAssets(flags);
    case 'pack': return cmdPack(flags);
    case 'publish': return cmdPublish(flags);
    default: return help();
  }
}
