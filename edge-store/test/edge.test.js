// 店根验收：原子性、幂等、租约、快照增量。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEdge } from '../src/server.js';

async function boot() {
  const app = createEdge({ dbPath: ':memory:', token: 'tk' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: 'Bearer tk', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { app, api };
}

test('health 与鉴权', async () => {
  const { app, api } = await boot();
  const ok = await api('GET', '/edge/health');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.cloudOffline, false);

  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/edge/health`);
  assert.equal(res.status, 401);
  await app.close();
});

test('租约 + 原子扣减 + 幂等重放', async () => {
  const { app, api } = await boot();
  const { db } = app;
  db.prepare('INSERT INTO stock (sku, on_hand) VALUES (?, ?)').run('sku-a', 5);

  const lease = await api('POST', '/edge/lease', { deviceId: 'pos-1', ttlMs: 60000 });
  assert.equal(lease.status, 200);
  const leaseId = lease.body.leaseId;

  const ops = [{ idem: 'k1', op: 'dec', sku: 'sku-a', qty: 2 }];
  const c1 = await api('POST', '/edge/commit', { leaseId, ops });
  assert.equal(c1.status, 200);
  assert.equal(c1.body.applied.length, 1);

  // 同幂等键重放：不重复扣减
  const c2 = await api('POST', '/edge/commit', { leaseId, ops });
  assert.equal(c2.status, 200);
  assert.equal(c2.body.applied.length, 0);
  assert.equal(c2.body.replayed, 1);

  const row = db.prepare('SELECT on_hand FROM stock WHERE sku = ?').get('sku-a');
  assert.equal(row.on_hand, 3);
  await app.close();
});

test('库存不足整批失败且不留痕', async () => {
  const { app, api } = await boot();
  app.db.prepare('INSERT INTO stock (sku, on_hand) VALUES (?, ?)').run('sku-b', 1);
  const { body } = await api('POST', '/edge/lease', { deviceId: 'pos-2' });

  const res = await api('POST', '/edge/commit', {
    leaseId: body.leaseId,
    ops: [
      { idem: 'k2', op: 'dec', sku: 'sku-b', qty: 1 },
      { idem: 'k3', op: 'dec', sku: 'sku-b', qty: 2 },
    ],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'stock');

  // 整批回滚：一件都没扣，幂等键也没落库
  assert.equal(app.db.prepare('SELECT on_hand FROM stock WHERE sku = ?').get('sku-b').on_hand, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM idem').get().n, 0);
  await app.close();
});

test('租约过期后拒绝成交', async () => {
  const { app, api } = await boot();
  app.db.prepare('INSERT INTO stock (sku, on_hand) VALUES (?, ?)').run('sku-c', 9);
  const { body } = await api('POST', '/edge/lease', { deviceId: 'pos-3', ttlMs: 60000 });
  app.db.prepare('UPDATE lease SET expires = ? WHERE id = ?').run(Date.now() - 1000, body.leaseId);

  const res = await api('POST', '/edge/commit', { leaseId: body.leaseId, ops: [{ idem: 'k4', op: 'dec', sku: 'sku-c', qty: 1 }] });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'lease_expired');
  await app.close();
});

test('单笔超限拒绝', async () => {
  const { app, api } = await boot();
  app.db.prepare('INSERT INTO stock (sku, on_hand) VALUES (?, ?)').run('sku-d', 100);
  const { body } = await api('POST', '/edge/lease', { deviceId: 'pos-4' });
  const res = await api('POST', '/edge/commit', { leaseId: body.leaseId, ops: [{ idem: 'k5', op: 'dec', sku: 'sku-d', qty: 30 }] });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'limit');
  await app.close();
});

test('快照按游标增量返回', async () => {
  const { app, api } = await boot();
  const { body: lease } = await api('POST', '/edge/lease', { deviceId: 'pos-5' });
  const c = await api('POST', '/edge/commit', {
    leaseId: lease.leaseId,
    ops: [{ idem: 'k6', op: 'inc', sku: 'sku-e', qty: 4 }],
  });
  assert.equal(c.status, 200);

  const full = await api('GET', '/edge/snapshot');
  assert.equal(full.body.events.length, 1);
  assert.equal(full.body.cursor, 1);

  const delta = await api('GET', '/edge/snapshot?since=' + full.body.cursor);
  assert.equal(delta.body.events.length, 0);
  assert.equal(delta.body.version, full.body.version);
  await app.close();
});

test('云根离线标记可被健康检查读到', async () => {
  const { app, api } = await boot();
  await api('POST', '/edge/cloud', { offline: true });
  const h = await api('GET', '/edge/health');
  assert.equal(h.body.cloudOffline, true);
  await app.close();
});
