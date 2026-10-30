// 云根参考实现的库层：事件幂等接收、冲突判定、商品读模型。
// 与 edge-store 一样用 Node 24 内置 SQLite，零第三方依赖。
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cloud_events (store_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (store_id, seq));
CREATE TABLE IF NOT EXISTS stock (sku TEXT PRIMARY KEY, on_hand INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS catalog (sku TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'on', updated_at INTEGER NOT NULL DEFAULT 0);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

function lastSeq(db, storeId) {
  const row = db.prepare('SELECT MAX(seq) AS m FROM cloud_events WHERE store_id = ?').get(storeId);
  return Number(row && row.m) || 0;
}

// 云根权威判定：库存不足、对账不符都返回冲突（对应 409）。
function checkConflict(db, ev) {
  const d = ev.data || {};
  if (ev.type === 'stock.dec') {
    const sku = String(d.sku || '');
    const row = db.prepare('SELECT on_hand FROM stock WHERE sku = ?').get(sku);
    const onHand = row ? Number(row.on_hand) : 0;
    const qty = Number(d.qty);
    if (onHand < qty) return { reason: `云根库存不足：${sku} 现有 ${onHand}，需 ${qty}`, onHand };
  }
  if (ev.type === 'money.settle' && d.expected != null) {
    if (Number(d.expected) !== Number(d.amount)) {
      return { reason: `对账不符：本地实收 ${d.amount} ≠ 云根应收 ${d.expected}` };
    }
  }
  return null;
}

function applyEffect(db, ev) {
  const d = ev.data || {};
  if (ev.type !== 'stock.dec' && ev.type !== 'stock.inc') return;
  const sku = String(d.sku || '');
  const qty = Number(d.qty) || 0;
  const delta = ev.type === 'stock.dec' ? -qty : qty;
  const row = db.prepare('SELECT on_hand FROM stock WHERE sku = ?').get(sku);
  if (row) db.prepare('UPDATE stock SET on_hand = on_hand + ? WHERE sku = ?').run(delta, sku);
  else db.prepare('INSERT INTO stock (sku, on_hand) VALUES (?, ?)').run(sku, delta);
}

/**
 * 收一批上行事件。按 (storeId, seq) 幂等；遇到冲突就停在冲突事件之前。
 * 返回 { ok, applied, replayed, cursor } 或 { ok:false, conflict:{seq, reason, onHand?}, applied, replayed, cursor }
 */
export function applyEvents(db, storeId, events = []) {
  let applied = 0;
  let replayed = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const ev of events) {
      const seq = Number(ev && ev.seq);
      if (!Number.isInteger(seq) || seq <= 0) continue;
      const seen = db.prepare('SELECT 1 FROM cloud_events WHERE store_id = ? AND seq = ?').get(storeId, seq);
      if (seen) { replayed++; continue; }

      const hit = checkConflict(db, ev);
      if (hit) {
        // 冲突前已应用的事件必须落库，不能因为一条冲突整批回滚
        const cursor = lastSeq(db, storeId);
        db.exec('COMMIT');
        return { ok: false, conflict: { seq, reason: hit.reason, ...(hit.onHand !== undefined ? { onHand: hit.onHand } : {}) }, applied, replayed, cursor };
      }

      applyEffect(db, ev);
      const at = Number(ev.at) || Date.now();
      db.prepare('INSERT INTO cloud_events (store_id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?)').run(storeId, seq, String(ev.type), JSON.stringify(ev.data ?? null), at);
      applied++;
    }

    const cursor = lastSeq(db, storeId);
    db.exec('COMMIT');
    return { ok: true, applied, replayed, cursor };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function catalogSince(db, since = 0, limit = 200) {
  const rows = db.prepare('SELECT sku, name, price, status, updated_at FROM catalog WHERE updated_at > ? ORDER BY updated_at, sku LIMIT ?')
    .all(Number(since) || 0, limit);
  return {
    cursor: rows.length ? Number(rows[rows.length - 1].updated_at) : Number(since) || 0,
    items: rows.map((r) => ({ sku: r.sku, name: r.name, price: Number(r.price), status: r.status, updatedAt: Number(r.updated_at) })),
  };
}

export function upsertCatalog(db, items = []) {
  let n = 0;
  for (const it of items) {
    const sku = String((it && it.sku) || '').trim();
    if (!sku) continue;
    const price = Number(it.price);
    if (!Number.isFinite(price)) continue;
    const status = it.status === 'deleted' ? 'deleted' : it.status === 'off' ? 'off' : 'on';
    const updatedAt = Number(it.updatedAt) || Date.now();
    db.prepare(`INSERT INTO catalog (sku, name, price, status, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sku) DO UPDATE SET name = excluded.name, price = excluded.price, status = excluded.status, updated_at = excluded.updated_at`)
      .run(sku, String(it.name ?? ''), price, status, updatedAt);
    n++;
  }
  return n;
}

export function setStock(db, sku, onHand) {
  const s = String(sku || '').trim();
  if (!s) return false;
  const v = Number(onHand);
  if (!Number.isFinite(v)) return false;
  db.prepare(`INSERT INTO stock (sku, on_hand) VALUES (?, ?) ON CONFLICT(sku) DO UPDATE SET on_hand = excluded.on_hand`).run(s, v);
  return true;
}

export function listEvents(db, storeId, limit = 100) {
  return db.prepare('SELECT seq, type, payload, at FROM cloud_events WHERE store_id = ? ORDER BY seq DESC LIMIT ?')
    .all(storeId, limit)
    .map((r) => ({ seq: Number(r.seq), type: r.type, data: JSON.parse(r.payload), at: Number(r.at) }));
}
