#!/usr/bin/env node
// 知味生态 App 投影器：一份 ecosystem.json → 多个独立 UendOS 壳工程。
// 用法：
//   node sdk/scripts/ziway-ecosystem.mjs scaffold [--manifest apps/ziway/ecosystem.json]
//   node sdk/scripts/ziway-ecosystem.mjs scaffold --resync     # 已有工程按清单重新投影
//   node sdk/scripts/ziway-ecosystem.mjs check                   # 校验产物与清单一致
// 设计约束：业务 H5 不动，只生成壳；一个 app 一个 packageId，端内不再有身份选择页。
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CAPABILITIES, PROFILES } from '../packages/contract/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(here, '..');
const repoRoot = resolve(sdkRoot, '..');
const CLI = join(sdkRoot, 'packages', 'cli', 'bin', 'uendos.mjs');
const DEFAULT_MANIFEST = join(repoRoot, 'apps', 'ziway', 'ecosystem.json');
const CONFIG_NAME = 'uendos.config.json';
const LOCK_NAME = 'ecosystem.lock.json';

function fail(msg) {
  console.error(`[ziway-ecosystem] ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[ziway-ecosystem] ${msg}`);
}

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (key === 'resync' || key === 'check') { flags[key] = true; continue; }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) fail(`--${key} 缺少参数`);
    flags[key] = next;
    i++;
  }
  return { pos, flags };
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`读取 ${path} 失败：${e.message}`);
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function projectPrefix(app, suffix) {
  return `ziway-${app.code}${suffix}`;
}

function downloadDirFor(app, proj) {
  if (proj.suffix === '-pc') return app.store?.pcDownloadDir || app.store?.downloadDir || '';
  return app.store?.downloadDir || '';
}

// app+pc 共用同一目录会互相覆盖 package.json（app 模板与 pc 模板同名），
// 因此拆成两个工程：<code>（移动/小程序）与 <code>-pc（桌面）。
function splitProjects(app) {
  const targets = app.targets || [];
  if (!targets.includes('pc') || targets.length === 1) {
    return [{ suffix: '', targets }];
  }
  return [
    { suffix: '', targets: targets.filter((t) => t !== 'pc') },
    { suffix: '-pc', targets: ['pc'] },
  ];
}

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) fail('ecosystem.json 的 schemaVersion 必须为 1');
  let hub;
  try { hub = new URL(manifest.hub?.url || ''); } catch (e) { hub = null; }
  if (!hub || !hub.href.startsWith('https://')) fail('hub.url 必须是 https 绝对地址');
  if (!Array.isArray(manifest.apps) || !manifest.apps.length) fail('apps 至少要有 1 个端');

  const seen = new Set();
  for (const app of manifest.apps) {
    if (typeof app.code !== 'string' || !/^[a-z]{2,4}$/.test(app.code)) {
      fail(`端 code 不合法：${app.code}（2–4 位小写字母）`);
    }
    if (seen.has(app.code)) fail(`端 code 重复：${app.code}`);
    seen.add(app.code);
    if (typeof app.name !== 'string' || !app.name.trim()) fail(`端 ${app.code} 缺少 name`);

    let url;
    try { url = new URL(app.url || ''); } catch (e) { url = null; }
    if (!url || !url.href.startsWith('https://')) fail(`端 ${app.code} 的 url 必须是 https 绝对地址`);

    const profile = PROFILES[app.profile];
    if (!profile) fail(`端 ${app.code} 的 profile 未知：${app.profile}`);
    for (const t of app.targets || []) {
      if (!['app', 'pc', 'mp'].includes(t)) fail(`端 ${app.code} 的 target 未知：${t}`);
      if (!profile.allowedTargets.includes(t)) {
        fail(`端 ${app.code} 的 profile=${app.profile} 不允许 target=${t}`);
      }
    }
    if (typeof app.packageId !== 'string' || !app.packageId.trim()) fail(`端 ${app.code} 缺少 packageId`);
    if (!Array.isArray(app.capsAllow)) fail(`端 ${app.code} 的 capsAllow 必须是数组`);
    const known = new Set(profile.capabilities);
    for (const cap of app.capsAllow) {
      if (!CAPABILITIES.includes(cap)) fail(`端 ${app.code} 的能力不存在：${cap}`);
      if (!known.has(cap)) fail(`端 ${app.code} 的 profile=${app.profile} 不含能力：${cap}`);
    }
    if (app.plugins !== undefined && !Array.isArray(app.plugins)) fail(`端 ${app.code} 的 plugins 必须是数组`);
  }
}

function runCli(args) {
  execFileSync(process.execPath, [CLI, ...args], { stdio: 'inherit' });
}

function expectedProjects(manifest) {
  const list = [];
  for (const app of manifest.apps) {
    for (const proj of splitProjects(app)) {
      list.push({ app, proj, key: `${app.code}${proj.suffix}`, prefix: projectPrefix(app, proj.suffix) });
    }
  }
  return list;
}

function initProject(manifest, app, proj, dir) {
  const targets = proj.targets;
  if (!targets.length) fail(`端 ${app.code}${proj.suffix} 拆分后没有 target`);
  const args = [
    'init', projectPrefix(app, ''),
    '--brand', manifest.brand || 'ziway',
    '--ends', `${app.code}:${app.name}:${app.url}`,
    '--targets', targets.join(','),
    '--profile', app.profile,
    '--app-id', app.packageId,
    '--display', app.name,
    '--accent', app.accent || manifest.accent,
    '--launch-mode', 'portal',
    '--dir', dir,
  ];
  if (app.mpAppId) args.push('--mp-appid', app.mpAppId);
  runCli(args);
}

function patchProject(manifest, app, proj, dir) {
  const cfgPath = join(dir, CONFIG_NAME);
  const cfg = loadJson(cfgPath);
  const prefix = projectPrefix(app, proj.suffix);
  const accent = app.accent || manifest.accent;
  cfg.prefix = prefix;
  cfg.endKey = `${prefix}.end`;
  cfg.displayName = app.name;
  cfg.accent = accent;
  cfg.theme = { mode: app.themeMode || 'light', tokens: { accent } };
  cfg.caps = { allow: [...app.capsAllow] };
  if (app.plugins?.length) cfg.plugins = [...app.plugins];
  else delete cfg.plugins;
  cfg.store = { downloadDir: downloadDirFor(app, proj) };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

  // init 先按 brand 生成 ziwayos-shell.js；prefix 改后 sync 会写新文件，清掉旧产物避免误引用。
  for (const p of [
    join(dir, 'shell', 'ziway-shell.js'),
    join(dir, 'shell', 'ziwayos-shell.js'),
    join(dir, 'dist', 'ziway-shell.js'),
    join(dir, 'dist', 'ziwayos-shell.js'),
  ]) {
    if (existsSync(p)) rmSync(p);
  }

  const capPath = join(dir, 'capacitor.config.json');
  if (existsSync(capPath)) {
    const cap = loadJson(capPath);
    const ownHost = new URL(app.url).host;
    const hubHost = new URL(manifest.hub.url).host;
    const allow = [...new Set([ownHost, hubHost, ...(manifest.hub.ssoHosts || [])])];
    cap.appId = app.packageId;
    cap.appName = app.name;
    cap.server = cap.server || {};
    cap.server.url = app.url;
    cap.server.allowNavigation = allow;
    cap.server.cleartext = false;
    writeFileSync(capPath, JSON.stringify(cap, null, 2) + '\n');
  }

  // 每个 PC App 的更新源独立，不能共用 download/latest/；
  // App 工程的 assets 脚本也要跟随本端 accent，避免 npm run assets 把图标刷回统一色。
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = loadJson(pkgPath);
    if (pkg.scripts?.assets) {
      pkg.scripts.assets = `capacitor-assets generate --iconBackgroundColor '${accent}' --iconBackgroundColorDark '#0B1220' --splashBackgroundColor '${accent}' --splashBackgroundColorDark '#0B1220'`;
    }
    if (proj.targets.includes('pc')) {
      pkg.build = pkg.build || {};
      pkg.build.publish = [{ provider: 'generic', url: `https://cajob.cewaysoft.com${downloadDirFor(app, proj)}` }];
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }

  const shellName = `${projectPrefix(app, proj.suffix)}-shell.js`;
  const prepPath = join(dir, 'scripts/prepare-web.sh');
  if (existsSync(prepPath)) {
    const script = readFileSync(prepPath, 'utf8')
      .replaceAll('ziwayos-shell.js', shellName)
      .replaceAll('ziway-shell.js', shellName);
    writeFileSync(prepPath, script);
  }

  runCli(['sync', '--dir', dir]);
}

function buildLock(manifestPath, projects) {
  const lock = {
    schemaVersion: 1,
    manifestSha256: sha256(manifestPath),
    projects: {},
  };
  for (const p of projects) {
    const cfgPath = join(p.dir, CONFIG_NAME);
    lock.projects[p.key] = {
      app: p.app.code,
      dir: relative(repoRoot, p.dir),
      packageId: p.app.packageId,
      targets: p.proj.targets,
      configSha256: sha256(cfgPath),
      shell: `shell/${p.prefix}-shell.js`,
    };
  }
  return lock;
}

function writeLock(lockPath, lock) {
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

function checkLock(manifest, manifestPath, lockPath, projects) {
  if (!existsSync(lockPath)) fail(`缺少 ${lockPath}，先运行 scaffold`);
  const lock = loadJson(lockPath);
  if (lock.manifestSha256 !== sha256(manifestPath)) fail('ecosystem.json 已变更，先运行 scaffold --resync');

  const errors = [];
  for (const p of projects) {
    const entry = lock.projects[p.key];
    if (!entry) { errors.push(`${p.key}: lock 中缺少该工程`); continue; }
    const cfgPath = join(p.dir, CONFIG_NAME);
    if (!existsSync(cfgPath)) { errors.push(`${p.key}: 缺少 ${CONFIG_NAME}`); continue; }
    if (entry.configSha256 !== sha256(cfgPath)) errors.push(`${p.key}: 配置与 lock 不一致，运行 scaffold --resync`);
    const shell = join(p.dir, 'shell', `${p.prefix}-shell.js`);
    if (!existsSync(shell)) errors.push(`${p.key}: 缺少品牌桥 ${relative(repoRoot, shell)}`);
    const cfg = loadJson(cfgPath);
    if (cfg.packageId !== p.app.packageId) errors.push(`${p.key}: packageId 应为 ${p.app.packageId}`);
    if (cfg.prefix !== p.prefix) errors.push(`${p.key}: prefix 应为 ${p.prefix}`);
    if (cfg.endKey !== `${p.prefix}.end`) errors.push(`${p.key}: endKey 应为 ${p.prefix}.end`);
    if (JSON.stringify(cfg.targets) !== JSON.stringify(p.proj.targets)) errors.push(`${p.key}: targets 应为 ${p.proj.targets.join(',')}`);
    if (JSON.stringify(cfg.caps?.allow) !== JSON.stringify(p.app.capsAllow)) errors.push(`${p.key}: caps.allow 与清单不一致`);
    if (!cfg.ends?.[p.app.code] || cfg.ends[p.app.code].url !== p.app.url) errors.push(`${p.key}: 单端 ${p.app.code} 缺失或 URL 不一致`);
  }
  for (const key of Object.keys(lock.projects)) {
    if (!projects.some((p) => p.key === key)) errors.push(`${key}: lock 中有清单外的工程`);
  }
  if (errors.length) fail(`校验失败：\n  - ${errors.join('\n  - ')}`);
  ok(`校验通过：${projects.map((p) => p.key).join(' / ')}`);
}

function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0] || 'scaffold';
  if (cmd === 'help' || flags.help) {
    console.log('用法：node sdk/scripts/ziway-ecosystem.mjs scaffold|check [--manifest <path>] [--out <dir>] [--only <code,code>] [--resync]');
    return;
  }
  const manifestPath = resolve(flags.manifest || DEFAULT_MANIFEST);
  if (!existsSync(manifestPath)) fail(`找不到清单：${manifestPath}`);
  const manifest = loadJson(manifestPath);
  validateManifest(manifest);
  const outDir = resolve(flags.out || dirname(manifestPath));

  let projects = expectedProjects(manifest);
  if (flags.only) {
    const only = String(flags.only).split(',').map((s) => s.trim()).filter(Boolean);
    projects = projects.filter((p) => only.includes(p.key) || only.includes(p.app.code));
    if (!projects.length) fail(`--only 没有匹配到工程：${flags.only}`);
  }

  for (const p of projects) p.dir = join(outDir, p.key);

  if (cmd === 'check') {
    checkLock(manifest, manifestPath, join(outDir, LOCK_NAME), projects);
    return;
  }
  if (cmd !== 'scaffold') fail(`未知命令：${cmd}（scaffold / check）`);

  for (const p of projects) {
    const dir = p.dir;
    const cfgPath = join(dir, CONFIG_NAME);
    if (existsSync(cfgPath) && !flags.resync) {
      ok(`${p.key} 已存在，跳过（需要更新用 --resync）`);
      continue;
    }
    if (!existsSync(cfgPath)) {
      initProject(manifest, p.app, p.proj, dir);
    }
    patchProject(manifest, p.app, p.proj, dir);
    ok(`${p.key} 已投影：${relative(repoRoot, dir)}（${p.proj.targets.join('/')}，${p.app.packageId}）`);
  }

  const lockPath = join(outDir, LOCK_NAME);
  if (projects.length === expectedProjects(manifest).length) {
    writeLock(lockPath, buildLock(manifestPath, projects));
    ok(`lock 已写入：${relative(repoRoot, lockPath)}`);
  } else {
    ok('子集模式：本次未改写 ecosystem.lock.json（完整投影请去掉 --only）');
  }
  console.log(`
下一步（在每个工程内）：
  npm install
  npx uendos doctor --offline
  npx uendos pack --target app --channel beta
`);
}

main();
