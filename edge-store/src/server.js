// 店根 HTTP 服务：契约 §店根 API（/edge/health /edge/lease /edge/commit /edge/snapshot）
// 无第三方依赖，默认监听 0.0.0.0:7321（门店局域网），通过 EDGE_TOKEN 做最小鉴权。
import { createServer } from 'node:http';
import { openDb, createLease, aliveLeases, commit, snapshot, metaGet, metaSet, version } from './db.js';
import { syncOnce, openConflicts, resolveConflict, pending } from './sync.js';

const PORT = Number(process.env.EDGE_PORT || 7321);
const HOST = process.env.EDGE_HOST || '0.0.0.0';
const TOKEN = process.env.EDGE_TOKEN || '';
const STORE_ID = process.env.EDGE_STORE_ID || 'store-local';
const LEASE_TTL = Number(process.env.EDGE_LEASE_TTL_MS || 15 * 60 * 1000);
const MAX_QTY = Number(process.env.EDGE_MAX_QTY || 20);

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) return reject(new Error('payload too large'));
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function createEdge({ dbPath = ':memory:', token = TOKEN, storeId = STORE_ID } = {}) {
  const db = openDb(dbPath);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://edge');
    const path = url.pathname;

    if (token) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (got !== token) return json(res, 401, { ok: false, code: 'unauthorized' });
    }

    try {
      if (req.method === 'GET' && path === '/edge/health') {
        return json(res, 200, {
          ok: true,
          storeId,
          version: version(db),
          cloudOffline: metaGet(db, 'cloudOffline') === '1',
          leases: aliveLeases(db),
          outbox: pending(db).rows.length,
          conflicts: openConflicts(db).length,
          at: Date.now(),
        });
      }

      if (req.method === 'POST' && path === '/edge/lease') {
        const body = await readBody(req);
        if (!body.deviceId) return json(res, 400, { ok: false, code: 'bad_request' });
        const ttl = Math.min(Number(body.ttlMs) || LEASE_TTL, 60 * 60 * 1000);
        const lease = createLease(db, String(body.deviceId), ttl);
        return json(res, 200, {
          ok: true,
          leaseId: lease.id,
          ttl: lease.ttl,
          expires: lease.expires,
          limits: { maxQty: MAX_QTY, currency: 'CNY' },
          cloudOffline: metaGet(db, 'cloudOffline') === '1',
        });
      }

      if (req.method === 'POST' && path === '/edge/commit') {
        const body = await readBody(req);
        if (!body.leaseId || !Array.isArray(body.ops) || !body.ops.length) {
          return json(res, 400, { ok: false, code: 'bad_request' });
        }
        const over = body.ops.find((o) => Number(o.qty) > MAX_QTY);
        if (over) return json(res, 409, { ok: false, code: 'limit', sku: over.sku, maxQty: MAX_QTY });

        const r = commit(db, { leaseId: body.leaseId, ops: body.ops });
        if (!r.ok) {
          const code = r.code === 'stock' ? 409 : r.code === 'lease_expired' || r.code === 'lease_unknown' ? 409 : 400;
          return json(res, code, r);
        }
        return json(res, 200, r);
      }

      if (req.method === 'GET' && path === '/edge/snapshot') {
        return json(res, 200, snapshot(db, url.searchParams.get('since') || 0));
      }

      // 云根连通性由外部探针写入（店根不主动出网，避免门店网络抖动放大）
      if (req.method === 'POST' && path === '/edge/cloud') {
        const body = await readBody(req);
        metaSet(db, 'cloudOffline', body.offline ? '1' : '0');
        return json(res, 200, { ok: true, cloudOffline: !!body.offline });
      }

      // 待回传事件（游标之后的批次）
      if (req.method === 'GET' && path === '/edge/outbox') {
        const p = pending(db);
        return json(res, 200, {
          ok: true,
          since: p.since,
          count: p.rows.length,
          events: p.rows.map((r) => ({ seq: r.seq, type: r.type, at: r.at })),
        });
      }

      // 触发一次回传：body 可覆盖云根地址与凭据
      if (req.method === 'POST' && path === '/edge/sync') {
        const body = await readBody(req);
        const cloudUrl = body.cloudUrl || process.env.EDGE_CLOUD_URL || '';
        const cloudToken = body.token || process.env.EDGE_CLOUD_TOKEN || '';
        if (!cloudUrl) return json(res, 400, { ok: false, code: 'cloud_not_configured' });

        const r = await syncOnce(db, async (payload) => {
          const resp = await fetch(cloudUrl.replace(/\/$/, '') + '/cloud/events', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(cloudToken ? { authorization: 'Bearer ' + cloudToken } : {}),
            },
            body: JSON.stringify(payload),
          });
          let rb = null;
          try { rb = await resp.json(); } catch (e) {}
          return { status: resp.status, body: rb };
        });
        return json(res, r.ok ? 200 : r.conflict ? 409 : 502, r);
      }

      if (req.method === 'GET' && path === '/edge/conflicts') {
        return json(res, 200, { ok: true, conflicts: openConflicts(db) });
      }

      const m = path.match(/^\/edge\/conflicts\/(\d+)\/resolve$/);
      if (req.method === 'POST' && m) {
        const body = await readBody(req);
        const r = resolveConflict(db, m[1], body.action);
        return json(res, r.ok ? 200 : 400, r);
      }

      return json(res, 404, { ok: false, code: 'not_found' });
    } catch (e) {
      return json(res, 400, { ok: false, code: 'bad_request', message: e.message });
    }
  });

  return {
    server,
    db,
    close: () => new Promise((r) => {
      server.closeAllConnections?.(); // 测试里 fetch 走 keep-alive，不清理会卡住 close
      server.close(() => { try { db.close(); } catch (e) {} r(); });
    }),
  };
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const app = createEdge({ dbPath: process.env.EDGE_DB || './edge.db' });
  app.server.listen(PORT, HOST, () => {
    console.log(`[edge-store] listening http://${HOST}:${PORT} store=${STORE_ID} token=${TOKEN ? 'on' : 'off'}`);
  });
}
