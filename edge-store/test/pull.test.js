// 下行读模型（/edge/pull）：增量拉取商品/价格，失败不跳批、重复下发幂等。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEdge } from '../src/server.js';
import { openDb, metaGet, catalogList, applyCatalog } from '../src/db.js';
import { pullOnce } from '../src/pull.js';

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
  return { app, api, base };
}

// 假云根：按队列返回 /cloud/catalog 的预设响应
async function cloudMock(responses) {
  const got = [];
  const server = createServer((req, res) => {
    got.push(req.url);
    const next = responses.shift() || { status: 200, body: { cursor: 0, items: [] } };
    res.writeHead(next.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(next.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    got,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
}

test('首次拉取：写入商品、推进游标、产生事件', async () => {
  const { app, api } = await boot();
  const cloud = await cloudMock([{
    status: 200,
    body: { cursor: 7, items: [{ sku: 'p1', name: '小笼包', price: 1800, status: 'on', updatedAt: 7 }] },
  }]);

  const r = await api('POST', '/edge/pull', { cloudUrl: cloud.url });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.applied, 1);
  assert.equal(r.body.cursor, 7);
  assert.equal(metaGet(app.db, 'catalogSeq'), '7');

  const list = await api('GET', '/edge/catalog');
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].name, '小笼包');
  assert.equal(list.body.items[0].price, 1800);

  // 端壳可从 snapshot 的增量事件里看到商品变更
  const snap = await api('GET', '/edge/snapshot?since=0');
  assert.equal(snap.body.events.some((e) => e.type === 'catalog.upsert'), true);

  await cloud.close();
  await app.close();
});

test('增量拉取：带 since；下架为 off，删除为 removed', async () => {
  const { app, api } = await boot();
  const cloud = await cloudMock([
    { status: 200, body: { cursor: 3, items: [{ sku: 'p2', name: '豆浆', price: 500, status: 'on', updatedAt: 3 }] } },
    {
      status: 200,
      body: {
        cursor: 9,
        items: [
          { sku: 'p2', name: '豆浆', price: 600, status: 'off', updatedAt: 9 },
          { sku: 'p1', name: '小笼包', price: 1800, status: 'deleted', updatedAt: 9 },
        ],
      },
    },
  ]);

  await api('POST', '/edge/pull', { cloudUrl: cloud.url });
  const r2 = await api('POST', '/edge/pull', { cloudUrl: cloud.url });
  assert.equal(r2.body.applied, 1);
  assert.equal(metaGet(app.db, 'catalogSeq'), '9');
  // 第二次请求必须带上已推进的游标
  assert.equal(cloud.got[1], '/cloud/catalog?since=3');

  const list = await api('GET', '/edge/catalog');
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].status, 'off');
  assert.equal(list.body.items[0].price, 600);

  await cloud.close();
  await app.close();
});

test('重复下发同一份内容不重复写事件（幂等）', async () => {
  const db = openDb();
  const items = [{ sku: 'p1', name: '小笼包', price: 1800, status: 'on', updatedAt: 5 }];

  const a = applyCatalog(db, items);
  const b = applyCatalog(db, items);
  assert.equal(a.applied, 1);
  assert.equal(b.applied, 0);
  assert.equal(b.unchanged, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='catalog.upsert'").get().n, 1);
  assert.equal(catalogList(db).length, 1);

  db.close();
});

test('云根 5xx 可重试且游标不动', async () => {
  const { app, api } = await boot();
  const cloud = await cloudMock([{ status: 503, body: { ok: false } }]);
  const r = await api('POST', '/edge/pull', { cloudUrl: cloud.url });
  assert.equal(r.status, 502);
  assert.equal(r.body.retryable, true);
  assert.equal(metaGet(app.db, 'catalogSeq'), '0');
  await cloud.close();
  await app.close();
});

test('云根未配置直接拒绝', async () => {
  const { app, api } = await boot();
  const r = await api('POST', '/edge/pull', {});
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'cloud_not_configured');
  await app.close();
});

test('网络异常：可重试，游标不动', async () => {
  const db = openDb();
  const r = await pullOnce(db, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
  assert.equal(metaGet(db, 'catalogSeq'), '0');
  db.close();
});
