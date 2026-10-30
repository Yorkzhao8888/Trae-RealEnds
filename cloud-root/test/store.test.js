// 商店 M1：租户配额、设备占座、门店数、过期拦截。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloud } from '../src/server.js';

async function boot() {
  const app = createCloud({ dbPath: ':memory:', token: 'ctk', adminToken: 'atk' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, path, body, tk = 'dev:t1') => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(tk ? { authorization: 'Bearer ' + tk } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const tenant = (body) => api('PUT', '/store/tenants/t1', body, 'atk');
  return { app, api, tenant };
}

test('无身份 401；非管理员不能建租户', async () => {
  const { app, api } = await boot();
  const r = await api('GET', '/store/entitlements', undefined, '');
  assert.equal(r.status, 401);

  const bad = await api('PUT', '/store/tenants/t1', { name: 'X' }, 'dev:t1');
  assert.equal(bad.status, 403);
  assert.equal(bad.body.code, 'admin_only');
  await app.close();
});

test('租户许可总览：配额、品牌与端', async () => {
  const { app, api, tenant } = await boot();
  const t = await tenant({ name: '测试租户', plan: 'pro', seats: 3, stores: 2, expires: 0, brands: [{ brand: 'ziway', ends: ['hp', 'cp'] }] });
  assert.equal(t.status, 200);

  const e = await api('GET', '/store/entitlements');
  assert.equal(e.status, 200);
  assert.equal(e.body.tenant.name, '测试租户');
  assert.equal(e.body.seats.total, 3);
  assert.equal(e.body.seats.used, 0);
  assert.equal(e.body.stores.total, 2);
  assert.equal(e.body.brands[0].brand, 'ziway');
  assert.deepEqual(e.body.brands[0].ends, ['hp', 'cp']);
  assert.equal(e.body.expired, false);

  const unknown = await api('GET', '/store/entitlements', undefined, 'dev:nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'tenant_unknown');
  await app.close();
});

test('设备占座：到上限 409，重复激活幂等，退座后可再占', async () => {
  const { app, api, tenant } = await boot();
  await tenant({ name: '座位租户', seats: 2, stores: 1 });

  const a1 = await api('POST', '/store/activate', { deviceId: 'd1', platform: 'ios' });
  const a2 = await api('POST', '/store/activate', { deviceId: 'd2', platform: 'android' });
  assert.equal(a1.status, 200);
  assert.equal(a2.status, 200);
  assert.equal(a2.body.seats.used, 2);

  const over = await api('POST', '/store/activate', { deviceId: 'd3', platform: 'mac' });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'seat_exhausted');

  const again = await api('POST', '/store/activate', { deviceId: 'd1' });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.seats.used, 2); // 不重复占位

  const off = await api('POST', '/store/deactivate', { deviceId: 'd2' });
  assert.equal(off.status, 200);
  assert.equal(off.body.seats.used, 1);

  const back = await api('POST', '/store/activate', { deviceId: 'd3' });
  assert.equal(back.status, 200);
  assert.equal(back.body.seats.used, 2);
  await app.close();
});

test('门店配额：到上限 409，删一家后可再加', async () => {
  const { app, api, tenant } = await boot();
  await tenant({ name: '门店租户', seats: 5, stores: 2 });

  await api('POST', '/store/stores', { storeId: 's1', name: '一号店' });
  await api('POST', '/store/stores', { storeId: 's2', name: '二号店' });

  const over = await api('POST', '/store/stores', { storeId: 's3', name: '三号店' });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'store_quota');

  const dup = await api('POST', '/store/stores', { storeId: 's1', name: '一号店' });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.replayed, true);
  assert.equal(dup.body.stores.used, 2);

  const del = await api('DELETE', '/store/stores/s2');
  assert.equal(del.status, 200);
  assert.equal(del.body.stores.used, 1);

  const ok = await api('POST', '/store/stores', { storeId: 's3' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stores.used, 2);
  await app.close();
});

test('租户过期：激活与建店都被拒', async () => {
  const { app, api, tenant } = await boot();
  await tenant({ name: '过期租户', seats: 3, stores: 2, expires: Date.now() - 1000 });

  const e = await api('GET', '/store/entitlements');
  assert.equal(e.body.expired, true);

  const act = await api('POST', '/store/activate', { deviceId: 'd1' });
  assert.equal(act.status, 409);
  assert.equal(act.body.code, 'expired');

  const st = await api('POST', '/store/stores', { storeId: 's1' });
  assert.equal(st.status, 409);
  assert.equal(st.body.code, 'expired');
  await app.close();
});
