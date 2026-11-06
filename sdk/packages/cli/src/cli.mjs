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
  PLUGIN_SIG_ALG, PLUGIN_SIG_FILE, PLUGIN_SIG_VERSION, TRUSTED_FILE, RELEASE_SIGNATURE_STATES,
  UPDATE_CHANNELS, UPDATE_CHANNEL_DEFAULT,
  resolveEntry, resolveTheme, validateConfig, validatePluginManifest,
} from '../../contract/src/index.js';
import { composeShellFile, shellFileName, SHELL_VERSION, BRIDGE_VERSION } from '../../shell/src/index.js';
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
    let manifestText;
    try {
      manifestText = readFileSync(join(pdir, 'uendos.plugin.json'), 'utf8');
      manifest = JSON.parse(manifestText);
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
      dir: pdir,
      version: manifest.version,
      manifestText,
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

// ---------------------------------------------------------------- 插件完整性
// 签名覆盖「id + 版本 + manifest 哈希 + runtime 哈希」：换版本、改声明、改代码都会失效。
function signaturePayload(id, version, manifestHash, runtimeHash) {
  return `${PLUGIN_SIG_VERSION}\n${id}\n${version}\n${manifestHash}\n${runtimeHash}`;
}

function pluginsRequireSigned(cfg) {
  const s = cfg.security && cfg.security.plugins;
  return !(s && s.requireSigned === false);
}

// 公钥从工程目录向上查找；密钥本身不入库，私钥由发布方离线保管。
function readTrusted(dir) {
  let cur = dir;
  while (true) {
    const p = join(cur, TRUSTED_FILE);
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        const keys = Array.isArray(raw.keys) ? raw.keys : [];
        return { path: p, keys };
      } catch (e) {
        fail(`${TRUSTED_FILE} 不是合法 JSON：${e.message}`);
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function verifyPluginSignature(p, trusted) {
  const sigPath = join(p.dir, PLUGIN_SIG_FILE);
  if (!existsSync(sigPath)) return { state: 'unsigned', signer: null, issues: [] };
  let sig;
  try { sig = JSON.parse(readFileSync(sigPath, 'utf8')); } catch (e) {
    return { state: 'invalid', signer: null, issues: [`${p.id} 的 ${PLUGIN_SIG_FILE} 不是合法 JSON`] };
  }
  if (!sig || sig.v !== PLUGIN_SIG_VERSION || sig.alg !== PLUGIN_SIG_ALG
    || typeof sig.keyId !== 'string' || typeof sig.sig !== 'string') {
    return { state: 'invalid', signer: null, issues: [`${p.id} 的签名结构不合法`] };
  }
  const manifestHash = runtimeIntegrity(p.manifestText);
  const runtimeHash = runtimeIntegrity(p.runtime);
  const issues = [];
  if (sig.manifest !== manifestHash || sig.runtime !== runtimeHash) {
    issues.push(`${p.id} 签名与当前内容不匹配（manifest 或 runtime 被改动）`);
  }
  const key = trusted && trusted.keys.find((k) => k && k.id === sig.keyId);
  if (!key) {
    issues.push(`${p.id} 的签名公钥 ${sig.keyId} 不在 ${TRUSTED_FILE}`);
  } else {
    try {
      const ok = crypto.verify(
        null,
        Buffer.from(signaturePayload(p.id, p.version, manifestHash, runtimeHash)),
        crypto.createPublicKey(key.publicKey),
        Buffer.from(sig.sig, 'base64'),
      );
      if (!ok) issues.push(`${p.id} 的 Ed25519 验签失败（内容被改动或签名不匹配）`);
    } catch (e) {
      issues.push(`${p.id} 的公钥无法解析：${e.message}`);
    }
  }
  return { state: issues.length ? 'invalid' : 'signed', signer: sig.keyId, issues };
}

// allowUnsigned 只放行「未签名」，签名损坏、内容被改、公钥缺失一律拒绝。
function auditPlugins(plugins, dir, { allowUnsigned = false, requireSigned = true } = {}) {
  const trusted = readTrusted(dir);
  const errors = [];
  const results = new Map();
  for (const p of plugins) {
    const r = verifyPluginSignature(p, trusted);
    results.set(p.id, r);
    for (const issue of r.issues) errors.push(issue);
    if (r.state === 'unsigned' && !allowUnsigned && requireSigned) {
      errors.push(`${p.id} 未签名（需 --allow-unsigned 或 security.plugins.requireSigned=false）`);
    }
  }
  const states = [...results.values()].map((r) => r.state);
  return {
    results,
    errors,
    state: states.includes('invalid') ? 'invalid' : states.includes('unsigned') ? 'unsigned' : 'signed',
    trusted: trusted ? trusted.path : null,
  };
}

function lockEntry(p, sig) {
  const entry = {
    version: p.version,
    integrity: runtimeIntegrity(p.runtime),
    manifest: runtimeIntegrity(p.manifestText),
    signer: sig && sig.state === 'signed' ? sig.signer : null,
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

function lockDiff(dir, plugins, sigs) {
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
    if (e.manifest !== undefined && e.manifest !== runtimeIntegrity(p.manifestText)) {
      errors.push(`${p.id} manifest 与锁不一致（声明被改动）`);
    }
    const sig = sigs && sigs.get(p.id);
    const signer = sig && sig.state === 'signed' ? sig.signer : null;
    if (Object.prototype.hasOwnProperty.call(e, 'signer') && e.signer !== signer) {
      errors.push(`${p.id} 签名者与锁不一致：锁 ${e.signer || 'unsigned'} / 当前 ${signer || 'unsigned'}`);
    }
  }
  for (const id of Object.keys(lock.plugins)) {
    if (!plugins.some((p) => p.id === id)) errors.push(`插件锁含未配置插件：${id}`);
  }
  return errors;
}

function writeLock(dir, plugins, sigs) {
  const entries = plugins.map((p) => [p.id, lockEntry(p, sigs && sigs.get(p.id))]);
  writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ version: 1, plugins: Object.fromEntries(entries) }, null, 2) + '\n');
}

function syncLock(dir, plugins, check, sigs) {
  const errors = lockDiff(dir, plugins, sigs);
  if (check) {
    if (errors.length) fail(`插件锁不一致：${errors.join('；')}`);
    return;
  }
  const lockPath = join(dir, LOCK_NAME);
  if (!plugins.length) {
    if (existsSync(lockPath)) unlinkSync(lockPath);
    return;
  }
  if (errors.length) writeLock(dir, plugins, sigs);
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
export function syncProject(cfg, dir, { check = false, allowUnsigned = false } = {}) {
  const file = shellFileName(cfg);
  const plugins = resolvePlugins(cfg, dir);
  const audit = auditPlugins(plugins, dir, { allowUnsigned, requireSigned: pluginsRequireSigned(cfg) });
  if (audit.errors.length) fail(`插件完整性校验失败：${audit.errors.join('；')}`);
  syncLock(dir, plugins, check, audit.results);
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
  syncProject(cfg, projectDir(flags), { allowUnsigned: !!flags['allow-unsigned'] });
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

// 通道体检：注册表 current 的桥/契约版本必须与当前一致，指针内的版本与哈希必须对得上本地产物。
function checkChannel(dir, cfg, channel, report, note) {
  const slot = loadChannels(dir).channels[channel];
  const cur = slot && slot.current;
  if (!cur) {
    report(false, `通道 ${channel}：release/channels.json 无发布记录（先 uendos pack --target pc --channel ${channel}）`);
    return;
  }
  const expectContract = cfg.contractVersion || CONTRACT_VERSION;
  report(cur.bridgeVersion === BRIDGE_VERSION,
    `通道 ${channel} 桥版本：${cur.bridgeVersion || '缺失'}${cur.bridgeVersion === BRIDGE_VERSION ? ` 与当前 ${BRIDGE_VERSION} 一致` : ` ≠ 当前 ${BRIDGE_VERSION}（跨桥版本拒绝）`}`);
  report(cur.contractVersion === expectContract,
    `通道 ${channel} 契约版本：${cur.contractVersion || '缺失'}${cur.contractVersion === expectContract ? ` 与当前 ${expectContract} 一致` : ` ≠ 当前 ${expectContract}`}`);
  if (!cur.pointer) { report(false, `通道 ${channel} 缺少指针文件名`); return; }
  const pointerPath = join(dir, RELEASE_DIR, cur.pointer);
  if (!existsSync(pointerPath)) { report(false, `通道 ${channel} 指针缺失：${RELEASE_DIR}/${cur.pointer}`); return; }
  const y = parseLatestYml(readFileSync(pointerPath, 'utf8'));
  report(y.version === cur.version,
    `通道 ${channel} 指针版本：${cur.pointer} ${y.version || '缺失'}${y.version === cur.version ? ' 与注册表一致' : ` ≠ 注册表 ${cur.version}`}`);
  if (!y.files.length) { report(false, `通道 ${channel} 指针缺少 files 列表`); return; }
  for (const f of y.files) {
    const fp = join(dir, RELEASE_DIR, f.url);
    if (!existsSync(fp)) { report(false, `通道 ${channel} 产物缺失：${cur.pointer} → ${f.url}`); continue; }
    report(statSync(fp).size === f.size && sha512b64(fp) === f.sha512,
      `通道 ${channel} 产物与指针一致：${f.url}（${f.size} B）`);
  }
  if (cur.killSwitch) note(`! 通道 ${channel} 已开启 killSwitch：新客户端不再收到 v${cur.version}（灰度 ${cur.rollout}%）`);
  else note(`· 通道 ${channel}：v${cur.version} · 灰度 ${cur.rollout}%${cur.previous ? ` · 可回滚至 v${cur.previous.version}` : ''}`);
}

async function cmdDoctor(flags) {
  const { cfg, path } = loadConfig(flags);
  const dir = projectDir(flags);
  const asJson = !!flags.json;
  let failed = 0;
  const checks = [];
  const report = (ok, msg) => {
    checks.push({ ok, message: msg });
    if (!asJson) (ok ? okMark : badMark)(msg);
    if (!ok) failed++;
  };
  const note = (msg) => { if (!asJson) log(msg); };

  let pluginList = [];
  let pluginError = '';
  let pluginAudit = null;
  try { pluginList = resolvePlugins(cfg, dir); } catch (e) { pluginError = e.message; }
  const pluginCaps = [...new Set(pluginList.flatMap((p) => p.manifest.capabilities))];

  const v = validateConfig(cfg, { allowHttp: !!flags['allow-http'], capabilities: pluginCaps });
  report(v.ok, v.ok ? `配置合法（契约 ${cfg.contractVersion || CONTRACT_VERSION}）` : `配置错误：${v.errors.join('；')}`);

  try {
    const out = syncProject(cfg, dir, { check: true, allowUnsigned: !!flags['allow-unsigned'] });
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
    note('· 未设置 profile（旧配置按 pro 能力全集处理）');
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
      pluginAudit = auditPlugins(pluginList, dir, {
        allowUnsigned: !!flags['allow-unsigned'],
        requireSigned: pluginsRequireSigned(cfg),
      });
      if (pluginAudit.errors.length) {
        report(false, `插件完整性：${pluginAudit.errors.join('；')}`);
      } else {
        const signed = [...pluginAudit.results.entries()].filter(([, r]) => r.state === 'signed');
        const unsigned = [...pluginAudit.results.entries()].filter(([, r]) => r.state === 'unsigned');
        report(true, `插件签名：signed ${signed.length} / unsigned ${unsigned.length}` +
          `${pluginAudit.trusted ? `（信任链 ${basename(pluginAudit.trusted)}）` : '（未找到 ' + TRUSTED_FILE + '）'}`);
        if (unsigned.length) note(`! 未签名插件：${unsigned.map(([id]) => id).join('、')}（--allow-unsigned 放行，出包清单会标注 unsigned）`);
      }
      for (const p of pluginList) {
        if (!p.assertsPath) note(`· 插件 ${p.id} 未提供断言（可选：manifest 加 "asserts": "conformance.mjs"）`);
        else if (!existsSync(p.assertsPath)) report(false, `插件 ${p.id} 的断言文件不存在：${p.assertsPath}`);
      }
      const lockErrors = lockDiff(dir, pluginList, pluginAudit && pluginAudit.results);
      report(lockErrors.length === 0, lockErrors.length
        ? `插件锁：${lockErrors.join('；')}`
        : `插件锁：${pluginList.length} 个一致（${LOCK_NAME}）`);
    }
  } else {
    note(`· 未配置插件（生效能力集：内置 ${CAPABILITIES.length} 项）`);
  }

  const allow = cfg.caps && Array.isArray(cfg.caps.allow) ? cfg.caps.allow : null;
  if (allow === null) {
    note('· 未配置能力白名单（全量）');
  } else {
    const baseCaps = (PROFILES[cfg.profile] && PROFILES[cfg.profile].capabilities) || CAPABILITIES;
    const keptBuiltin = CAPABILITIES.filter((c) => allow.includes(c)).length;
    const keptPlugin = pluginCaps.filter((c) => allow.includes(c));
    const kept = baseCaps.filter((c) => allow.includes(c)).length + keptPlugin.length;
    const total = baseCaps.length + pluginCaps.length;
    note(`能力白名单：allow ${allow.length} 项 · 生效 ${kept}/${total}（内置 ${keptBuiltin}/${CAPABILITIES.length}` +
      `${pluginCaps.length ? `，插件 ${keptPlugin.join('/') || '0 项'}` : ''}）`);
    if (!allow.length) note('! caps.allow 为空：全部可裁剪能力已关闭');
    note('  口径：构建期裁剪，不是权限边界；租户/角色授权仍由云根校验。');
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

  if (flags['release-check'] || flags['integrity']) {
    const mp = join(dir, RELEASE_MANIFEST);
    if (!existsSync(mp)) report(false, `发布清单缺失：${RELEASE_MANIFEST}（先 uendos pack）`);
    else {
      let m = null;
      try { m = JSON.parse(readFileSync(mp, 'utf8')); } catch (e) { report(false, `发布清单不是合法 JSON：${e.message}`); }
      if (m) {
        report(true, `发布清单：v${m.version} · target ${Object.keys(m.targets || {}).join('/') || '无'}`);
        if (flags['integrity']) {
          const sigState = m.signature;
          report(RELEASE_SIGNATURE_STATES.includes(sigState),
            `发布清单签名态：${sigState || '缺失'}（应为 signed / unsigned / dev）`);
          const expectedBridge = BRIDGE_VERSION;
          const expectedContract = cfg.contractVersion || CONTRACT_VERSION;
          report(m.bridgeVersion === expectedBridge,
            `发布清单桥版本：${m.bridgeVersion || '缺失'}${m.bridgeVersion === expectedBridge ? ` 与当前 ${expectedBridge} 一致` : ` ≠ 当前 ${expectedBridge}`}`);
          report(m.contractVersion === expectedContract,
            `发布清单契约版本：${m.contractVersion || '缺失'}${m.contractVersion === expectedContract ? ` 与当前 ${expectedContract} 一致` : ` ≠ 当前 ${expectedContract}`}`);
          const pluginsState = pluginAudit ? pluginAudit.state : 'signed';
          if (sigState === 'signed') {
            report(pluginsState === 'signed',
              `完整性：清单标记 signed，当前插件 ${pluginsState}${pluginsState === 'signed' ? ' 与之一致' : ' 不一致'}`);
          } else if (sigState === 'unsigned') {
            report(pluginsState !== 'signed' || !(cfg.plugins || []).length,
              `完整性：清单标记 unsigned，当前插件 ${pluginsState}`);
          }
        }
        for (const [t, e] of Object.entries(m.targets || {})) {
          for (const a of e.artifacts || []) {
            const f = join(dir, a.path);
            if (!existsSync(f)) { report(false, `发布清单产物缺失：${a.path}`); continue; }
            report(statSync(f).size === a.size && sha256(f) === a.sha256, `${t} 产物与清单一致：${a.name}（${a.size} B）`);
          }
          if (!e.signed) note(`! ${t} 未签名或未验证（${e.signMode || '未知'}）：不可对外分发`);
        }
        if (flags.channel === undefined && (m.targets || {}).pc) {
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
    if (flags.channel !== undefined) checkChannel(dir, cfg, channelArg(flags), report, note);
  }

  if (flags.offline) {
    note('· 已跳过端地址连通性检查（--offline）');
  } else {
    for (const [id, end] of Object.entries(cfg.ends)) {
      const r = await headOk(end.url);
      report(r.ok, `端 ${id} 可达：${end.url}${r.ok ? ` (${r.status})` : `（${r.error || r.status}）`}`);
    }
  }

  if (asJson) {
    // 诊断包只输出结构化结果；URL 去查询串、令牌/手机号打码
    console.log(JSON.stringify({
      ok: failed === 0,
      at: Date.now(),
      version: SHELL_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      contractVersion: cfg.contractVersion || CONTRACT_VERSION,
      project: { dir, config: basename(path) },
      config: {
        brand: cfg.brand,
        displayName: cfg.displayName,
        profile: cfg.profile || null,
        targets: cfg.targets || [],
        launchMode: cfg.launchMode || 'portal',
      },
      plugins: pluginList.map((p) => {
        const a = pluginAudit && pluginAudit.results.get(p.id);
        return { id: p.id, version: p.version, signature: a ? a.state : 'unsigned', signer: a ? a.signer : null };
      }),
      capabilities: {
        builtin: CAPABILITIES.length,
        plugin: pluginCaps,
        allow: allow === null ? null : allow,
      },
      checks: checks.map((c) => ({ ok: c.ok, message: redact(c.message) })),
    }, null, 2));
  } else {
    log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  }
  if (failed) process.exitCode = 1;
}

function redact(text) {
  return String(text)
    .replace(/([?&](?:token|key|secret|password|code|access_token)=)[^&\s）]+/gi, '$1***')
    .replace(/\?[^\s）]*/g, '')
    .replace(/\b1[3-9]\d{9}\b/g, '***');
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
      syncProject(cfg, dir, { check: true, allowUnsigned: !!flags['allow-unsigned'] });
      log('· 产物与插件锁一致');
    } catch (e) {
      drift = true;
      badMark(`产物或插件锁不一致：${e.message}`);
    }
    if (changes.length || drift) process.exitCode = 1;
    return;
  }

  syncProject(cfg, dir, { allowUnsigned: !!flags['allow-unsigned'] });
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
  const channel = channelArg(flags);
  const { cfg } = loadConfig(flags);
  // 出包不强制签名（清单会标注），但签名损坏/内容被改仍然拦截
  syncProject(cfg, dir, { check: true, allowUnsigned: true });
  const pluginList = (cfg.plugins || []).length ? resolvePlugins(cfg, dir) : [];
  const audit = auditPlugins(pluginList, dir, { allowUnsigned: true, requireSigned: false });
  if (audit.state === 'invalid') fail(`插件完整性校验失败：${audit.errors.join('；')}`);
  const pluginsMeta = pluginList.map((p) => {
    const r = audit.results.get(p.id) || { state: 'unsigned', signer: null };
    return { id: p.id, version: p.version, signature: r.state, signer: r.signer };
  });
  const releaseExtras = (sigState) => ({
    signature: sigState, bridgeVersion: BRIDGE_VERSION,
    contractVersion: cfg.contractVersion || CONTRACT_VERSION, plugins: pluginsMeta,
    channel, rollout: ROLLOUT_DEFAULT, killSwitch: false,
  });
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
      release ? null : 'debug 签名，不可对外分发', releaseExtras(release ? audit.state : 'dev'));
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
    const rec = recordRelease(dir, 'pc', files, false, null, '未检测签名：取决于构建环境凭据',
      releaseExtras(audit.state === 'unsigned' ? 'unsigned' : 'dev'));
    for (const a of rec.items) log(`  产物 ${a.name} · ${a.size} B · ${a.sha256.slice(0, 12)}…`);
    okMark(`发布清单：${RELEASE_MANIFEST}（pc · ${rec.items.length} 个产物 · ${rec.manifest.version} · ${channel}）`);
    const version = projectVersion(dir);
    const y = writeLatestYml(dir, version, { channel });
    const pointer = y && (y.written || y.skipped);
    if (pointer) {
      const snapshot = snapshotPointer(dir, channel, version, pointer);
      recordChannelPointer(dir, cfg, channel, version, pointer, snapshot);
      if (y.written) okMark(`更新源：${RELEASE_DIR}/${y.written}（${channel} · v${version}）`);
      else log(`· 已存在 ${RELEASE_DIR}/${y.skipped}（${channel} · electron-builder 生成，跳过写入）`);
      okMark(`更新通道：${channel} → ${pointer}（v${version}）`);
    } else log('· 未找到可写更新指针的安装包');
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
const CHANNELS_FILE = 'release/channels.json';
const CHANNELS_DIR = 'release/.channels';
const ROLLOUT_DEFAULT = 100;
const PC_EXTS = ['.dmg', '.zip', '.exe', '.AppImage', '.deb', '.rpm', '.pkg'];

function channelArg(flags) {
  const raw = flags.channel === undefined ? UPDATE_CHANNEL_DEFAULT : flags.channel;
  if (raw === true || !UPDATE_CHANNELS.includes(String(raw))) {
    fail(`未知通道：${raw === true ? '（缺少值）' : raw}（可选 ${UPDATE_CHANNELS.join(' / ')}）`);
  }
  return String(raw);
}

function rolloutArg(value) {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) fail(`rollout 必须是 0–100 的整数：${value}`);
  return n;
}

// 指针文件名：stable 用 latest[-mac|-linux].yml，beta 用对应 -beta 后缀，互不覆盖。
function pointerName(channel) {
  const base = process.platform === 'darwin' ? 'latest-mac' : process.platform === 'win32' ? 'latest' : 'latest-linux';
  return channel === 'beta' ? `${base}-beta.yml` : `${base}.yml`;
}

function loadChannels(dir) {
  const p = join(dir, CHANNELS_FILE);
  if (!existsSync(p)) return { version: 1, channels: {} };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j && j.channels && typeof j.channels === 'object') return j;
  } catch (e) { /* 损坏则重建 */ }
  return { version: 1, channels: {} };
}

function saveChannels(dir, reg) {
  mkdirSync(join(dir, RELEASE_DIR), { recursive: true });
  writeFileSync(join(dir, CHANNELS_FILE), JSON.stringify(reg, null, 2) + '\n');
}

// 每次通道指针发布都留一份快照，软回滚时直接复制回去。
function snapshotPointer(dir, channel, version, pointer) {
  const rel = `${CHANNELS_DIR}/${channel}/${version}.yml`;
  mkdirSync(join(dir, CHANNELS_DIR, channel), { recursive: true });
  cpSync(join(dir, RELEASE_DIR, pointer), join(dir, rel));
  return rel;
}

function recordChannelPointer(dir, cfg, channel, version, pointer, snapshot) {
  const reg = loadChannels(dir);
  const slot = reg.channels[channel] || { current: null, previous: null };
  const prev = slot.current && slot.current.version !== version ? slot.current : slot.previous;
  reg.channels[channel] = {
    current: {
      version,
      bridgeVersion: BRIDGE_VERSION,
      contractVersion: cfg.contractVersion || CONTRACT_VERSION,
      rollout: ROLLOUT_DEFAULT,
      killSwitch: false,
      pointer,
      snapshot,
      at: new Date().toISOString(),
    },
    previous: prev || null,
  };
  saveChannels(dir, reg);
  return reg.channels[channel];
}

// 极简解析 generic 指针：只取 version 与 files 的 url / sha512 / size。
function parseLatestYml(text) {
  const files = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const u = line.match(/^  - url:\s*(.+)$/);
    if (u) { cur = { url: u[1].trim() }; files.push(cur); continue; }
    if (!cur) continue;
    const h = line.match(/^    sha512:\s*(.+)$/);
    if (h) cur.sha512 = h[1].trim();
    const s = line.match(/^    size:\s*(\d+)$/);
    if (s) cur.size = Number(s[1]);
  }
  return { version: (text.match(/^version:\s*(.+)$/m) || [])[1], files };
}

function projectVersion(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || '0.0.0'; } catch (e) { return '0.0.0'; }
}

function sha512b64(file) {
  return crypto.createHash('sha512').update(readFileSync(file)).digest('base64');
}

// 同一工程的多个 target 累积到一份清单：app 出 APK、pc 出安装包，互不覆盖。
function recordRelease(dir, target, artifacts, signed, signMode, note, extras = {}) {
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
  Object.assign(m, extras);
  const items = artifacts.filter((f) => existsSync(f)).map((f) => ({
    path: relative(dir, f).split(sep).join('/'),
    name: basename(f),
    size: statSync(f).size,
    sha256: sha256(f),
  }));
  m.targets[target] = {
    artifacts: items, signed, signMode,
    ...(extras.signature ? { signature: extras.signature } : {}),
    ...(note ? { note } : {}),
  };
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

// electron-builder 已生成当前通道指针则跳过（stable 与 beta 各自判断）；没有才按 generic 格式补一份。
function writeLatestYml(dir, version, opts = {}) {
  const channel = opts.channel || UPDATE_CHANNEL_DEFAULT;
  const out = join(dir, RELEASE_DIR);
  const name = pointerName(channel);
  if (existsSync(join(out, name)) && !opts.force) {
    const cur = (readFileSync(join(out, name), 'utf8').match(/^version:\s*(.+)$/m) || [])[1];
    if (cur === version) return { skipped: name };
  }
  const all = pcArtifacts(dir);
  const matched = all.filter((f) => basename(f).includes(version));
  const picks = matched.length ? matched : all;
  if (!picks.length) return null;
  mkdirSync(out, { recursive: true });
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
  const dir = projectDir(flags);
  const { cfg } = loadConfig(flags);
  const channel = channelArg(flags);
  const rollout = rolloutArg(flags.rollout);
  const kill = flags['kill-switch'];
  const killSwitch = kill === undefined ? null : !(String(kill) === 'false' || String(kill) === '0');

  if (flags.rollback) return publishRollback(dir, channel);
  if (!flags.file) {
    if (rollout === null && killSwitch === null) fail('缺少 --file <安装包路径>');
    const updated = updateChannelPublish(dir, cfg, channel, rollout, killSwitch);
    if (!updated) fail(`通道 ${channel} 尚未发布（先 uendos pack --target pc --channel ${channel}）`);
    const cur = updated.current;
    okMark(`通道 ${channel}：灰度 ${cur.rollout}%${cur.killSwitch ? ' · killSwitch 开' : ''}（${cur.pointer} · v${cur.version}）`);
    return;
  }

  const file = flags.file;
  if (!existsSync(file)) fail(`安装包不存在：${file}`);
  const manifestPath = resolve(flags.manifest || join(dir, 'btos-app-store/data/apps.json'));
  if (!existsSync(manifestPath)) fail(`找不到清单：${manifestPath}（用 --manifest 指定）`);

  const size = statSync(file).size;
  const sum = sha256(file);
  const name = basename(file);
  if (flags.verify) {
    const mp = resolve(flags['release-manifest'] || join(dir, RELEASE_MANIFEST));
    if (!existsSync(mp)) fail(`找不到发布清单：${mp}（先 uendos pack）`);
    let rel;
    try { rel = JSON.parse(readFileSync(mp, 'utf8')); } catch (e) { fail(`发布清单不是合法 JSON：${e.message}`); }
    const hits = Object.entries(rel.targets || {}).flatMap(([t, e]) => (e.artifacts || []).map((a) => ({ t, a, e })));
    const hit = hits.find(({ a }) => a.name === name);
    if (!hit) fail(`发布清单里没有 ${name}（重新 uendos pack 后再发布）`);
    if (hit.a.size !== size || hit.a.sha256 !== sum) {
      fail(`产物与发布清单不一致：清单 ${hit.a.size} B / ${hit.a.sha256.slice(0, 12)}…，实物 ${size} B / ${sum.slice(0, 12)}…`);
    }
    const sigState = hit.e.signature || rel.signature;
    if (!RELEASE_SIGNATURE_STATES.includes(sigState)) {
      fail(`发布清单缺少有效签名态（${sigState || '缺失'}）；用 v0.8+ 的 uendos pack 重新生成`);
    }
    if (rel.bridgeVersion !== BRIDGE_VERSION) {
      fail(`发布清单桥版本 ${rel.bridgeVersion || '缺失'} ≠ 当前 ${BRIDGE_VERSION}（重新 uendos pack）`);
    }
    if (rel.contractVersion !== (cfg.contractVersion || CONTRACT_VERSION)) {
      fail(`发布清单契约版本 ${rel.contractVersion || '缺失'} ≠ 当前 ${cfg.contractVersion || CONTRACT_VERSION}（重新 uendos pack）`);
    }
    if (sigState === 'signed') {
      const plugins = (cfg.plugins || []).length ? resolvePlugins(cfg, dir) : [];
      const audit = auditPlugins(plugins, dir, { allowUnsigned: false, requireSigned: true });
      if (audit.errors.length || audit.state !== 'signed') {
        fail(`发布清单标记 signed，但当前插件完整性未通过：${audit.errors.join('；') || audit.state}`);
      }
    }
    okMark(`已校验发布清单：${hit.t} · ${name}（${size} B · ${sigState}）`);
  }
  const version = flags.version || cfg.version || JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
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
  if (rollout !== null) item.rollout = rollout;
  manifest.generatedAt = new Date().toISOString();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  okMark(`已更新 ${itemId}：v${version} · ${status} · ${size} B · ${sum.slice(0, 12)}…`);
  log(`  url: ${url}`);

  const updated = updateChannelPublish(dir, cfg, channel, rollout, killSwitch);
  if (updated) {
    const cur = updated.current;
    okMark(`通道 ${channel}：灰度 ${cur.rollout}%${cur.killSwitch ? ' · killSwitch 开' : ''}（${cur.pointer} · v${cur.version}）`);
  }
}

// publish 只调通道的灰度 / killSwitch，不覆盖 pack 生成的指针。
function updateChannelPublish(dir, cfg, channel, rollout, killSwitch) {
  const pointer = pointerName(channel);
  const pointerPath = join(dir, RELEASE_DIR, pointer);
  const reg = loadChannels(dir);
  if (!reg.channels[channel] || !reg.channels[channel].current) {
    if (!existsSync(pointerPath)) return null;
    const y = parseLatestYml(readFileSync(pointerPath, 'utf8'));
    reg.channels[channel] = {
      current: {
        version: y.version,
        bridgeVersion: BRIDGE_VERSION,
        contractVersion: cfg.contractVersion || CONTRACT_VERSION,
        rollout: ROLLOUT_DEFAULT,
        killSwitch: false,
        pointer,
        snapshot: null,
        at: new Date().toISOString(),
      },
      previous: null,
    };
  }
  const cur = reg.channels[channel].current;
  if (rollout !== null) cur.rollout = rollout;
  if (killSwitch !== null) cur.killSwitch = killSwitch;
  cur.at = new Date().toISOString();
  saveChannels(dir, reg);
  return reg.channels[channel];
}

// 软回滚：有上一版本快照就换回指针；否则把当前版本灰度置 0 并开 killSwitch。
function publishRollback(dir, channel) {
  const reg = loadChannels(dir);
  const slot = reg.channels[channel];
  if (!slot || !slot.current) fail(`通道 ${channel} 没有发布记录，无法回滚`);
  const cur = slot.current;
  const prev = slot.previous;
  if (prev && prev.snapshot && existsSync(join(dir, prev.snapshot))) {
    const pointer = prev.pointer || pointerName(channel);
    mkdirSync(join(dir, RELEASE_DIR), { recursive: true });
    cpSync(join(dir, prev.snapshot), join(dir, RELEASE_DIR, pointer));
    reg.channels[channel] = { current: { ...prev, at: new Date().toISOString() }, previous: null };
    saveChannels(dir, reg);
    okMark(`已回滚通道 ${channel}：${cur.version} → ${prev.version}（${RELEASE_DIR}/${pointer}）`);
    log('  新客户端将收到上一版本；已安装旧版本的客户端行为不变（不做二进制降级）。');
    return;
  }
  cur.rollout = 0;
  cur.killSwitch = true;
  cur.at = new Date().toISOString();
  saveChannels(dir, reg);
  okMark(`已软回滚通道 ${channel}：${cur.version} 灰度置 0 且 killSwitch=true（不做二进制降级）`);
  log('  无可回退版本快照；新客户端不再收到该版本。');
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
  syncProject(cfg, dir, { allowUnsigned: !!flags['allow-unsigned'] });
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
  if (!name) fail('用法：uendos plugin init <包名> [--kind method|iot] [--transport ble|serial|mqtt|nfc] [--capability <能力>] [--dir <路径>]');
  const version = flags.version ? String(flags.version) : '0.1.0';
  const short = pluginShortName(name);
  const kind = flags.kind ? String(flags.kind) : 'method';
  if (!['method', 'iot'].includes(kind)) fail(`--kind 只能是 method 或 iot（当前：${kind}）`);
  const IOT_TRANSPORTS = ['ble', 'serial', 'mqtt', 'nfc'];
  let transport = null;
  if (kind === 'iot') {
    transport = flags.transport ? String(flags.transport) : (IOT_TRANSPORTS.includes(short) ? short : 'ble');
    if (!IOT_TRANSPORTS.includes(transport)) fail(`--transport 只能是 ${IOT_TRANSPORTS.join(' / ')}（当前：${transport}）`);
  }
  const cap = kind === 'iot' ? `iot.${transport}` : (flags.capability ? String(flags.capability) : deriveCapability(short));
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
    methods: kind === 'iot' ? [`${cap}.probe`] : [`${cap}.ping`, `${cap}.status`],
  };
  const v = validatePluginManifest(manifest, { name });
  if (!v.ok) fail(`插件声明不合法：${v.errors.join('；')}`);
  if (existsSync(outDir) && !flags.force) fail(`目录已存在：${outDir}（加 --force 覆盖）`);

  const runtime = kind === 'iot' ? `// ${name} · IoT 适配器骨架：由 uendos sync 包进函数作用域注入品牌桥。
// 适配器只在构建期注册；禁止运行时远程加载。设备令牌/鉴权归云根，壳内不落凭证。
// 真机接入时替换 detect/devices/read/write 为原生插件调用；ingestUrl 用于离线补传。
ShellCore.registerIotAdapter({
  id: '${name}',
  transport: '${transport}',
  detect: function () { return true; },
  devices: function () {
    return [{ id: 'demo-${transport}', kind: 'sensor', status: 'online', capabilities: ['demo'] }];
  },
  read: function (deviceId, metric) {
    if (deviceId !== 'demo-${transport}') return null;
    return { value: 42, unit: 'demo', quality: 'good' };
  },
  write: function (deviceId, action, params, ack) {
    if (deviceId !== 'demo-${transport}') return { accepted: false };
    setTimeout(function () { ack({ ok: true, data: { action: action } }); }, 0);
    return { accepted: true };
  },
  // ingestUrl: 'https://cloud.example.com/iot/ingest',
});
return {
  version: '${version}',
  capabilities: { '${cap}': '\u2713' },
  methods: {
    '${cap}.probe': function () {
      return { ok: true, data: { devices: ['demo-${transport}'] } };
    },
  },
};
` : `// ${name} 插件运行时：由 uendos sync 包进函数作用域注入品牌桥（顶层 return 合法）。
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
  const asserts = kind === 'iot' ? `/**
 * ${name} · IoT 适配器断言：uendos conformance 会合并到内置断言之后。
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
    name: 'IoT 能力 ${cap} 已点亮',
    run: (Shell) => {
      if (Shell.capabilities.iot !== '\u2713') throw new Error('iot=' + Shell.capabilities.iot);
      if (Shell.capabilities['${cap}'] !== '\u2713') throw new Error('${cap}=' + Shell.capabilities['${cap}']);
    },
  },
  {
    name: 'iot.devices 返回演示设备',
    run: async (Shell) => {
      const r = await Shell.call('iot.devices');
      if (!r || !r.ok) throw new Error(JSON.stringify(r));
      const d = (r.data.devices || []).find((x) => x.id === 'demo-${transport}');
      if (!d) throw new Error('未返回 demo-${transport}');
    },
  },
  {
    name: 'iot.read 返回读数',
    run: async (Shell) => {
      const r = await Shell.call('iot.read', { deviceId: 'demo-${transport}', metric: 'demo' });
      if (!r || !r.ok || typeof r.data.value === 'undefined') throw new Error(JSON.stringify(r));
    },
  },
  {
    name: 'iot.write 强制幂等键，返回 accepted + ackId，并回传 ack',
    run: async (Shell) => {
      const bad = await Shell.call('iot.write', { deviceId: 'demo-${transport}', action: 'demo' });
      if (bad.ok || bad.code !== 'E_BAD_ARGS') throw new Error('缺 idem 未拦截：' + JSON.stringify(bad));
      let off = null;
      const ack = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('未收到 shell:iot-ack')), 1000);
        off = Shell.on('shell:iot-ack', (e) => { clearTimeout(timer); off && off(); resolve(e.data); });
        Shell.call('iot.write', { deviceId: 'demo-${transport}', action: 'demo', idem: 'conformance-iot' })
          .then((r) => { if (!r || !r.ok || r.data.accepted !== true || !r.data.ackId) reject(new Error(JSON.stringify(r))); })
          .catch(reject);
      });
      if (!ack || ack.ok !== true) throw new Error('ack=' + JSON.stringify(ack));
    },
  },
];
` : `/**
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
  log(kind === 'iot'
    ? `  能力 ${cap} · 适配器 transport=${transport} · 方法 ${cap}.probe · 环境 ${env.join('/')}`
    : `  能力 ${cap} · 方法 ${cap}.ping / ${cap}.status · 环境 ${env.join('/')}`);
  const rel = outDir.startsWith(`${dir}/`) ? `./${outDir.slice(dir.length + 1)}` : outDir;
  log('下一步：');
  log(`  npm install ${rel} --save-exact`);
  log(`  uendos plugin add ${name}`);
  log('  uendos doctor && uendos conformance');
}

function pluginHelp() {
  log(`uendos plugin — 插件管理（构建期注册，运行时禁止远程加载）

  uendos plugin list [--json]        列出配置中的插件、安装状态、环境、断言与锁
  uendos plugin init <包名>          生成插件脚手架（--kind method|iot、--transport、--capability/--env/--dir/--version）
  uendos plugin add <包名>           把已安装的插件写入配置并重新生成品牌桥
  uendos plugin remove <包名>        从配置移除插件并重新生成品牌桥
  uendos plugin update [<包名>...]   构建期升级（默认 @latest），--spec 指定版本或 tarball
  uendos plugin keygen --id <id>    生成 Ed25519 密钥对，公钥写入 ${TRUSTED_FILE}
  uendos plugin sign <包名> --key <私钥> --id <keyId>
                                    为已安装插件写 ${PLUGIN_SIG_FILE}（manifest + runtime 双哈希）
  uendos plugin verify [<包名>]     离线验签：签名有效 / 未签名 / 内容被改动

  插件包根目录需提供 uendos.plugin.json（id / version / runtime / asserts / env / capabilities / methods / requires）。
  uendos sync 会生成 ${LOCK_NAME}（版本 + 运行时/manifest 哈希 + 签名者），sync --check 与 doctor 据此拦截漂移。
  未签名插件默认拒绝：开发期用 --allow-unsigned，或在配置里设 security.plugins.requireSigned=false。`);
}

function cmdPluginKeygen(flags) {
  const dir = projectDir(flags);
  const id = flags.id && flags.id !== true ? String(flags.id) : '';
  if (!id) fail('用法：uendos plugin keygen --id <keyId> [--out <私钥目录>] [--force]');
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(id)) fail('keyId 只允许字母、数字与 ._-（≤32）');
  const outDir = resolve(flags.out && flags.out !== true ? String(flags.out) : join(dir, '.uendos-keys'));
  const privPath = join(outDir, `${id}.private.pem`);
  const pubPath = join(outDir, `${id}.public.pem`);
  if (existsSync(privPath) && !flags.force) fail(`私钥已存在：${privPath}（--force 覆盖）`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(privPath, privPem, { mode: 0o600 });
  writeFileSync(pubPath, pubPem);

  const tp = join(dir, TRUSTED_FILE);
  let trusted = { version: 1, keys: [] };
  if (existsSync(tp)) {
    try { trusted = JSON.parse(readFileSync(tp, 'utf8')); } catch (e) { fail(`${TRUSTED_FILE} 不是合法 JSON：${e.message}`); }
    if (!Array.isArray(trusted.keys)) trusted.keys = [];
  }
  const idx = trusted.keys.findIndex((k) => k && k.id === id);
  if (idx >= 0 && !flags.force) fail(`信任链已存在 ${id}（--force 轮换）`);
  const entry = { id, alg: PLUGIN_SIG_ALG, publicKey: pubPem };
  if (idx >= 0) trusted.keys[idx] = entry; else trusted.keys.push(entry);
  trusted.version = trusted.version || 1;
  writeFileSync(tp, JSON.stringify(trusted, null, 2) + '\n');
  okMark(`已生成 Ed25519 密钥对：${pubPath}`);
  log(`  公钥已写入 ${TRUSTED_FILE}（keyId ${id}），该文件可入库`);
  log(`  私钥：${privPath}（权限 600，请勿提交或入库）`);
  log('  下一步：uendos plugin sign <包名> --key <私钥> --id ' + id);
}

function cmdPluginSign(name, flags) {
  if (!name) fail('用法：uendos plugin sign <包名> --key <私钥 PEM> --id <keyId>');
  const dir = projectDir(flags);
  const keyId = flags.id && flags.id !== true ? String(flags.id) : '';
  const keyPath = flags.key && flags.key !== true ? resolve(String(flags.key)) : '';
  if (!keyId) fail('缺少 --id <keyId>（需与 ' + TRUSTED_FILE + ' 对应）');
  if (!keyPath) fail('缺少 --key <ed25519 私钥 PEM>（用 uendos plugin keygen 生成）');
  if (!existsSync(keyPath)) fail(`私钥不存在：${keyPath}`);
  const trusted = readTrusted(dir);
  if (!trusted || !trusted.keys.some((k) => k && k.id === keyId)) {
    fail(`信任链缺少公钥 ${keyId}（先 uendos plugin keygen --id ${keyId}）`);
  }
  const pdir = locatePlugin(dir, name);
  const manifestText = readFileSync(join(pdir, 'uendos.plugin.json'), 'utf8');
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch (e) { fail(`uendos.plugin.json 不是合法 JSON：${e.message}`); }
  const runtimeText = readFileSync(join(pdir, manifest.runtime), 'utf8');
  const manifestHash = runtimeIntegrity(manifestText);
  const runtimeHash = runtimeIntegrity(runtimeText);
  let key;
  try { key = crypto.createPrivateKey(readFileSync(keyPath)); } catch (e) { fail(`私钥无法读取：${e.message}`); }
  if (key.asymmetricKeyType !== 'ed25519') fail('--key 必须是 Ed25519 私钥（PKCS#8 PEM）');
  const sig = crypto.sign(null, Buffer.from(signaturePayload(name, manifest.version, manifestHash, runtimeHash)), key).toString('base64');
  writeFileSync(join(pdir, PLUGIN_SIG_FILE), JSON.stringify({
    v: PLUGIN_SIG_VERSION, alg: PLUGIN_SIG_ALG, keyId, id: name, version: manifest.version,
    manifest: manifestHash, runtime: runtimeHash, sig, signedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  okMark(`已签名 ${name}@${manifest.version}（${keyId}）`);
  log(`  签名文件：${relative(dir, join(pdir, PLUGIN_SIG_FILE))}`);
  log('  签名只覆盖当前内容：改动 runtime/manifest 后必须重签，再 uendos sync');
}

function cmdPluginVerify(name, flags) {
  const { cfg } = loadConfig(flags);
  const dir = projectDir(flags);
  const ids = name ? [name] : (cfg.plugins || []);
  if (!ids.length) { okMark('没有需要验签的插件'); return; }
  const plugins = resolvePlugins({ ...cfg, plugins: ids }, dir);
  const audit = auditPlugins(plugins, dir, { allowUnsigned: false, requireSigned: false });
  for (const p of plugins) {
    const r = audit.results.get(p.id);
    if (r.state === 'signed') okMark(`${p.id}@${p.version} 验签通过（${r.signer}）`);
    else if (r.state === 'unsigned') log(`! ${p.id}@${p.version} 未签名（${PLUGIN_SIG_FILE} 不存在）`);
    else log(`✗ ${p.id}@${p.version} ${r.issues.join('；')}`);
  }
  if (audit.state === 'invalid') fail('插件验签失败：签名无效或内容被改动');
  log(`信任链：${audit.trusted || '未找到 ' + TRUSTED_FILE}`);
}

function cmdPluginList(flags) {
  const { cfg } = loadConfig(flags);
  const dir = projectDir(flags);
  const names = cfg.plugins || [];
  if (!names.length) {
    log('· 配置里没有插件（uendos plugin add <包名>）');
    return;
  }
  const trusted = readTrusted(dir);
  const rows = names.map((id) => {
    const m = installedManifest(dir, id);
    if (!m) return { id, installed: false, requires: [], locked: false };
    const pdir = join(dir, 'node_modules', ...id.split('/'));
    const asserts = m.asserts || null;
    const assertsExists = !!asserts && existsSync(join(pdir, asserts));
    const lock = readLock(dir);
    const entry = lock && lock.plugins[id];
    const rtPath = join(pdir, m.runtime);
    const rt = existsSync(rtPath) ? readFileSync(rtPath, 'utf8') : '';
    const manifestText = readFileSync(join(pdir, 'uendos.plugin.json'), 'utf8');
    const sig = verifyPluginSignature({ id, dir: pdir, version: m.version, manifestText, runtime: rt }, trusted);
    return {
      id,
      installed: true,
      version: m.version,
      env: m.env || [],
      capabilities: m.capabilities || [],
      requires: m.requires || [],
      asserts,
      assertsExists,
      signature: sig.state,
      signer: sig.signer,
      locked: !!entry && entry.version === m.version && entry.integrity === runtimeIntegrity(rt)
        && (entry.manifest === undefined || entry.manifest === runtimeIntegrity(manifestText)),
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
    const sig = r.signature === 'signed' ? `  签名 ✓ ${r.signer}` : r.signature === 'unsigned' ? '  签名 ! 未签名' : '  签名 ✗';
    log(`✓ ${r.id}@${r.version}  环境 ${env}  能力 ${r.capabilities.join('/')}  断言 ${asserts}${deps}${lock}${sig}`);
  }
}

function cmdPlugin(pos, flags) {
  const sub = pos[0];
  if (!sub) return pluginHelp();
  if (sub === 'list') return cmdPluginList(flags);
  if (sub === 'init') return cmdPluginInit(pos[1], flags, projectDir(flags));
  if (sub === 'keygen') return cmdPluginKeygen(flags);
  if (sub === 'sign') return cmdPluginSign(pos[1], flags);
  if (sub === 'verify') return cmdPluginVerify(pos[1], flags);
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
    const candidate = resolvePlugins(next, dir); // 先确认已安装且声明合法，再落配置
    const audit = auditPlugins(candidate, dir, { allowUnsigned: !!flags['allow-unsigned'], requireSigned: pluginsRequireSigned(next) });
    if (audit.errors.length) fail(`插件完整性校验失败：${audit.errors.join('；')}`);
    cfg.plugins = next.plugins;
    saveConfig(path, cfg);
    syncProject(cfg, dir, { allowUnsigned: !!flags['allow-unsigned'] });
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
    syncProject(cfg, dir, { allowUnsigned: !!flags['allow-unsigned'] });
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
  uendos doctor [--offline] [--release-check] [--integrity] [--channel stable|beta]
                                 配置 / 产物 / 端地址 / 模板体检（--release-check 校验发布清单与更新源；
                                 --integrity 同时校验插件验签、清单签名态与版本；
                                 --channel 按通道校验指针版本、产物哈希与桥/契约版本）
  uendos conformance [--json]    跑契约断言（内置 55 项 + 插件断言，能力被裁剪时跳过）
  uendos assets [--force]        按品牌色生成 assets/icon.png 与 splash.png
  uendos profile [--json]        查看 lite / standard / pro 三档默认 target 与能力集
  uendos plugin list [--json]    列出配置中的插件、安装状态、环境与断言
  uendos plugin init <包名>      生成插件包脚手架（manifest / runtime / 断言）
  uendos plugin add <包名>       把已安装的插件写入配置并重新生成品牌桥
  uendos plugin remove <包名>    从配置移除插件并重新生成品牌桥
  uendos plugin update [<包名>...] [--spec <npm spec>]
                                 构建期升级插件（默认 npm <包名>@latest），重新校验并 sync
  uendos plugin keygen --id <id> 生成 Ed25519 密钥对（公钥写 uendos.trusted.json）
  uendos plugin sign <包名> --key <私钥> --id <keyId>
                                 为插件写 uendos.plugin.sig（manifest + runtime 双哈希）
  uendos plugin verify [<包名>]  离线验签（签名有效 / 未签名 / 内容被改动）
  uendos pack --target <app|ios|pc|mp> [--release] [--channel stable|beta]
                                 出包并写 release/MANIFEST.json（PC 同时写通道指针与 release/channels.json）
  uendos publish --file <包> --item <apps.json 条目> --manifest <清单> --url <下载地址> [--status beta] [--verify]
                 [--channel stable|beta] [--rollout 0-100] [--kill-switch]
                                 --verify 要求产物与 release/MANIFEST.json 的大小/哈希一致；
                                 只调通道灰度时可省略 --file/--item/--manifest
  uendos publish --rollback [--channel stable|beta]
                                 退回通道指针到上一版本；无快照时把当前版本灰度置 0（不做二进制降级）

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
      const out = syncProject(cfg, projectDir(flags), { check: !!flags.check, allowUnsigned: !!flags['allow-unsigned'] });
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
