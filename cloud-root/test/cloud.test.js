// 云根单元测试：幂等、冲突停在冲突点、商品读模型游标。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloud } from '../src/server.js';

async function boot() {
  const app = createCloud({ dbPath: ':memory:', token: 'ctk' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, path, body, tk = 'ctk') => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { app, api, base };
}

test('鉴权与健康', async () => {
  const { app, api, base } = await boot();
  const r = await fetch(base + '/cloud/health');
  assert.equal(r.status, 401);
  const h = await api('GET', '/cloud/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.role, 'cloud-root');
  await app.close();
});

test('幂等：同批重传不重复扣减', async () => {
  const { app, api } = await boot();
  await api('POST', '/cloud/stock', { sku: 'P1', onHand: 10 });
  const events = [{ seq: 1, type: 'stock.dec', data: { sku: 'P1', qty: 2 }, at: 1 }];

  const a = await api('POST', '/cloud/events', { storeId: 's1', cursor: 0, events });
  assert.equal(a.status, 200);
  assert.equal(a.body.applied, 1);
  assert.equal(a.body.cursor, 1);

  const b = await api('POST', '/cloud/events', { storeId: 's1', cursor: 0, events });
  assert.equal(b.status, 200);
  assert.equal(b.body.applied, 0);
  assert.equal(b.body.replayed, 1);

  const onHand = app.db.prepare("SELECT on_hand FROM stock WHERE sku='P1'").get().on_hand;
  assert.equal(onHand, 8); // 只扣一次
  await app.close();
});

test('库存不足返回 409，前序事件已落库、游标停在冲突前', async () => {
  const { app, api } = await boot();
  await api('POST', '/cloud/stock', { sku: 'P2', onHand: 3 });
  const events = [
    { seq: 1, type: 'stock.inc', data: { sku: 'P2', qty: 1 }, at: 1 },
    { seq: 2, type: 'stock.dec', data: { sku: 'P2', qty: 9 }, at: 2 },
  ];
  const r = await api('POST', '/cloud/events', { storeId: 's2', cursor: 0, events });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'conflict');
  assert.equal(r.body.seq, 2);
  assert.equal(r.body.cursor, 1); // 第 1 条已应用
  assert.equal(app.db.prepare("SELECT on_hand FROM stock WHERE sku='P2'").get().on_hand, 4);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM cloud_events').get().n, 1);
  await app.close();
});

test('对账不符返回 409（资金类冲突）', async () => {
  const { app, api } = await boot();
  const r = await api('POST', '/cloud/events', {
    storeId: 's3',
    cursor: 0,
    events: [{ seq: 1, type: 'money.settle', data: { amount: 108, expected: 120 }, at: 1 }],
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.seq, 1);
  assert.equal(r.body.reason.includes('对账不符'), true);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM cloud_events').get().n, 0);
  await app.close();
});

test('商品读模型：since 游标 + 下架/删除可见', async () => {
  const { app, api } = await boot();
  await api('POST', '/cloud/catalog', { items: [{ sku: 'P1', name: '小笼包', price: 1800, status: 'on', updatedAt: 10 }] });

  const first = await api('GET', '/cloud/catalog?since=0');
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.cursor, 10);

  await api('POST', '/cloud/catalog', { items: [
    { sku: 'P1', name: '小笼包', price: 2000, status: 'off', updatedAt: 20 },
    { sku: 'P2', name: '豆浆', price: 500, status: 'deleted', updatedAt: 21 },
  ] });

  const delta = await api('GET', '/cloud/catalog?since=10');
  assert.equal(delta.body.items.length, 2);
  assert.equal(delta.body.items[0].status, 'off');
  assert.equal(delta.body.items[1].status, 'deleted');
  assert.equal(delta.body.cursor, 21);

  const empty = await api('GET', '/cloud/catalog?since=21');
  assert.equal(empty.body.items.length, 0);
  assert.equal(empty.body.cursor, 21);
  await app.close();
});
