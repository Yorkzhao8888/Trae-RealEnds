// 云根参考实现（HTTP）：上行事件幂等接收 + 下行商品读模型 + 最小管理接口。
// 契约见 docs/shell-contract.md §10；与 edge-store 对接时它就是"云根应答方"。
import { createServer } from 'node:http';
import { openDb, applyEvents, catalogSince, upsertCatalog, setStock, listEvents } from './db.js';

const PORT = Number(process.env.CLOUD_PORT || 7331);
const HOST = process.env.CLOUD_HOST || '0.0.0.0';
const TOKEN = process.env.CLOUD_TOKEN || '';

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
      if (size > 512 * 1024) return reject(new Error('payload too large'));
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export function createCloud({ dbPath = ':memory:', token = TOKEN } = {}) {
  const db = openDb(dbPath);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://cloud');
    const path = url.pathname;

    if (token) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (got !== token) return json(res, 401, { ok: false, code: 'unauthorized' });
    }

    try {
      if (req.method === 'GET' && path === '/cloud/health') {
        return json(res, 200, { ok: true, role: 'cloud-root', stores: db.prepare('SELECT COUNT(DISTINCT store_id) AS n FROM cloud_events').get().n, at: Date.now() });
      }

      // 上行：店根按游标回传
      if (req.method === 'POST' && path === '/cloud/events') {
        const body = await readBody(req);
        if (!body.storeId || !Array.isArray(body.events)) return json(res, 400, { ok: false, code: 'bad_request' });

        const r = applyEvents(db, String(body.storeId), body.events);
        if (!r.ok) {
          return json(res, 409, {
            ok: false,
            code: 'conflict',
            seq: r.conflict.seq,
            reason: r.conflict.reason,
            ...(r.conflict.onHand !== undefined ? { onHand: r.conflict.onHand } : {}),
            applied: r.applied,
            replayed: r.replayed,
            cursor: r.cursor,
          });
        }
        return json(res, 200, { ok: true, applied: r.applied, replayed: r.replayed, cursor: r.cursor });
      }

      // 下行：商品/价格增量
      if (req.method === 'GET' && path === '/cloud/catalog') {
        const r = catalogSince(db, url.searchParams.get('since') || 0);
        return json(res, 200, { ok: true, ...r });
      }

      // 管理：批量写商品（部署/运营侧调用，非端壳）
      if (req.method === 'POST' && path === '/cloud/catalog') {
        const body = await readBody(req);
        const items = Array.isArray(body.items) ? body.items : [body];
        const n = upsertCatalog(db, items);
        return json(res, 200, { ok: true, written: n });
      }

      // 管理：设云根库存（对账基准）
      if (req.method === 'POST' && path === '/cloud/stock') {
        const body = await readBody(req);
        if (!setStock(db, body.sku, body.onHand)) return json(res, 400, { ok: false, code: 'bad_request' });
        return json(res, 200, { ok: true, sku: body.sku, onHand: Number(body.onHand) });
      }

      // 观测：某店已接收事件（调试用）
      if (req.method === 'GET' && path === '/cloud/events') {
        const storeId = url.searchParams.get('storeId');
        if (!storeId) return json(res, 400, { ok: false, code: 'bad_request' });
        return json(res, 200, { ok: true, events: listEvents(db, storeId, Number(url.searchParams.get('limit')) || 100) });
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
      server.closeAllConnections?.();
      server.close(() => { try { db.close(); } catch (e) {} r(); });
    }),
  };
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const app = createCloud({ dbPath: process.env.CLOUD_DB || './cloud.db' });
  app.server.listen(PORT, HOST, () => {
    console.log(`[cloud-root] listening http://${HOST}:${PORT} token=${TOKEN ? 'on' : 'off'}`);
  });
}
