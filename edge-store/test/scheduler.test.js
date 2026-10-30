// 后台回传调度：退避、连通性标记、冲突暂停。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, appendEvent, metaGet } from '../src/db.js';
import { startSync } from '../src/scheduler.js';
import { recordConflict } from '../src/sync.js';

function seed(db) {
  appendEvent(db, 'stock.dec', { sku: 's1', qty: 1 });
}

test('成功后游标推进，退避回到基准', async () => {
  const db = openDb();
  seed(db);
  const send = async () => ({ status: 200, body: { ok: true } });
  const s = startSync({ db, send, baseMs: 10, maxMs: 40, failThreshold: 2 });
  const r = await s.tick();
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.equal(metaGet(db, 'syncedSeq'), '1');
  assert.equal(s.status().backoffMs, 10);
  s.stop();
  db.close();
});

test('连续失败触发退避与 cloudOffline 标记', async () => {
  const db = openDb();
  seed(db);
  const send = async () => ({ status: 503, body: {} });
  const s = startSync({ db, send, baseMs: 10, maxMs: 40, failThreshold: 2 });

  await s.tick(); // fail 1, backoff 20
  assert.equal(metaGet(db, 'cloudOffline'), '0');
  await s.tick(); // fail 2 → cloudOffline=1, backoff 40
  assert.equal(metaGet(db, 'cloudOffline'), '1');
  assert.equal(s.status().fails, 2);
  assert.equal(s.status().backoffMs, 40);
  await s.tick(); // 封顶不超过 maxMs
  assert.equal(s.status().backoffMs, 40);
  assert.equal(metaGet(db, 'syncSeq'), null); // 游标不动
  s.stop();
  db.close();
});

test('恢复成功后 cloudOffline 归零', async () => {
  const db = openDb();
  seed(db);
  let fail = true;
  const send = async () => (fail ? { status: 503, body: {} } : { status: 200, body: { ok: true } });
  const s = startSync({ db, send, baseMs: 10, maxMs: 20, failThreshold: 1 });
  await s.tick();
  assert.equal(metaGet(db, 'cloudOffline'), '1');
  fail = false;
  const r = await s.tick();
  assert.equal(r.ok, true);
  assert.equal(metaGet(db, 'cloudOffline'), '0');
  s.stop();
  db.close();
});

test('存在未决冲突时暂停回传', async () => {
  const db = openDb();
  seed(db);
  recordConflict(db, { seq: 1, type: 'money.settle', payload: {}, reason: 'mismatch' });
  let called = 0;
  const send = async () => { called++; return { status: 200, body: {} }; };
  const s = startSync({ db, send, baseMs: 10, maxMs: 20 });
  const r = await s.tick();
  assert.equal(r.paused, true);
  assert.equal(called, 0);
  assert.equal(s.status().paused, true);
  s.stop();
  db.close();
});

test('冲突解决后恢复回传', async () => {
  const db = openDb();
  seed(db);
  recordConflict(db, { seq: 1, type: 'money.settle', payload: {}, reason: 'mismatch' });
  let called = 0;
  const send = async () => { called++; return { status: 200, body: {} }; };
  const s = startSync({ db, send, baseMs: 10, maxMs: 20 });
  await s.tick();
  assert.equal(called, 0);

  db.prepare("UPDATE conflicts SET status='accepted'").run();
  const r = await s.tick();
  assert.equal(r.ok, true);
  assert.equal(called, 1);
  s.stop();
  db.close();
});

test('tick 顺带拉下行；下行失败不影响上行退避', async () => {
  const db = openDb();
  seed(db);
  let pulled = 0;
  const pull = async () => { pulled++; throw new Error('catalog unavailable'); };
  let sent = 0;
  const send = async () => { sent++; return { status: 200, body: { ok: true } }; };
  const s = startSync({ db, send, pull, baseMs: 10, maxMs: 20, failThreshold: 1 });

  const r = await s.tick();
  assert.equal(pulled, 1);
  assert.equal(sent, 1);
  assert.equal(r.ok, true);
  assert.equal(r.pull.ok, false); // 下行错误被隔离，不污染上行结果
  assert.equal(metaGet(db, 'cloudOffline'), '0');
  assert.equal(s.status().backoffMs, 10);
  assert.equal(s.status().fails, 0);
  s.stop();
  db.close();
});
