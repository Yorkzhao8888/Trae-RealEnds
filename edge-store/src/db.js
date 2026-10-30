// 店根本地库：只追加事件 + 原子扣减 + 幂等去重。
// 选 node:sqlite（Node 24 内置）而非 better-sqlite3：店根是长期驻留进程，
// 原生模块编译在门店环境（Windows POS / Linux 收银机）最容易出问题。
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stock (sku TEXT PRIMARY KEY, on_hand INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lease (id TEXT PRIMARY KEY, device TEXT NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS idem (key TEXT PRIMARY KEY, result TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conflicts (id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS catalog (sku TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'on', updated_at INTEGER NOT NULL DEFAULT 0);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').run('version', '0');
  db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').run('cloudOffline', '0');
  db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').run('syncedSeq', '0');
  db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').run('catalogSeq', '0');
  return db;
}

export function metaGet(db, k) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return row ? row.v : null;
}

export function metaSet(db, k, v) {
  db.prepare('UPDATE meta SET v = ? WHERE k = ?').run(String(v), k);
}

export function version(db) {
  return Number(metaGet(db, 'version') || 0);
}

export function bumpVersion(db) {
  const next = version(db) + 1;
  metaSet(db, 'version', next);
  return next;
}

export function appendEvent(db, type, payload, at = Date.now()) {
  const info = db.prepare('INSERT INTO events (type, payload, at) VALUES (?, ?, ?)').run(type, JSON.stringify(payload), at);
  return Number(info.lastInsertRowid);
}

export function createLease(db, device, ttlMs) {
  const id = 'lease_' + Math.random().toString(36).slice(2, 10);
  const expires = Date.now() + ttlMs;
  db.prepare('INSERT INTO lease (id, device, expires, active) VALUES (?, ?, ?, 1)').run(id, device, expires);
  return { id, expires, ttl: ttlMs };
}

export function aliveLeases(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM lease WHERE active = 1 AND expires > ?').get(Date.now()).n;
}

/**
 * 原子提交：整批成功或整批失败（契约 §店根）。
 * ops: [{ idem, op: 'dec' | 'inc', sku, qty }]
 * 返回 { ok, version, applied, replayed } 或 { conflict, ... }
 */
export function commit(db, { leaseId, ops }) {
  const lease = db.prepare('SELECT id, expires, active FROM lease WHERE id = ?').get(leaseId);
  if (!lease || !lease.active) return { ok: false, code: 'lease_unknown' };
  if (lease.expires < Date.now()) return { ok: false, code: 'lease_expired' };

  const fresh = [];
  for (const op of ops) {
    if (!op || !op.sku || !Number.isInteger(op.qty) || op.qty <= 0) return { ok: false, code: 'bad_op' };
    if (op.op !== 'dec' && op.op !== 'inc') return { ok: false, code: 'bad_op' };
    // 幂等：同键已提交则视为重放，不再重复扣减
    if (op.idem && db.prepare('SELECT result FROM idem WHERE key = ?').get(op.idem)) continue;
    fresh.push(op);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const op of fresh) {
      const row = db.prepare('SELECT on_hand FROM stock WHERE sku = ?').get(op.sku);
      const onHand = row ? row.on_hand : 0;
      const delta = op.op === 'dec' ? -op.qty : op.qty;
      if (onHand + delta < 0) {
        db.exec('ROLLBACK');
        return { ok: false, code: 'stock', sku: op.sku, onHand };
      }
    }

    const applied = [];
    for (const op of fresh) {
      const delta = op.op === 'dec' ? -op.qty : op.qty;
      const row = db.prepare('SELECT on_hand FROM stock WHERE sku = ?').get(op.sku);
      if (row) db.prepare('UPDATE stock SET on_hand = on_hand + ? WHERE sku = ?').run(delta, op.sku);
      else db.prepare('INSERT INTO stock (sku, on_hand) VALUES (?, ?)').run(op.sku, delta);

      const result = JSON.stringify({ sku: op.sku, qty: op.qty, op: op.op });
      if (op.idem) db.prepare('INSERT OR IGNORE INTO idem (key, result, at) VALUES (?, ?, ?)').run(op.idem, result, Date.now());
      appendEvent(db, 'stock.' + op.op, { sku: op.sku, qty: op.qty, idem: op.idem || null, leaseId });
      applied.push(op.idem || null);
    }

    const v = bumpVersion(db);
    db.exec('COMMIT');
    return { ok: true, version: v, applied, replayed: ops.length - fresh.length };
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, code: 'internal', message: e.message };
  }
}

export function snapshot(db, since = 0) {
  const rows = db.prepare('SELECT seq, type, payload, at FROM events WHERE seq > ? ORDER BY seq LIMIT 500').all(Number(since) || 0);
  const stock = db.prepare('SELECT sku, on_hand FROM stock ORDER BY sku').all();
  return {
    version: version(db),
    cursor: rows.length ? rows[rows.length - 1].seq : Number(since) || 0,
    events: rows.map((r) => ({ seq: r.seq, type: r.type, data: JSON.parse(r.payload), at: r.at })),
    stock,
  };
}

export function catalogList(db) {
  return db.prepare('SELECT sku, name, price, status, updated_at FROM catalog ORDER BY sku').all();
}

/**
 * 下行读模型落库（云根权威）：整批写入商品/价格，有变化才写事件。
 * items: [{ sku, name, price, status: 'on'|'off'|'deleted', updatedAt }]
 * 返回 { applied, deleted, unchanged, version }
 */
export function applyCatalog(db, items, now = Date.now()) {
  let applied = 0;
  let deleted = 0;
  let unchanged = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const it of items || []) {
      const sku = String((it && it.sku) || '').trim();
      if (!sku) continue;
      const updatedAt = Number(it.updatedAt) || now;
      const row = db.prepare('SELECT name, price, status, updated_at FROM catalog WHERE sku = ?').get(sku);

      if (it.status === 'deleted') {
        if (!row) { unchanged++; continue; }
        db.prepare('DELETE FROM catalog WHERE sku = ?').run(sku);
        appendEvent(db, 'catalog.delete', { sku, updatedAt }, now);
        deleted++;
        continue;
      }

      const price = Number(it.price);
      if (!Number.isFinite(price)) continue;
      const status = it.status === 'off' ? 'off' : 'on';
      const name = String(it.name ?? '');

      // 幂等：同一份内容重复下发不重复写事件（避免把事件流刷满）
      if (row && row.name === name && row.price === price && row.status === status && row.updated_at >= updatedAt) {
        unchanged++;
        continue;
      }
      if (row) db.prepare('UPDATE catalog SET name = ?, price = ?, status = ?, updated_at = ? WHERE sku = ?').run(name, price, status, updatedAt, sku);
      else db.prepare('INSERT INTO catalog (sku, name, price, status, updated_at) VALUES (?, ?, ?, ?, ?)').run(sku, name, price, status, updatedAt);
      appendEvent(db, 'catalog.upsert', { sku, name, price, status, updatedAt }, now);
      applied++;
    }

    const v = applied + deleted > 0 ? bumpVersion(db) : version(db);
    db.exec('COMMIT');
    return { applied, deleted, unchanged, version: v };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
