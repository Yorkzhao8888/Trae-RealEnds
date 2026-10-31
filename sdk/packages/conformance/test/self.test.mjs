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
