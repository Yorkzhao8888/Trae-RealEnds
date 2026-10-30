// 端到端：店根 ↔ 云根真跑通（上行回传、下行读模型、冲突裁决）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloud } from '../src/server.js';
import { createEdge } from '../../edge-store/src/server.js';

async function bootBoth() {
  const cloud = createCloud({ dbPath: ':memory:', token: 'ctk' });
  await new Promise((r) => cloud.server.listen(0, '127.0.0.1', r));
  const cloudUrl = `http://127.0.0.1:${cloud.server.address().port}`;

  // 不给 cloudUrl：用 /edge/sync、/edge/pull 手动驱动，测试里不跑定时器
  const edge = createEdge({ dbPath: ':memory:', token: 'tk' });
  await new Promise((r) => edge.server.listen(0, '127.0.0.1', r));
  const edgeBase = `http://127.0.0.1:${edge.server.address().port}`;

  const edgeApi = async (method, path, body) => {
    const res = await fetch(edgeBase + path, {
      method,
      headers: { authorization: 'Bearer tk', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const cloudApi = async (method, path, body) => {
    const res = await fetch(cloudUrl + path, {
      method,
      headers: { authorization: 'Bearer ctk', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { cloud, edge, cloudUrl, edgeApi, cloudApi };
}

test('双向闭环：店内成交上行、云根商品下行到店根', async () => {
  const { cloud, edge, cloudUrl, edgeApi, cloudApi } = await bootBoth();

  await cloudApi('POST', '/cloud/stock', { sku: 'P1', onHand: 10 });
  await cloudApi('POST', '/cloud/catalog', {
    items: [{ sku: 'P1', name: '招牌面', price: 2800, status: 'on', updatedAt: 100 }],
  });
  edge.db.prepare('INSERT INTO stock (sku, on_hand) VALUES (?, ?)').run('P1', 5);

  // 上行：租约 → 原子扣减 → 回传
  const lease = await edgeApi('POST', '/edge/lease', { deviceId: 'pos-1' });
  const commit = await edgeApi('POST', '/edge/commit', { leaseId: lease.body.leaseId, ops: [{ idem: 'i-1', op: 'dec', sku: 'P1', qty: 1 }] });
  assert.equal(commit.status, 200);

  const sync = await edgeApi('POST', '/edge/sync', { cloudUrl, token: 'ctk' });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.ok, true);
  assert.equal(sync.body.sent >= 1, true);

  const cloudStock = cloud.db.prepare("SELECT on_hand FROM stock WHERE sku='P1'").get().on_hand;
  assert.equal(cloudStock, 9);
  const outbox = await edgeApi('GET', '/edge/outbox');
  assert.equal(outbox.body.count, 0);

  // 下行：云根商品落到店根，并能从 /edge/catalog 读到
  const pull = await edgeApi('POST', '/edge/pull', { cloudUrl, token: 'ctk' });
  assert.equal(pull.status, 200);
  assert.equal(pull.body.applied, 1);

  const cat = await edgeApi('GET', '/edge/catalog');
  assert.equal(cat.body.items.length, 1);
  assert.equal(cat.body.items[0].name, '招牌面');
  assert.equal(cat.body.items[0].price, 2800);
  assert.equal(cat.body.cursor, 100);

  await edge.close();
  await cloud.close();
});

test('云根库存不足 → 409；运营页裁决后游标越过冲突', async () => {
  const { cloud, edge, cloudUrl, edgeApi, cloudApi } = await bootBoth();
  await cloudApi('POST', '/cloud/stock', { sku: 'P9', onHand: 0 });
  edge.db.prepare('INSERT INTO stock (sku, on_hand) VALUES (?, ?)').run('P9', 5);

  const lease = await edgeApi('POST', '/edge/lease', { deviceId: 'pos-2' });
  await edgeApi('POST', '/edge/commit', { leaseId: lease.body.leaseId, ops: [{ idem: 'i-9', op: 'dec', sku: 'P9', qty: 2 }] });

  const sync = await edgeApi('POST', '/edge/sync', { cloudUrl, token: 'ctk' });
  assert.equal(sync.status, 409);
  assert.equal(sync.body.kind, 'auto'); // 库存类可自动裁决

  const cs = await edgeApi('GET', '/edge/conflicts');
  assert.equal(cs.body.conflicts.length, 1);
  assert.equal(cs.body.conflicts[0].status, 'auto_pending');

  const ok = await edgeApi('POST', `/edge/conflicts/${cs.body.conflicts[0].id}/resolve`, { action: 'auto' });
  assert.equal(ok.status, 200);

  // 云根从未应用这条事件；店根游标已越过冲突点，后续事件可继续传
  assert.equal(cloud.db.prepare("SELECT COUNT(*) AS n FROM cloud_events WHERE store_id='store-local'").get().n, 0);
  const st = await edgeApi('GET', '/edge/health');
  assert.equal(st.body.conflicts, 0);

  await edge.close();
  await cloud.close();
});
