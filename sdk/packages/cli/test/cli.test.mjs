import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/uendos.mjs', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'uendos-cli-'));

test.after(() => rmSync(DIR, { recursive: true, force: true }));

function run(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: DIR,
    encoding: 'utf8',
    timeout: 120000,
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
  assert.match(cfg.contractVersion, /^0\.3\./);

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
  assert.match(idx, /launcher-demo\.end/, '选择页应使用 endKey 记住上次端');
  assert.ok(!idx.includes('{{'), '选择页占位符未替换');
});

test('sync --check 一致，add-end 后仍一致', () => {
  assert.match(run(['sync', '--check']), /产物一致/);

  run(['add-end', 'sp', '--name', '服务台', '--url', 'https://sp.acme.example.com/']);
  const cfg = readCfg();
  assert.equal(cfg.ends.sp.name, '服务台');
  assert.equal(cfg.ends.sp.url, 'https://sp.acme.example.com/');

  assert.match(run(['sync', '--check']), /产物一致/);
});

test('doctor --offline 与 conformance 通过', () => {
  const doctor = run(['doctor', '--offline']);
  assert.match(doctor, /全部通过/);

  const conf = run(['conformance']);
  assert.match(conf, /39 通过 \/ 0 失败/);
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
