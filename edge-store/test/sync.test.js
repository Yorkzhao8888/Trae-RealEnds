// 云根回传与冲突裁决：不跳过、不动资金账、可人工复核。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEdge } from '../src/server.js';
import { appendEvent } from '../src/db.js';

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

// 可控的假云根：按队列返回预设响应
async function cloudMock(responses) {
  const got = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      got.push({ path: req.url, payload: JSON.parse(raw || '{}') });
      const next = responses.shift() || { status: 200, body: { ok: true } };
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
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

test('回传成功推进游标，outbox 清空', async () => {
  const { app, api } = await boot();
  const cloud = await cloudMock([{ status: 200, body: { ok: true } }]);
  app.db.prepare('INSERT INTO stock (sku, on_hand) VALUES (?, ?)').run('s1', 5);
  const { body: l } = await api('POST', '/edge/lease', { deviceId: 'd1' });
  await api('POST', '/edge/commit', { leaseId: l.leaseId, ops: [{ idem: 'i1', op: 'dec', sku: 's1', qty: 1 }] });

  const outbox = await api('GET', '/edge/outbox');
  assert.equal(outbox.body.count >= 1, true);

  const r = await api('POST', '/edge/sync', { cloudUrl: cloud.url });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(cloud.got.length, 1);
  assert.equal(cloud.got[0].payload.events.length >= 1, true);

  const after = await api('GET', '/edge/outbox');
  assert.equal(after.body.count, 0);
  await cloud.close();
  await app.close();
});

test('云根 409：停在冲突点之前，不跳过', async () => {
  const { app, api } = await boot();
  app.db.prepare('INSERT INTO stock (sku, on_hand) VALUES (?, ?)').run('s2', 9);
  const { body: l } = await api('POST', '/edge/lease', { deviceId: 'd2' });
  await api('POST', '/edge/commit', { leaseId: l.leaseId, ops: [{ idem: 'i2', op: 'dec', sku: 's2', qty: 1 }] });
  const moneySeq = appendEvent(app.db, 'money.settle', { amount: 100 });
  appendEvent(app.db, 'stock.inc', { sku: 's2', qty: 1 });

  const cloud = await cloudMock([{ status: 409, body: { ok: false, code: 'conflict', seq: moneySeq, reason: 'settlement mismatch' } }]);
  const r = await api('POST', '/edge/sync', { cloudUrl: cloud.url });
  assert.equal(r.status, 409);
  assert.equal(r.body.conflict, true);
  assert.equal(r.body.kind, 'manual');

  // 游标停在 money 之前（stock.dec 已同步）
  assert.equal(app.db.prepare("SELECT v FROM meta WHERE k='syncedSeq'").get().v, String(moneySeq - 1));

  const cs = await api('GET', '/edge/conflicts');
  assert.equal(cs.body.conflicts.length, 1);
  assert.equal(cs.body.conflicts[0].status, 'manual_pending');

  // 资金类不允许自动放行
  const auto = await api('POST', `/edge/conflicts/${cs.body.conflicts[0].id}/resolve`, { action: 'auto' });
  assert.equal(auto.status, 400);
  assert.equal(auto.body.code, 'manual_required');

  const acc = await api('POST', `/edge/conflicts/${cs.body.conflicts[0].id}/resolve`, { action: 'accept' });
  assert.equal(acc.status, 200);
  assert.equal(app.db.prepare("SELECT v FROM meta WHERE k='syncedSeq'").get().v, String(moneySeq));
  await cloud.close();
  await app.close();
});

test('云根 5xx 可重试且游标不动', async () => {
  const { app, api } = await boot();
  app.db.prepare('INSERT INTO stock (sku, on_hand) VALUES (?, ?)').run('s3', 3);
  const { body: l } = await api('POST', '/edge/lease', { deviceId: 'd3' });
  await api('POST', '/edge/commit', { leaseId: l.leaseId, ops: [{ idem: 'i3', op: 'dec', sku: 's3', qty: 1 }] });

  const cloud = await cloudMock([{ status: 503, body: { ok: false } }]);
  const r = await api('POST', '/edge/sync', { cloudUrl: cloud.url });
  assert.equal(r.status, 502);
  assert.equal(r.body.retryable, true);
  assert.equal(r.body.sent, 0);
  assert.equal(app.db.prepare("SELECT v FROM meta WHERE k='syncedSeq'").get().v, '0');
  await cloud.close();
  await app.close();
});

test('云根未配置直接拒绝', async () => {
  const { app, api } = await boot();
  const r = await api('POST', '/edge/sync', {});
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'cloud_not_configured');
  await app.close();
});
