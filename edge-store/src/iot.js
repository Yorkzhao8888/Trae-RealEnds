// IoT 数据面：设备台账 + 最新值 + 事件流。
// 只读采集：网关推数据进来，店根只负责落库与查询，不提供控制/回执闭环。
import { metaGet, metaSet } from './db.js';

const DEFAULT_STALE_MS = 60 * 1000;
const GATEWAY_STALE_MS = 90 * 1000;
const QUALITY = new Set(['good', 'degraded', 'stale', 'unknown']);
const EVENTS_MAX = 500;
const SERIES_MAX = 1000;

function jsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

function staleMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1000 && n <= 24 * 60 * 60 * 1000 ? Math.trunc(n) : null;
}

function finiteAt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

// 网关存活单独记账：设备可能在线但网关进程已挂，运维要先看网关。
function touchGateway(db, id, seen, version, meta) {
  const key = typeof id === 'string' ? id.trim() : '';
  if (!key || key.length > 128) return false;
  const row = db.prepare('SELECT * FROM iot_gateway WHERE id = ?').get(key);
  const ver = typeof version === 'string' ? version : '';
  const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? JSON.stringify(meta) : null;
  if (!row) {
    db.prepare('INSERT INTO iot_gateway (id, last_seen, version, meta) VALUES (?, ?, ?, ?)')
      .run(key, seen, ver, m || '{}');
  } else {
    db.prepare('UPDATE iot_gateway SET last_seen = MAX(last_seen, ?), version = ?, meta = ? WHERE id = ?')
      .run(seen, ver || row.version, m || row.meta, key);
  }
  return true;
}

function eventRow(row) {
  return {
    v: 1,
    deviceId: row.device_id,
    kind: row.kind,
    metric: row.metric,
    value: jsonParse(row.value, null),
    unit: row.unit ?? null,
    at: row.at,
    seq: row.seq,
    idem: row.idem,
    quality: row.quality,
    source: row.source,
  };
}

function effectiveStatus(row, now) {
  if (row.status === 'offline') return 'offline';
  return now - row.last_seen > row.stale_after_ms ? 'stale' : 'online';
}

// 旧值不能冒充在线：超期一律标 stale，而不是继续沿用最后一次 quality
function effectiveQuality(quality, at, deviceStaleMs, now) {
  if (now - at > deviceStaleMs) return 'stale';
  return quality;
}

function upsertDevice(db, d, at) {
  const id = typeof d.id === 'string' ? d.id.trim() : '';
  if (!id || id.length > 128) return false;

  const row = db.prepare('SELECT * FROM iot_device WHERE id = ?').get(id);
  const old = row
    ? {
        kind: row.kind,
        transport: row.transport,
        name: row.name,
        status: row.status,
        capabilities: row.capabilities,
        profile: row.profile,
        source: row.source,
        staleAfterMs: row.stale_after_ms,
        meta: row.meta,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
      }
    : {
        kind: 'device',
        transport: 'unknown',
        name: '',
        status: 'online',
        capabilities: '[]',
        profile: '',
        source: '',
        staleAfterMs: DEFAULT_STALE_MS,
        meta: '{}',
        firstSeen: at,
        lastSeen: 0,
      };

  const kind = typeof d.kind === 'string' && d.kind ? d.kind : old.kind;
  const transport = typeof d.transport === 'string' && d.transport ? d.transport : old.transport;
  const name = typeof d.name === 'string' && d.name ? d.name : old.name;
  const status = d.status === 'offline' ? 'offline' : d.status === 'online' ? 'online' : old.status;
  const profile = typeof d.profile === 'string' && d.profile ? d.profile : old.profile;
  const source = typeof d.source === 'string' && d.source ? d.source : old.source;
  const stale = staleMs(d.staleAfterMs) ?? old.staleAfterMs;
  const caps = Array.isArray(d.capabilities)
    ? JSON.stringify(d.capabilities.filter((x) => typeof x === 'string').slice(0, 64))
    : old.capabilities;
  const meta = d.meta && typeof d.meta === 'object' && !Array.isArray(d.meta)
    ? JSON.stringify({ ...(jsonParse(old.meta, {}) || {}), ...d.meta })
    : old.meta;
  const seen = Math.max(old.lastSeen, finiteAt(d.lastSeen, at));

  if (row) {
    db.prepare(`UPDATE iot_device SET kind = ?, transport = ?, name = ?, status = ?, capabilities = ?, profile = ?, source = ?, stale_after_ms = ?, meta = ?, last_seen = ? WHERE id = ?`)
      .run(kind, transport, name, status, caps, profile, source, stale, meta, seen, id);
  } else {
    db.prepare(`INSERT INTO iot_device (id, kind, transport, name, status, capabilities, profile, source, stale_after_ms, meta, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, kind, transport, name, status, caps, profile, source, stale, meta, at, seen);
  }
  return true;
}

export function applyDevices(db, devices, at = Date.now()) {
  let applied = 0;
  let skipped = 0;
  for (const d of devices || []) {
    if (d && typeof d === 'object' && upsertDevice(db, d, at)) applied++;
    else skipped++;
  }
  return { applied, skipped };
}

function checkEvent(e, i) {
  if (!e || typeof e !== 'object') return { index: i, field: 'event' };
  if (typeof e.deviceId !== 'string' || !e.deviceId.trim()) return { index: i, field: 'deviceId' };
  if (typeof e.metric !== 'string' || !e.metric.trim()) return { index: i, field: 'metric' };
  if (typeof e.idem !== 'string' || !e.idem.trim()) return { index: i, field: 'idem' };
  return null;
}

/**
 * 批量写入：设备台账 + 事件。整批一个事务，idem 重复只计 replayed 不重复落库。
 * body: { gatewayId, devices?, events: [envelope v1] }
 */
export function ingest(db, body = {}, now = Date.now()) {
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) return { ok: false, code: 'events_required' };

  for (let i = 0; i < events.length; i++) {
    const bad = checkEvent(events[i], i);
    if (bad) return { ok: false, code: 'bad_event', ...bad };
  }

  const gatewayId = typeof body.gatewayId === 'string' ? body.gatewayId.trim() : '';
  const devices = Array.isArray(body.devices) ? body.devices : [];

  db.exec('BEGIN IMMEDIATE');
  try {
    if (devices.length) applyDevices(db, devices, now);

    let applied = 0;
    let replayed = 0;
    let cursor = Number(metaGet(db, 'iotSeq') || 0);

    for (const e of events) {
      const deviceId = e.deviceId.trim();
      // 没有设备台账的事件也补一条最小记录，避免详情页 404
      if (!db.prepare('SELECT 1 FROM iot_device WHERE id = ?').get(deviceId)) {
        upsertDevice(db, { id: deviceId, kind: 'device', status: 'online' }, now);
      }
      // 事件到达说明设备仍在活动；用接收时间而不是事件时间，避免补历史的旧数据假装在线
      db.prepare('UPDATE iot_device SET last_seen = MAX(last_seen, ?) WHERE id = ?').run(now, deviceId);

      const at = finiteAt(e.at, now);
      const quality = QUALITY.has(e.quality) ? e.quality : 'unknown';
      const source = typeof e.source === 'string' && e.source ? e.source : gatewayId || 'unknown';
      const unit = typeof e.unit === 'string' ? e.unit : null;
      const value = JSON.stringify(e.value === undefined ? null : e.value);
      // 跨网关的 idem 可能撞车，落库键带上网关标识
      const idem = (gatewayId ? gatewayId + ':' : '') + e.idem.trim();

      const info = db.prepare(`INSERT OR IGNORE INTO iot_event (device_id, kind, metric, value, unit, at, received_at, quality, source, idem)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(deviceId, typeof e.kind === 'string' && e.kind ? e.kind : 'telemetry', e.metric.trim(), value, unit, at, now, quality, source, idem);

      if (!info.changes) { replayed++; continue; }

      applied++;
      cursor = Number(info.lastInsertRowid);
      db.prepare(`INSERT INTO iot_metric_latest (device_id, metric, value, unit, at, quality, seq)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id, metric) DO UPDATE SET
          value = excluded.value, unit = excluded.unit, at = excluded.at, quality = excluded.quality, seq = excluded.seq
        WHERE excluded.at >= iot_metric_latest.at`)
        .run(deviceId, e.metric.trim(), value, unit, at, quality, cursor);
    }

    metaSet(db, 'iotSeq', cursor);
    metaSet(db, 'iotIngestAt', now);
    // 没走心跳的旧网关也能在运维面出现；心跳随后会补上 version 与计数。
    if (gatewayId) touchGateway(db, gatewayId, now, body.gateway?.version, body.gateway);
    db.exec('COMMIT');
    return { ok: true, applied, replayed, cursor, devices: devices.length };
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, code: 'internal', message: e.message };
  }
}

/** 心跳：只更新设备台账与网关存活时间，不产生事件。 */
export function heartbeat(db, body = {}, now = Date.now()) {
  const devices = body.devices;
  if (devices !== undefined && !Array.isArray(devices)) return { ok: false, code: 'bad_devices' };
  if (body.gateway !== undefined && (typeof body.gateway !== 'object' || Array.isArray(body.gateway))) {
    return { ok: false, code: 'bad_gateway' };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const r = applyDevices(db, devices || [], now);
    const gatewayId = typeof body.gatewayId === 'string' ? body.gatewayId.trim() : '';
    const gateway = body.gateway || null;
    if (gatewayId) {
      const meta = gateway ? { ...gateway, at: now } : null;
      touchGateway(db, gatewayId, now, gateway && gateway.version, meta);
    }
    db.exec('COMMIT');
    return { ok: true, devices: r.applied, skipped: r.skipped, at: now, gateway: gatewayId || null };
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, code: 'internal', message: e.message };
  }
}

/** 网关运维读模型：最后心跳、版本、积压/失败计数、名下设备在线数。 */
export function listGateways(db, now = Date.now(), { staleAfterMs = GATEWAY_STALE_MS } = {}) {
  const gateways = db.prepare('SELECT * FROM iot_gateway ORDER BY id').all();
  const devices = db.prepare('SELECT source, status, last_seen, stale_after_ms FROM iot_device').all();
  const counts = new Map();
  for (const d of devices) {
    if (!d.source) continue;
    if (!counts.has(d.source)) counts.set(d.source, { devices: 0, onlineDevices: 0 });
    const c = counts.get(d.source);
    c.devices++;
    if (d.status !== 'offline' && now - d.last_seen <= d.stale_after_ms) c.onlineDevices++;
  }

  const ms = Math.min(Math.max(Number(staleAfterMs) || GATEWAY_STALE_MS, 1000), 24 * 60 * 60 * 1000);
  return {
    at: now,
    staleAfterMs: ms,
    gateways: gateways.map((g) => {
      const c = counts.get(g.id) || { devices: 0, onlineDevices: 0 };
      return {
        id: g.id,
        lastSeen: g.last_seen,
        online: now - g.last_seen <= ms,
        version: g.version || '',
        meta: jsonParse(g.meta, {}),
        devices: c.devices,
        onlineDevices: c.onlineDevices,
      };
    }),
  };
}

export function listDevices(db, now = Date.now()) {
  const rows = db.prepare('SELECT * FROM iot_device ORDER BY id').all();
  const metrics = db.prepare('SELECT * FROM iot_metric_latest ORDER BY device_id, metric').all();

  const staleByDevice = new Map(rows.map((r) => [r.id, r.stale_after_ms]));
  const byDevice = new Map();
  for (const m of metrics) {
    if (!byDevice.has(m.device_id)) byDevice.set(m.device_id, {});
    byDevice.get(m.device_id)[m.metric] = {
      value: jsonParse(m.value, null),
      unit: m.unit ?? null,
      at: m.at,
      quality: effectiveQuality(m.quality, m.at, staleByDevice.get(m.device_id) || DEFAULT_STALE_MS, now),
      seq: m.seq,
    };
  }

  return {
    at: now,
    devices: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      transport: r.transport,
      name: r.name,
      status: effectiveStatus(r, now),
      profile: r.profile,
      source: r.source,
      capabilities: jsonParse(r.capabilities, []),
      staleAfterMs: r.stale_after_ms,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      metrics: byDevice.get(r.id) || {},
    })),
  };
}

export function getDevice(db, id, now = Date.now(), { eventLimit = 50 } = {}) {
  const row = db.prepare('SELECT * FROM iot_device WHERE id = ?').get(id);
  if (!row) return null;

  const found = listDevices(db, now).devices.find((d) => d.id === id);
  const limit = Math.min(Math.max(Number(eventLimit) || 50, 1), 200);
  const events = db.prepare('SELECT * FROM iot_event WHERE device_id = ? ORDER BY seq DESC LIMIT ?')
    .all(id, limit)
    .map(eventRow)
    .reverse();

  return { device: found, events };
}

export function series(db, id, { metric, since = 0, limit = 200 } = {}, now = Date.now()) {
  if (typeof metric !== 'string' || !metric) return { ok: false, code: 'metric_required' };
  if (!db.prepare('SELECT 1 FROM iot_device WHERE id = ?').get(id)) return { ok: false, code: 'device_not_found' };

  const from = finiteAt(since, 0);
  const cap = Math.min(Math.max(Number(limit) || 200, 1), SERIES_MAX);
  const rows = db.prepare('SELECT * FROM iot_event WHERE device_id = ? AND metric = ? AND at >= ? ORDER BY at ASC, seq ASC LIMIT ?')
    .all(id, metric, from, cap);

  const stale = db.prepare('SELECT stale_after_ms FROM iot_device WHERE id = ?').get(id).stale_after_ms;
  return {
    ok: true,
    deviceId: id,
    metric,
    since: from,
    points: rows.map((r) => ({
      at: r.at,
      value: jsonParse(r.value, null),
      unit: r.unit ?? null,
      seq: r.seq,
      quality: effectiveQuality(r.quality, r.at, stale, now),
    })),
    cursor: rows.length ? rows[rows.length - 1].seq : null,
  };
}

export function eventsSince(db, since = 0, limit = EVENTS_MAX, now = Date.now()) {
  const from = Math.min(Math.max(Number(since) || 0, 0), Number.MAX_SAFE_INTEGER);
  const cap = Math.min(Math.max(Number(limit) || EVENTS_MAX, 1), EVENTS_MAX);
  const rows = db.prepare('SELECT * FROM iot_event WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(from, cap);
  return {
    cursor: rows.length ? rows[rows.length - 1].seq : from,
    events: rows.map(eventRow),
    at: now,
  };
}

/**
 * 长轮询：有增量立即返回；没有就等到有新事件或超时。
 * 用店根进程内的 bus 唤醒，避免高频短轮询把 SQLite 打满。
 */
export function waitForEvents(db, { since = 0, timeoutMs = 25000, bus, signal } = {}) {
  const from = Math.min(Math.max(Number(since) || 0, 0), Number.MAX_SAFE_INTEGER);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bus?.removeListener('events', onEvents);
      signal?.removeEventListener('abort', onAbort);
      const r = eventsSince(db, from);
      resolve({ ...r, timedOut: r.events.length === 0 });
    }
    function onEvents() { finish(); }
    function onAbort() { finish(); }

    // 先挂监听再查库，避免「查完到挂监听」之间插入的事件被漏掉
    bus?.on('events', onEvents);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(finish, Math.min(Math.max(Number(timeoutMs) || 0, 0), 30000));
    timer.unref?.();

    const r = eventsSince(db, from);
    if (r.events.length) finish();
  });
}
