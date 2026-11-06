import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeShellFile } from '../../shell/src/index.js';
import { runConformance } from '../src/index.js';

const cfg = {
  schemaVersion: 1,
  brand: 'demo',
  displayName: 'Demo 工作台',
  alias: 'demoOS',
  prefix: 'demo',
  accent: '#4C8DFF',
  endKey: 'demo.end',
  targets: ['web'],
  ends: {
    hp: { name: '个人端', url: 'https://demo.local/hp' },
    ep: { name: '企业端', url: 'https://demo.local/ep' },
  },
};

test('生成的品牌桥通过全部一致性断言', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uendos-'));
  const file = join(dir, 'demo-shell.js');
  writeFileSync(file, composeShellFile(cfg));

  const r = await runConformance(file, { cfg });
  assert.equal(r.ok, true, r.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join('\n'));
  assert.ok(r.passed >= 35, `断言数偏少：${r.passed}`);
});

test('设备身份断言：配置 security.identity 后刷新与吊销走 mock', async () => {
  const withIdentity = {
    ...cfg,
    security: { identity: { mode: 'device', endpoint: 'https://demo.local/api/backend/device/refresh' } },
  };
  const dir = mkdtempSync(join(tmpdir(), 'uendos-identity-'));
  const file = join(dir, 'demo-shell.js');
  writeFileSync(file, composeShellFile(withIdentity));

  const r = await runConformance(file);
  assert.equal(r.ok, true, r.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join('\n'));
  const row = r.results.find((x) => x.name.startsWith('identity.refresh'));
  assert.ok(row && row.ok && !row.skipped, '设备身份刷新断言应实际执行');
});

test('入口路由断言：成功 / 缺参 / 未知 / 能力不足', async () => {
  const withRoutes = {
    ...cfg,
    entry: {
      routes: [
        { id: 'home', label: '首页', path: '/home', fallback: '/home?tab=a', params: { tab: { type: 'string', required: true, enum: ['a', 'b'] } } },
        { id: 'iot-panel', label: '设备', path: '/iot', fallback: '/home?tab=a', requires: { capability: 'iot' } },
      ],
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'uendos-entry-'));
  const file = join(dir, 'demo-shell.js');
  writeFileSync(file, composeShellFile(withRoutes));

  const r = await runConformance(file);
  const names = r.results.map((x) => x.name);
  assert.equal(r.ok, true, r.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join('\n'));
  for (const n of ['entries() 列出入口与可用性', 'entry.open 校验参数并拼装站内路径', 'entry.open 缺必填参数返回 E_BAD_ARGS', '未知入口返回 E_BAD_ARGS', '能力不足返回 E_UNSUPPORTED 并带 fallback']) {
    assert.ok(names.includes(n), `缺断言：${n}`);
  }
});
