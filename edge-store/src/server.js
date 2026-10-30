// 店根 HTTP 服务：契约 §店根 API（/edge/health /edge/lease /edge/commit /edge/snapshot）
// 无第三方依赖，默认监听 0.0.0.0:7321（门店局域网），通过 EDGE_TOKEN 做最小鉴权。
import { createServer } from 'node:http';
import { openDb, createLease, aliveLeases, commit, snapshot, metaGet, metaSet, version } from './db.js';

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

      return json(res, 404, { ok: false, code: 'not_found' });
    } catch (e) {
      return json(res, 400, { ok: false, code: 'bad_request', message: e.message });
    }
  });

  return { server, db, close: () => new Promise((r) => server.close(() => { try { db.close(); } catch (e) {} r(); })) };
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const app = createEdge({ dbPath: process.env.EDGE_DB || './edge.db' });
  app.server.listen(PORT, HOST, () => {
    console.log(`[edge-store] listening http://${HOST}:${PORT} store=${STORE_ID} token=${TOKEN ? 'on' : 'off'}`);
  });
}
