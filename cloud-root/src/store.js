// 商店 M1：授权与租户（座位数、许可下发、门店数）。
// 身份不在这里建：租户 ID 来自 OAS（`oas_mother`）。参考实现里用 `dev:<tenantId>`
// 这个令牌形式模拟"OAS 校验通过后拿到的租户"，生产由 OAS 的 userinfo/introspect 替换。
function now() { return Date.now(); }

function tenantRow(db, id) {
  return db.prepare('SELECT id, name, plan, seats, stores, expires, at FROM tenants WHERE id = ?').get(id);
}

function expired(t) {
  return t.expires > 0 && t.expires < now();
}

function activeSeats(db, tenantId) {
  return db.prepare('SELECT COUNT(*) AS n FROM activations WHERE tenant_id = ? AND revoked_at IS NULL').get(tenantId).n;
}

export function upsertTenant(db, t) {
  const id = String((t && t.id) || '').trim();
  if (!id) return null;
  const tpl = { id, name: String(t.name || id), plan: String(t.plan || 'starter'), seats: Number(t.seats) || 5, stores: Number(t.stores) || 1, expires: Number(t.expires) || 0 };
  if (tenantRow(db, id)) {
    db.prepare('UPDATE tenants SET name = ?, plan = ?, seats = ?, stores = ?, expires = ? WHERE id = ?')
      .run(tpl.name, tpl.plan, tpl.seats, tpl.stores, tpl.expires, id);
  } else {
    db.prepare('INSERT INTO tenants (id, name, plan, seats, stores, expires, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, tpl.name, tpl.plan, tpl.seats, tpl.stores, tpl.expires, now());
  }
  if (Array.isArray(t.brands)) {
    db.prepare('DELETE FROM grants WHERE tenant_id = ?').run(id);
    for (const g of t.brands) {
      const brand = String((g && g.brand) || '').trim();
      if (!brand) continue;
      db.prepare('INSERT INTO grants (tenant_id, brand, ends, at) VALUES (?, ?, ?, ?)')
        .run(id, brand, JSON.stringify(Array.isArray(g.ends) ? g.ends : []), now());
    }
  }
  return tenantRow(db, id);
}

/** 许可总览：座位/门店配额、已授权品牌与端、有效期、是否过期。 */
export function entitlements(db, tenantId) {
  const t = tenantRow(db, tenantId);
  if (!t) return null;
  const seats = Number(t.seats);
  const stores = Number(t.stores);
  const usedSeats = activeSeats(db, tenantId);
  const usedStores = db.prepare('SELECT COUNT(*) AS n FROM stores WHERE tenant_id = ?').get(tenantId).n;
  const brands = db.prepare('SELECT brand, ends FROM grants WHERE tenant_id = ? ORDER BY brand').all(tenantId)
    .map((r) => ({ brand: r.brand, ends: JSON.parse(r.ends) }));
  return {
    tenant: { id: t.id, name: t.name, plan: t.plan, expires: t.expires },
    expired: expired(t),
    seats: { total: seats, used: usedSeats, free: Math.max(0, seats - usedSeats) },
    stores: { total: stores, used: usedStores, free: Math.max(0, stores - usedStores) },
    brands,
  };
}

/** 设备激活占座。同设备重复激活是幂等的，不重复占位。 */
export function activate(db, tenantId, { deviceId, platform = '' } = {}) {
  const t = tenantRow(db, tenantId);
  if (!t) return { ok: false, code: 'tenant_unknown' };
  if (expired(t)) return { ok: false, code: 'expired' };

  const id = String(deviceId || '').trim();
  if (!id) return { ok: false, code: 'bad_device' };

  const cur = db.prepare('SELECT revoked_at FROM activations WHERE tenant_id = ? AND device_id = ?').get(tenantId, id);
  if (cur && cur.revoked_at === null) {
    return { ok: true, replayed: true, deviceId: id, seats: entitlements(db, tenantId).seats };
  }

  const used = activeSeats(db, tenantId);
  if (used >= Number(t.seats)) return { ok: false, code: 'seat_exhausted', used, seats: Number(t.seats) };

  if (cur) db.prepare('UPDATE activations SET revoked_at = NULL, at = ? WHERE tenant_id = ? AND device_id = ?').run(now(), tenantId, id);
  else db.prepare('INSERT INTO activations (tenant_id, device_id, platform, at) VALUES (?, ?, ?, ?)').run(tenantId, id, String(platform), now());

  return { ok: true, replayed: false, deviceId: id, seats: entitlements(db, tenantId).seats };
}

/** 退座：释放一个座位，后续可再激活。 */
export function deactivate(db, tenantId, deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return { ok: false, code: 'bad_device' };
  const cur = db.prepare('SELECT revoked_at FROM activations WHERE tenant_id = ? AND device_id = ?').get(tenantId, id);
  if (!cur) return { ok: false, code: 'not_found' };
  if (cur.revoked_at !== null) return { ok: true, replayed: true, seats: entitlements(db, tenantId).seats };
  db.prepare('UPDATE activations SET revoked_at = ? WHERE tenant_id = ? AND device_id = ?').run(now(), tenantId, id);
  return { ok: true, replayed: false, seats: entitlements(db, tenantId).seats };
}

/** 门店注册：受门店配额约束（M1 的"门店数"）。 */
export function addStore(db, tenantId, { storeId, name = '' } = {}) {
  const t = tenantRow(db, tenantId);
  if (!t) return { ok: false, code: 'tenant_unknown' };
  if (expired(t)) return { ok: false, code: 'expired' };

  const id = String(storeId || '').trim();
  if (!id) return { ok: false, code: 'bad_store' };

  const cur = db.prepare('SELECT name FROM stores WHERE tenant_id = ? AND store_id = ?').get(tenantId, id);
  if (cur) {
    if (name) db.prepare('UPDATE stores SET name = ? WHERE tenant_id = ? AND store_id = ?').run(String(name), tenantId, id);
    return { ok: true, replayed: true, stores: entitlements(db, tenantId).stores };
  }

  const used = Number(entitlements(db, tenantId).stores.used);
  if (used >= Number(t.stores)) return { ok: false, code: 'store_quota', used, stores: Number(t.stores) };

  db.prepare('INSERT INTO stores (tenant_id, store_id, name, at) VALUES (?, ?, ?, ?)').run(tenantId, id, String(name), now());
  return { ok: true, replayed: false, stores: entitlements(db, tenantId).stores };
}

export function removeStore(db, tenantId, storeId) {
  const id = String(storeId || '').trim();
  const info = db.prepare('DELETE FROM stores WHERE tenant_id = ? AND store_id = ?').run(tenantId, id);
  if (!info.changes) return { ok: false, code: 'not_found' };
  return { ok: true, stores: entitlements(db, tenantId).stores };
}
