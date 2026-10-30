// 云根同步（outbox）：店根只追加事件，按游标批量回传。
//
// 三条规则：
//   1. 先本地提交，再异步回传——回传失败不影响成交（这是店根存在的意义）。
//   2. 云根返回 409 冲突时，游标停在冲突点之前，不允许"跳过继续传"。
//   3. 冲突按类型分流：库存类自动（云根权威），资金类必须人工复核。
import { metaGet, metaSet } from './db.js';

const BATCH = 200;
const CLOUD_TYPES = {
  auto: ['stock.dec', 'stock.inc', 'order.draft'],
  manual: ['money.settle', 'money.refund', 'member.points'],
};

export function classify(type) {
  if (CLOUD_TYPES.manual.includes(type)) return 'manual';
  if (CLOUD_TYPES.auto.includes(type)) return 'auto';
  return 'manual'; // 未知类型保守处理：宁可人工复核，也不自动改账
}

export function pending(db) {
  const since = Number(metaGet(db, 'syncedSeq') || 0);
  const rows = db.prepare('SELECT seq, type, payload, at FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(since, BATCH);
  return { since, rows };
}

export function recordConflict(db, { seq, type, payload, reason }) {
  db.prepare('INSERT INTO conflicts (seq, type, payload, reason, status, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(seq, type, JSON.stringify(payload || null), String(reason || ''), classify(type) === 'auto' ? 'auto_pending' : 'manual_pending', Date.now());
}

export function openConflicts(db) {
  return db.prepare('SELECT id, seq, type, reason, status, at FROM conflicts WHERE status IN (?, ?) ORDER BY id')
    .all('auto_pending', 'manual_pending');
}

/**
 * 回传一批。cloud(cursor, events) 返回 {status, body} 或抛错。
 * action: 'accept' | 'reject' | 'auto'
 */
export async function syncOnce(db, send) {
  const { since, rows } = pending(db);
  if (!rows.length) return { ok: true, sent: 0, cursor: since };

  const events = rows.map((r) => ({ seq: r.seq, type: r.type, data: JSON.parse(r.payload), at: r.at }));
  let res;
  try {
    res = await send({ storeId: metaGet(db, 'storeId') || 'store-local', cursor: since, events });
  } catch (e) {
    return { ok: false, retryable: true, sent: 0, cursor: since, error: e.message };
  }

  if (res.status === 200) {
    const next = rows[rows.length - 1].seq;
    metaSet(db, 'syncedSeq', next);
    return { ok: true, sent: rows.length, cursor: next };
  }

  if (res.status === 409) {
    // 冲突：只前进到冲突事件之前，保证顺序与"不跳过"语义
    const body = res.body || {};
    const atSeq = Number(body.seq) || rows[0].seq;
    const idx = rows.findIndex((r) => r.seq === atSeq);
    const stopIdx = idx >= 0 ? idx : 0;
    if (stopIdx > 0) metaSet(db, 'syncedSeq', rows[stopIdx - 1].seq);
    const hit = rows[stopIdx];
    recordConflict(db, { seq: hit.seq, type: hit.type, payload: JSON.parse(hit.payload), reason: body.reason || 'cloud conflict' });
    return { ok: false, conflict: true, cursor: Number(metaGet(db, 'syncedSeq') || 0), seq: hit.seq, kind: classify(hit.type) };
  }

  return { ok: false, retryable: res.status >= 500, status: res.status, sent: 0, cursor: since };
}

/** 处理冲突：accept 放行 / reject 作废 / auto 仅限库存类；三者都推进游标。 */
export function resolveConflict(db, id, action) {
  const row = db.prepare('SELECT id, seq, type FROM conflicts WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, code: 'not_found' };
  if (!['accept', 'reject', 'auto'].includes(action)) return { ok: false, code: 'bad_action' };
  if (action === 'auto' && classify(row.type) === 'manual') return { ok: false, code: 'manual_required' };
  const status = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'auto_resolved';
  db.prepare('UPDATE conflicts SET status = ? WHERE id = ?').run(status, Number(id));
  const synced = Number(metaGet(db, 'syncedSeq') || 0);
  if (row.seq > synced) metaSet(db, 'syncedSeq', row.seq);
  db.prepare('INSERT INTO events (type, payload, at) VALUES (?, ?, ?)')
    .run('sync.' + action, JSON.stringify({ conflictId: Number(id), seq: row.seq }), Date.now());
  return { ok: true, id: Number(id), action, status };
}
