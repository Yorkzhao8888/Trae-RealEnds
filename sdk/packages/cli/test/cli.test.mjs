import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, cpSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/uendos.mjs', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'uendos-cli-'));

test.after(() => rmSync(DIR, { recursive: true, force: true }));

function run(args, opts = {}) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: DIR,
    encoding: 'utf8',
    timeout: 120000,
    ...opts,
  });
}

const readCfg = () => JSON.parse(readFileSync(join(DIR, 'uendos.config.json'), 'utf8'));

test('init 生成配置、品牌桥与三套模板', () => {
  run([
    'init', 'demo-acme',
    '--brand', 'demo-acme',
    '--ends', 'hp:个人端:https://hp.acme.example.com/，ep:企业端:https://ep.acme.example.com/',
    '--targets', 'app,pc,mp',
    '--app-id', 'com.acme.demo',
    '--accent', '#123456',
    '--dir', DIR,
  ]);

  const cfg = readCfg();
  assert.equal(cfg.brand, 'demo-acme');
  assert.equal(cfg.alias, 'demoAcmeOS', '带连字符的品牌名要生成合法别名');
  assert.equal(cfg.packageId, 'com.acme.demo');
  assert.deepEqual(cfg.targets, ['app', 'pc', 'mp']);
  assert.deepEqual(Object.keys(cfg.ends).sort(), ['ep', 'hp']);
  assert.equal(cfg.launchMode, 'portal');
  assert.match(cfg.contractVersion, /^0\.4\./);

  const cap = JSON.parse(readFileSync(join(DIR, 'capacitor.config.json'), 'utf8'));
  assert.equal(cap.server.url, 'https://hp.acme.example.com/');
  assert.deepEqual(cap.server.allowNavigation, ['hp.acme.example.com', 'ep.acme.example.com']);
  assert.ok(!cap.server.allowNavigation.includes(undefined), 'allowNavigation 不能出现空值');

  const icon = readFileSync(join(DIR, 'assets', 'icon.png'));
  assert.equal(icon.readUInt32BE(0), 0x89504e47, 'icon.png 不是合法 PNG');
  assert.equal(icon.readUInt32BE(16), 1024, 'icon.png 宽度应为 1024');
  assert.equal(icon.readUInt32BE(20), 1024, 'icon.png 高度应为 1024');

  const shellFile = join(DIR, 'shell', 'demo-acme-shell.js');
  assert.ok(existsSync(shellFile), '品牌桥未生成');
  const bridge = readFileSync(shellFile, 'utf8');
  assert.ok(bridge.includes('ShellCore.create('));
  assert.ok(!bridge.includes('{{'), '模板占位符未替换');

  for (const f of ['capacitor.config.json', 'main.js', 'preload.js', 'project.config.json']) {
    assert.ok(existsSync(join(DIR, f)), `缺少模板文件 ${f}`);
  }

  const rt = JSON.parse(readFileSync(join(DIR, 'uendos.runtime.json'), 'utf8'));
  assert.equal(rt.brand, 'demo-acme');
  assert.equal(rt.accent, '#123456');
  assert.equal(rt.primaryEnd, 'hp');
  assert.equal(rt.shellFile, 'demo-acme-shell.js');
});

test('profile=lite：默认只出 App、portal 启动，档位信息可查询', () => {
  const dir = join(DIR, 'lite-demo');
  run([
    'init', 'lite-demo',
    '--brand', 'lite-demo',
    '--ends', 'hp:个人端:https://hp.acme.example.com/',
    '--profile', 'lite',
    '--dir', dir,
  ]);

  const cfg = JSON.parse(readFileSync(join(dir, 'uendos.config.json'), 'utf8'));
  assert.equal(cfg.profile, 'lite');
  assert.deepEqual(cfg.targets, ['app']);
  assert.equal(cfg.launchMode, 'portal');
  assert.ok(!existsSync(join(dir, 'main.js')), 'lite 不应生成 PC 模板');

  const out = JSON.parse(run(['profile', '--json']));
  assert.deepEqual(Object.keys(out).sort(), ['lite', 'pro', 'standard']);
  assert.equal(out.lite.capabilities.length, 9);
  assert.equal(out.pro.capabilities.length, 18);
});

test('launcher 模式：不固定主端 URL，选择页可记住所选端', () => {
  const dir = join(DIR, 'launcher-demo');
  run([
    'init', 'launcher-demo',
    '--brand', 'launcher-demo',
    '--ends', 'hp:个人端:https://hp.acme.example.com/，ep:企业端:https://ep.acme.example.com/',
    '--targets', 'app',
    '--dir', dir,
    '--launch-mode', 'launcher',
  ]);

  const cfg = JSON.parse(readFileSync(join(dir, 'uendos.config.json'), 'utf8'));
  assert.equal(cfg.launchMode, 'launcher');

  const cap = JSON.parse(readFileSync(join(dir, 'capacitor.config.json'), 'utf8'));
  assert.equal(cap.server.url, undefined, 'launcher 模式不应固定主端');
  assert.deepEqual(cap.server.allowNavigation, ['hp.acme.example.com', 'ep.acme.example.com']);

  const idx = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.match(idx, /picker\.html/, '入口页应跳转到生成式选择页');
  assert.ok(!idx.includes('{{'), '入口页占位符未替换');

  const picker = readFileSync(join(dir, 'shell', 'picker.html'), 'utf8');
  assert.match(picker, /launcher-demo\.end/, '选择页应使用 endKey 记住上次端');
  assert.ok(!picker.includes('{{'), '选择页占位符未替换');
});

test('sync --check 一致，add-end 后仍一致', () => {
  assert.match(run(['sync', '--check']), /产物一致/);

  run(['add-end', 'sp', '--name', '服务台', '--url', 'https://sp.acme.example.com/']);
  const cfg = readCfg();
  assert.equal(cfg.ends.sp.name, '服务台');
  assert.equal(cfg.ends.sp.url, 'https://sp.acme.example.com/');

  assert.match(run(['sync', '--check']), /产物一致/);
});

test('theme：改配置后 sync 一致，选择页不含硬编码色值', () => {
  const cfg = readCfg();
  cfg.theme = { mode: 'dark', tokens: { accent: '#FF8800', bg: '#0E1218', ink: '#E8EEF7', radius: 10, fontScale: 1.1 } };
  writeFileSync(join(DIR, 'uendos.config.json'), JSON.stringify(cfg, null, 2) + '\n');

  assert.match(run(['sync']), /已生成/);
  assert.match(run(['sync', '--check']), /产物一致/);

  const bridge = readFileSync(join(DIR, 'shell', 'demo-acme-shell.js'), 'utf8');
  assert.match(bridge, /"theme":\s*\{/, '主题应写入品牌桥配置');
  assert.match(bridge, /"mode": "dark"/);

  const idx = readFileSync(join(DIR, 'index.html'), 'utf8');
  assert.match(idx, /picker\.html/, '入口页应跳转到生成式选择页');

  const picker = readFileSync(join(DIR, 'shell', 'picker.html'), 'utf8');
  assert.ok(!/#[0-9a-fA-F]{6}/.test(picker), '选择页不应出现硬编码色值');
  assert.match(picker, /var\(--uendos-accent\)/, '选择页应使用主题 CSS 变量');
});

test('entry：顺序、分组、记忆开关写入生成式选择页', () => {
  const cfg = readCfg();
  cfg.entry = {
    title: '选择工位',
    subtitle: '按岗位进入对应工作台',
    rememberLast: false,
    order: ['ep', 'hp', 'sp'],
    groups: [{ label: '管理与协作', ends: ['ep', 'hp'] }],
  };
  writeFileSync(join(DIR, 'uendos.config.json'), JSON.stringify(cfg, null, 2) + '\n');

  assert.match(run(['sync']), /已生成/);
  assert.match(run(['sync', '--check']), /产物一致/);

  const picker = readFileSync(join(DIR, 'shell', 'picker.html'), 'utf8');
  assert.match(picker, /选择工位/);
  assert.match(picker, /按岗位进入对应工作台/);
  assert.match(picker, /管理与协作/);
  assert.match(picker, /"rememberLast":false/);
  assert.match(picker, /"order":\["ep","hp","sp"\]/);

  const idx = readFileSync(join(DIR, 'index.html'), 'utf8');
  assert.match(idx, /location\.replace\('\.\/picker\.html' \+ location\.search\)/);

  const prep = readFileSync(join(DIR, 'scripts', 'prepare-web.sh'), 'utf8');
  assert.match(prep, /shell\/picker\.html/, 'prepare:web 应把选择页复制进 dist');
});

test('doctor --offline 与 conformance 通过', () => {
  const doctor = run(['doctor', '--offline']);
  assert.match(doctor, /全部通过/);

  const conf = run(['conformance']);
  assert.match(conf, /39 通过 \/ 0 失败/);
});

test('能力白名单：裁剪能力位、拦住方法、conformance 跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uendos-caps-'));
  const opts = { cwd: dir };
  const write = (c) => writeFileSync(join(dir, 'uendos.config.json'), JSON.stringify(c, null, 2) + '\n');
  try {
    run([
      'init', 'caps-demo',
      '--brand', 'caps-demo',
      '--ends', 'hp:个人端:https://hp.example.com/',
      '--targets', 'app',
      '--dir', dir,
    ], opts);
    const cfg = JSON.parse(readFileSync(join(dir, 'uendos.config.json'), 'utf8'));
    cfg.caps = { allow: ['vibrate', 'network'] };
    write(cfg);

    assert.match(run(['sync'], opts), /已生成/);
    assert.match(run(['sync', '--check'], opts), /产物一致/);
    const bridge = readFileSync(join(dir, 'shell', 'caps-demo-shell.js'), 'utf8');
    assert.match(bridge, /"caps": \{\n\s+"allow"/, 'caps 应写入运行时配置');

    const doctor = run(['doctor', '--offline'], opts);
    assert.match(doctor, /能力白名单：allow 2 项 · 生效/);
    assert.match(doctor, /不是权限边界/);

    const conf = run(['conformance'], opts);
    assert.match(conf, /通过：\d+ 通过 \/ \d+ 跳过 \/ 0 失败/, '被裁剪能力对应的断言应跳过而非失败');

    // 越界能力：sync 与 doctor 都要拒绝
    cfg.caps = { allow: ['bogus'] };
    write(cfg);
    const capture = (args) => {
      try { run(args, opts); return ''; } catch (e) { return `${e.message}\n${e.stdout || ''}\n${e.stderr || ''}`; }
    };
    assert.match(capture(['sync']), /能力白名单不合法/, 'sync 应拒绝越界能力');
    assert.match(capture(['doctor', '--offline']), /未知能力/, 'doctor 应报未知能力');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('插件：注册进品牌桥、doctor 体检、断言合并', () => {
  const src = fileURLToPath(new URL('../../plugin-fixture', import.meta.url));
  const dst = join(DIR, 'node_modules', '@uendos', 'plugin-fixture');
  mkdirSync(join(DIR, 'node_modules', '@uendos'), { recursive: true });
  cpSync(src, dst, { recursive: true });

  const cfg = readCfg();
  cfg.plugins = ['@uendos/plugin-fixture'];
  writeFileSync(join(DIR, 'uendos.config.json'), JSON.stringify(cfg, null, 2) + '\n');

  assert.match(run(['sync']), /已生成/);
  assert.match(run(['sync', '--check']), /产物一致/);

  const bridge = readFileSync(join(DIR, 'shell', 'demo-acme-shell.js'), 'utf8');
  assert.match(bridge, /ShellCore\.registerPlugin\("@uendos\/plugin-fixture"/);
  assert.match(bridge, /'printer\.print'/, '插件 runtime 应被原样嵌入');

  const doctor = run(['doctor', '--offline']);
  assert.match(doctor, /插件：1 个 · @uendos\/plugin-fixture@0\.1\.0/);
  assert.match(doctor, /内置 18 项 \+ 插件 1 项（printer）/);

  const conf = run(['conformance']);
  assert.match(conf, /44 通过 \/ 0 失败/, '内置 39 + 插件 5 项');

  // 构建期热更新：plugin update 走 npm install → 重新校验 → sync，不涉及运行时远程加载
  const v2 = join(DIR, '.fixtures', 'plugin-v2');
  mkdirSync(join(DIR, '.fixtures'), { recursive: true });
  cpSync(src, v2, { recursive: true });
  for (const f of ['package.json', 'uendos.plugin.json']) {
    const p = join(v2, f);
    const m = JSON.parse(readFileSync(p, 'utf8'));
    m.version = '0.2.0';
    writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  }
  const rt = readFileSync(join(v2, 'runtime.js'), 'utf8');
  writeFileSync(join(v2, 'runtime.js'), rt.replace("version: '0.1.0'", "version: '0.2.0'"));

  // 用假 npm 模拟“已发布新版本”，避免测试联网
  const bin = join(DIR, '.fakebin');
  mkdirSync(bin, { recursive: true });
  const npmStub = join(bin, 'npm');
  writeFileSync(npmStub, [
    '#!/bin/sh',
    'if [ "$1" = "install" ]; then',
    '  rm -rf node_modules/@uendos/plugin-fixture',
    '  cp -r "$UENDOS_FAKE_PLUGIN_SRC" node_modules/@uendos/plugin-fixture',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(npmStub, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, UENDOS_FAKE_PLUGIN_SRC: v2 };

  const up = run(['plugin', 'update'], { env });
  assert.match(up, /@uendos\/plugin-fixture 0\.1\.0 → 0\.2\.0/);
  assert.match(readFileSync(join(DIR, 'shell', 'demo-acme-shell.js'), 'utf8'), /version: '0\.2\.0'/, '升级后桥内插件版本应更新');
  assert.match(run(['sync', '--check']), /产物一致/);
  assert.match(run(['doctor', '--offline']), /@uendos\/plugin-fixture@0\.2\.0/);
  assert.match(run(['plugin', 'update'], { env }), /已是最新/);

  // 负例：能力与内置重名 → sync 必须失败
  const bad = join(DIR, 'node_modules', '@uendos', 'bad-plugin');
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, 'uendos.plugin.json'), JSON.stringify({
    id: '@uendos/bad-plugin',
    version: '1.0.0',
    runtime: 'runtime.js',
    capabilities: ['vibrate'],
    methods: ['vibrate.pulse'],
  }, null, 2));
  writeFileSync(join(bad, 'runtime.js'), 'return { capabilities: { vibrate: "✓" }, methods: {} };\n');
  cfg.plugins = ['@uendos/bad-plugin'];
  writeFileSync(join(DIR, 'uendos.config.json'), JSON.stringify(cfg, null, 2) + '\n');
  assert.throws(() => run(['sync']), /Command failed|插件/);
});

test('publish 计算哈希、复制安装包并回写清单', () => {
  const apk = join(DIR, 'demo-1.2.3.apk');
  writeFileSync(apk, 'fake-apk-binary');

  const manifest = join(DIR, 'apps.json');
  writeFileSync(manifest, JSON.stringify({
    generatedAt: '',
    items: [{
      id: 'demo-app-android',
      name: 'Demo',
      platform: 'android',
      version: '0.0.0',
      size: 0,
      sha256: '',
      url: '',
      status: 'pending',
      available: false,
      rollout: 100,
    }],
  }, null, 2));

  const out = run([
    'publish',
    '--file', apk,
    '--item', 'demo-app-android',
    '--manifest', manifest,
    '--download-dir', join(DIR, 'downloads'),
    '--version', '1.2.3',
  ]);
  assert.match(out, /已更新 demo-app-android/);

  const item = JSON.parse(readFileSync(manifest, 'utf8')).items[0];
  assert.equal(item.version, '1.2.3');
  assert.equal(item.status, 'beta');
  assert.equal(item.size, statSync(apk).size);
  assert.match(item.sha256, /^[0-9a-f]{64}$/);
  assert.match(item.url, /demo-1\.2\.3\.apk$/);
  assert.equal(item.available, false, 'publish 不应自行放开 available');

  assert.ok(existsSync(join(DIR, 'downloads', 'demo-1.2.3.apk')));
});
