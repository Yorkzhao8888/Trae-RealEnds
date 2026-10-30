// 商店 M2：按租户/设备的百分比灰度（服务端分桶）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloud } from '../src/server.js';

async function boot() {
  const app = createCloud({ dbPath: ':memory:', token: 'ctk', adminToken: 'atk' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, path, body, tk = 'dev:t1') => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { app, api };
}

test('灰度：比例设置、租户优先分桶、匿名不命中', async () => {
  const { app, api } = await boot();

  // 未配置即 0%
  const off = await api('POST', '/store/rollouts', { itemIds: ['x'], deviceId: 'd1' }, 'dev:t1');
  assert.equal(off.status, 200);
  assert.equal(off.body.items[0].percent, 0);
  assert.equal(off.body.items[0].eligible, false);
  assert.equal(off.body.items[0].reason, 'percent_0');

  // 100% 全量：匿名也命中
  const set100 = await api('PUT', '/store/rollouts/x', { percent: 100 }, 'atk');
  assert.equal(set100.status, 200);
  assert.equal(set100.body.percent, 100);
  const all = await api('POST', '/store/rollouts', { itemIds: ['x'] }, '');
  assert.equal(all.body.items[0].eligible, true);
  assert.equal(all.body.items[0].reason, 'percent_100');

  // 50%：同一租户不同设备结果一致，桶与判定自洽
  await api('PUT', '/store/rollouts/y', { percent: 50 }, 'atk');
  const a = await api('POST', '/store/rollouts', { itemIds: ['y'], deviceId: 'd1' }, 'dev:t1');
  const b = await api('POST', '/store/rollouts', { itemIds: ['y'], deviceId: 'd2' }, 'dev:t1');
  const y1 = a.body.items[0];
  assert.equal(y1.bucket, b.body.items[0].bucket);
  assert.ok(y1.bucket >= 0 && y1.bucket < 100);
  assert.equal(y1.eligible, y1.bucket < 50);
  assert.equal(y1.reason, y1.eligible ? 'in' : 'out');

  // 重复判定稳定
  const again = await api('POST', '/store/rollouts', { itemIds: ['y'], deviceId: 'd1' }, 'dev:t1');
  assert.equal(again.body.items[0].bucket, y1.bucket);

  // 匿名 + 50%：不命中，理由明确
  const anon = await api('POST', '/store/rollouts', { itemIds: ['y'], deviceId: '' }, '');
  assert.equal(anon.body.items[0].eligible, false);
  assert.equal(anon.body.items[0].reason, 'no_identity');

  // 无租户令牌时按设备分桶
  const byDevice = await api('POST', '/store/rollouts', { itemIds: ['y'], deviceId: 'dev-abc' }, '');
  assert.ok(byDevice.body.items[0].bucket >= 0);
  assert.equal(byDevice.body.items[0].reason, byDevice.body.items[0].eligible ? 'in' : 'out');

  // 鉴权与入参
  const noAdmin = await api('PUT', '/store/rollouts/x', { percent: 100 }, 'dev:t1');
  assert.equal(noAdmin.status, 403);
  assert.equal(noAdmin.body.code, 'admin_only');

  const bad = await api('PUT', '/store/rollouts/x', { percent: 'x' }, 'atk');
  assert.equal(bad.status, 400);

  const empty = await api('POST', '/store/rollouts', { itemIds: [] }, '');
  assert.equal(empty.status, 400);

  const list = await api('GET', '/store/rollouts', undefined, 'atk');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map((i) => [i.itemId, i.percent]).sort(), [['x', 100], ['y', 50]]);
  await app.close();
});
