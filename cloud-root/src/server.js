// 云根参考实现（HTTP）：上行事件幂等接收 + 下行商品读模型 + 最小管理接口。
// 契约见 docs/shell-contract.md §10；与 edge-store 对接时它就是"云根应答方"。
import { createServer } from 'node:http';
import { openDb, applyEvents, catalogSince, upsertCatalog, setStock, listEvents } from './db.js';
import { upsertTenant, entitlements, activate, deactivate, addStore, removeStore } from './store.js';

const PORT = Number(process.env.CLOUD_PORT || 7331);
const HOST = process.env.CLOUD_HOST || '0.0.0.0';
const TOKEN = process.env.CLOUD_TOKEN || '';
const ADMIN_TOKEN = process.env.CLOUD_ADMIN_TOKEN || '';

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

export function createCloud({ dbPath = ':memory:', token = TOKEN, adminToken = ADMIN_TOKEN } = {}) {
  const db = openDb(dbPath);

  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  // 身份解析：生产替换为 OAS（oas_mother）的 userinfo/introspect；
  // 参考实现用 `dev:<tenantId>`，不新建账号体系。
  const tenantOf = (req) => {
    const m = bearer(req).match(/^dev:([A-Za-z0-9_-]+)$/);
    return m ? m[1] : null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://cloud');
    const path = url.pathname;

    if (token && path.startsWith('/cloud/')) {
      if (bearer(req) !== token) return json(res, 401, { ok: false, code: 'unauthorized' });
    }

    try {
      // ── 商店 M1：授权与租户 ─────────────────────────────
      if (req.method === 'GET' && path === '/store/entitlements') {
        const tid = tenantOf(req);
        if (!tid) return json(res, 401, { ok: false, code: 'unauthorized' });
        const e = entitlements(db, tid);
        if (!e) return json(res, 404, { ok: false, code: 'tenant_unknown' });
        return json(res, 200, { ok: true, ...e });
      }

      if (req.method === 'POST' && path === '/store/activate') {
        const tid = tenantOf(req);
        if (!tid) return json(res, 401, { ok: false, code: 'unauthorized' });
        const body = await readBody(req);
        const r = activate(db, tid, { deviceId: body.deviceId, platform: body.platform });
        return json(res, r.ok ? 200 : r.code === 'tenant_unknown' ? 404 : 409, r);
      }

      if (req.method === 'POST' && path === '/store/deactivate') {
        const tid = tenantOf(req);
        if (!tid) return json(res, 401, { ok: false, code: 'unauthorized' });
        const body = await readBody(req);
        const r = deactivate(db, tid, body.deviceId);
        return json(res, r.ok ? 200 : 404, r);
      }

      if (req.method === 'POST' && path === '/store/stores') {
        const tid = tenantOf(req);
        if (!tid) return json(res, 401, { ok: false, code: 'unauthorized' });
        const body = await readBody(req);
        const r = addStore(db, tid, { storeId: body.storeId, name: body.name });
        return json(res, r.ok ? 200 : r.code === 'tenant_unknown' ? 404 : 409, r);
      }

      const delStore = path.match(/^\/store\/stores\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'DELETE' && delStore) {
        const tid = tenantOf(req);
        if (!tid) return json(res, 401, { ok: false, code: 'unauthorized' });
        const r = removeStore(db, tid, delStore[1]);
        return json(res, r.ok ? 200 : 404, r);
      }

      // 管理：建租户 + 配额 + 授权品牌（运营侧）
      const putTenant = path.match(/^\/store\/tenants\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'PUT' && putTenant) {
        if (!adminToken || bearer(req) !== adminToken) return json(res, 403, { ok: false, code: 'admin_only' });
        const body = await readBody(req);
        const t = upsertTenant(db, { ...body, id: putTenant[1] });
        if (!t) return json(res, 400, { ok: false, code: 'bad_request' });
        return json(res, 200, { ok: true, tenant: t });
      }
      // ──────────────────────────────────────────────────

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
