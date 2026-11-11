// 物物边缘 worker：从 DyardOS（门店边缘盒子）只读取设备清单与事件。
// 只发 GET，不提供任何控制/执行入口；类型与单位仍由 gateway 按 profile 校验。
// 设备上报的是物理传输（serial/ble/mqtt/nfc/http），profile 匹配规则因此不用改。

const TRANSPORTS = ['serial', 'ble', 'mqtt', 'nfc', 'http'];
const QUALITY = ['good', 'degraded', 'stale', 'unknown'];

// DyardOS 原值透传 iot_protocol，映射由网关侧承担（契约 §5.1）。
const TRANSPORT_MAP = {
  serial: 'serial', rs232: 'serial', rs485: 'serial', can: 'serial', modbus: 'serial', 'modbus-rtu': 'serial',
  ble: 'ble', bluetooth: 'ble',
  mqtt: 'mqtt', zigbee: 'mqtt', z_wave: 'mqtt', zwave: 'mqtt', lora: 'mqtt', lorawan: 'mqtt',
  nfc: 'nfc', rfid: 'nfc',
  http: 'http', https: 'http', tcp: 'http', udp: 'http', wifi: 'http',
};

function transportOf(raw) {
  const v = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  return TRANSPORTS.includes(v) ? v : (TRANSPORT_MAP[v] || 'http');
}

function expand(value, env) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (env[name] === undefined) throw new Error(`missing_env:${name}`);
    return env[name];
  });
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function validateDyardConfig(config) {
  const errors = [];
  if (!isObj(config)) return { ok: false, errors: ['config_object_required'] };

  if (typeof config.baseUrl !== 'string' || !/^https?:\/\//.test(config.baseUrl)) {
    errors.push('baseUrl_http_required');
  }
  for (const k of ['devicesPath', 'tokenEnv']) {
    if (config[k] !== undefined && (typeof config[k] !== 'string' || !config[k])) errors.push(`${k}_string`);
  }
  // eventsPath 可为 null / false / 空串：表示 DyardOS 只提供名册，事件由硬件直采。
  const eventsOff = config.eventsPath === null || config.eventsPath === false || config.eventsPath === '';
  if (!eventsOff && config.eventsPath !== undefined && (typeof config.eventsPath !== 'string' || !config.eventsPath)) {
    errors.push('eventsPath_string_or_null');
  }
  const pollMs = Number(config.pollMs ?? 15000);
  if (!Number.isFinite(pollMs) || pollMs < 500 || pollMs > 86400000) errors.push('pollMs_500_86400000');
  const waitMs = Number(config.waitMs ?? 20000);
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 30000) errors.push('waitMs_0_30000');
  const timeoutMs = Number(config.timeoutMs ?? Math.max(waitMs + 5000, 10000));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000) errors.push('timeoutMs_500_60000');
  if (!eventsOff && timeoutMs <= waitMs) errors.push('timeoutMs_must_exceed_waitMs');
  const retryMs = Number(config.retryMs ?? 1000);
  if (!Number.isFinite(retryMs) || retryMs < 200 || retryMs > 60000) errors.push('retryMs_200_60000');

  if (config.headers !== undefined) {
    if (!isObj(config.headers)) errors.push('headers_object');
    else if (Object.values(config.headers).some((v) => typeof v !== 'string')) errors.push('headers_string');
  }

  if (config.devices !== undefined) {
    if (!Array.isArray(config.devices)) {
      errors.push('devices_array');
    } else {
      const ids = new Set();
      for (const d of config.devices) {
        if (!isObj(d) || typeof d.id !== 'string' || !d.id.trim()) { errors.push('device_id_required'); continue; }
        if (ids.has(d.id)) errors.push(`duplicate_device:${d.id}`);
        ids.add(d.id);
        if (d.transport !== undefined && !TRANSPORTS.includes(d.transport)) errors.push(`bad_transport:${d.id}`);
        if (d.profile !== undefined && typeof d.profile !== 'string') errors.push(`bad_profile:${d.id}`);
        if (d.staleAfterMs !== undefined && !Number.isInteger(d.staleAfterMs)) errors.push(`bad_staleAfterMs:${d.id}`);
        if (d.meta !== undefined && !isObj(d.meta)) errors.push(`bad_meta:${d.id}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

const PROFILE_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/;

// 对外业务键：契约 v0.1 起 `thing_code` 是稳定编号，UUID 只做内部主键，
// 因此店根设备 id 用 thing_code/code，UUID 落 meta.uuid，避免重建租户后历史断档。
function codeOf(raw) {
  for (const f of ['thing_code', 'code']) {
    if (typeof raw[f] === 'string' && raw[f].trim()) return raw[f].trim();
  }
  return '';
}

function keyOf(raw) {
  return codeOf(raw) || (raw.id === undefined || raw.id === null ? '' : String(raw.id));
}

function toDevice(raw, override = {}) {
  const merged = { ...raw, ...override };
  const meta = { ...(isObj(raw.meta) ? raw.meta : {}), ...(isObj(override.meta) ? override.meta : {}), source: 'dyard' };
  for (const f of ['vid', 'pid', 'model', 'manufacturer']) {
    const v = merged[f] !== undefined ? merged[f] : raw[f];
    if (v !== undefined) meta[f] = v;
  }
  for (const [from, to] of [['code', 'code'], ['role', 'role'], ['site', 'site'], ['last_seen_at', 'lastSeenAt'], ['parent_gateway_code', 'parentGateway']]) {
    if (raw[from] !== undefined) meta[to] = raw[from];
  }
  // 契约允许先由 metadata 承载 parent_gateway_code
  if (meta.parentGateway === undefined && isObj(raw.metadata) && raw.metadata.parent_gateway_code !== undefined) {
    meta.parentGateway = raw.metadata.parent_gateway_code;
  }
  // 契约 §3 已下发 site 对象；`current_node_*` 只在旧载荷里出现，一并兜底。
  if (raw.site === undefined && (raw.current_node_namespace !== undefined || raw.current_node_code !== undefined)) {
    meta.site = { namespace: raw.current_node_namespace, code: raw.current_node_code };
  }
  const code = codeOf(raw);
  if (code) meta.code = code;
  if (raw.id !== undefined && raw.id !== null && String(raw.id) !== code) meta.uuid = String(raw.id);
  if (override.lastSeenAt !== undefined) meta.lastSeenAt = override.lastSeenAt;

  // DyardOS 的 `model` 可能是 profile 标识（如 retail.gate.v1），也可能是硬件型号；
  // 契约 v0.1 起独立出 `profile` 字段，显式优先，`model` 仅作旧载荷兼容。
  const explicit = typeof merged.profile === 'string' && merged.profile ? merged.profile : '';
  const model = typeof merged.model === 'string' ? merged.model : '';
  const name = merged.name || code || String(merged.id || '');

  return {
    id: keyOf(merged),
    kind: merged.kind || (merged.role === 'IoT-GW' ? 'gateway' : undefined),
    transport: transportOf(merged.transport),
    name,
    status: merged.status === 'offline' || merged.online === false ? 'offline' : 'online',
    profile: explicit || (PROFILE_RE.test(model) ? model : ''),
    capabilities: Array.isArray(merged.capabilities) ? merged.capabilities.slice() : [],
    staleAfterMs: merged.staleAfterMs,
    meta,
  };
}

export function createDyardWorker(config, { env = process.env, fetchImpl = fetch, clock = Date.now } = {}) {
  const v = validateDyardConfig(config);
  if (!v.ok) throw new Error(`dyard_config_invalid: ${v.errors.join('; ')}`);

  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const devicesPath = config.devicesPath || '/api/dyardos/contract/readonly/devices';
  // null / false / 空串 = 只做名册；事件由硬件直连线，不经过 DyardOS。
  const eventsPath = config.eventsPath === null || config.eventsPath === false || config.eventsPath === ''
    ? null
    : (config.eventsPath || '/dyard/events');
  const waitMs = Number(config.waitMs ?? 20000);
  const timeoutMs = Number(config.timeoutMs ?? Math.max(waitMs + 5000, 10000));
  const retryMs = Number(config.retryMs ?? 1000);
  const pollMs = Number(config.pollMs ?? 15000);
  const overrides = new Map((config.devices || []).map((d) => [d.id, d]));

  const known = new Set();
  // 名册增量：since 取结果集最大 updated_at（或响应里的 cursor），ETag 命中 304 直接复用上次结果。
  let rosterSince = null;
  let rosterEtag = null;
  const roster = new Map();
  // 事件里可能用 UUID 或 thing_code 指设备，两者都映射回店根设备 id。
  const aliases = new Map();
  // 已归档设备：保留在名册里并以下发 `archived: true` 的方式通知网关清缓存。
  const archivedIds = new Set();
  let cursor = null;
  let busy = false;
  let stopped = false;

  const stats = {
    polls: 0,
    events: 0,
    errors: 0,
    filtered: 0,
    skipped: 0,
    archived: 0,
    lastPollAt: 0,
    lastDeviceSyncAt: 0,
    lastError: null,
    lastDeviceError: null,
  };

  // 头名统一小写，避免配置里同时出现 `Authorization` 与 tokenEnv 生成两份同名头。
  function headers() {
    const out = { accept: 'application/json' };
    for (const [k, val] of Object.entries(config.headers || {})) out[String(k).toLowerCase()] = expand(val, env);
    if (config.tokenEnv && !out.authorization) {
      const token = env[config.tokenEnv];
      if (!token) throw new Error(`missing_env:${config.tokenEnv}`);
      out.authorization = `Bearer ${token}`;
    }
    return out;
  }

  // 只读：这里只允许 GET，任何控制/写入都不经过这个 worker。
  async function get(url, extraHeaders = {}) {
    return fetchImpl(url, {
      method: 'GET',
      headers: { ...headers(), ...extraHeaders },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function getJson(url) {
    const res = await get(url);
    if (!res.ok) throw new Error(`http_${res.status}`);
    return res.json();
  }

  function headerOf(res, name) {
    if (!res || !res.headers || typeof res.headers.get !== 'function') return null;
    return res.headers.get(name);
  }

  // 名册：全量（首次）或增量（?since=），304 视为未变化。
  async function fetchRoster() {
    const qs = new URLSearchParams();
    if (rosterSince !== null) qs.set('since', String(rosterSince));
    const url = baseUrl + devicesPath + (qs.toString() ? '?' + qs : '');
    const res = await get(url, rosterEtag ? { 'if-none-match': rosterEtag } : {});
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error(`http_${res.status}`);
    const payload = await res.json();
    const list = Array.isArray(payload) ? payload : (isObj(payload) && Array.isArray(payload.devices) ? payload.devices : []);
    return {
      notModified: false,
      list,
      etag: headerOf(res, 'etag'),
      cursor: isObj(payload) ? (payload.cursor ?? payload.next_since) : undefined,
    };
  }

  function nextSince(list, fallback) {
    if (fallback !== undefined && fallback !== null && fallback !== '') return fallback;
    let max = null;
    for (const raw of list) {
      if (!isObj(raw) || raw.updated_at === undefined || raw.updated_at === null) continue;
      const v = raw.updated_at;
      if (max === null) { max = v; continue; }
      max = typeof v === 'number' && typeof max === 'number' ? Math.max(max, v) : (String(v) > String(max) ? v : max);
    }
    return max;
  }

  function buildDevices() {
    const pending = new Map(overrides);
    const out = [];
    for (const [key, raw] of roster) {
      if (raw.status === 'archived') {
        out.push({ id: key, archived: true });
        continue;
      }
      const ov = pending.get(key) || (raw.id !== undefined ? pending.get(String(raw.id)) : undefined);
      if (ov) {
        pending.delete(key);
        pending.delete(String(raw.id));
      }
      out.push(toDevice(raw, ov || {}));
    }
    // DyardOS 没报上来的设备用配置兜底：名册拉不到时不至于整网关空转。
    for (const o of pending.values()) out.push(toDevice({}, o));
    return out;
  }

  async function loadDevices() {
    let failure = null;
    try {
      const r = await fetchRoster();
      if (!r.notModified) {
        // 首次是全量：清掉旧映射；之后增量合并，服务端忽略 since 返回全量也照样成立。
        if (rosterSince === null) roster.clear();
        for (const raw of r.list) {
          if (!isObj(raw)) continue;
          const key = keyOf(raw);
          if (!key) continue;
          // 契约 §5.3：归档设备以 `status: 'archived'` 下发；保留在名册里，
          // 由 buildDevices 转成 `{id, archived:true}` 通知网关清本地缓存。
          if (raw.status === 'archived') {
            if (!archivedIds.has(key)) {
              archivedIds.add(key);
              stats.archived++;
            }
            roster.set(key, { ...raw, thing_code: raw.thing_code || raw.code || key });
            continue;
          }
          archivedIds.delete(key);
          roster.set(key, raw);
        }
        const etag = r.etag;
        if (etag) rosterEtag = etag;
        const next = nextSince(r.list, r.cursor);
        if (next !== null) rosterSince = next;
      }
      stats.lastDeviceSyncAt = clock();
      stats.lastDeviceError = null;
    } catch (e) {
      failure = e.message || String(e);
      stats.lastDeviceError = failure;
    }

    const out = buildDevices();
    if (out.length === 0 && failure) throw new Error(`dyard_unreachable: ${failure}`);
    aliases.clear();
    for (const raw of roster.values()) {
      const key = keyOf(raw);
      aliases.set(key, key);
      if (raw.id !== undefined && raw.id !== null) aliases.set(String(raw.id), key);
    }
    known.clear();
    for (const d of out) if (!d.archived) known.add(d.id);
    return out;
  }

  async function pollNow(publish = () => {}) {
    // 名册-only 模式：事件走硬件直连，网关不拉事件、也不算错误。
    if (!eventsPath) return { ok: true, events: 0, disabled: true };
    if (busy) return { ok: false, code: 'busy', events: 0 };
    busy = true;
    try {
      const qs = new URLSearchParams();
      if (cursor !== null) qs.set('since', String(cursor));
      if (waitMs > 0) qs.set('wait', String(waitMs));
      const query = qs.toString();
      const payload = await getJson(baseUrl + eventsPath + (query ? '?' + query : ''));
      const list = Array.isArray(payload) ? payload : (isObj(payload) && Array.isArray(payload.events) ? payload.events : []);

      let count = 0;
      for (const raw of list) {
        if (!isObj(raw)) { stats.skipped++; continue; }
        const ref = typeof raw.deviceId === 'string' ? raw.deviceId
          : (typeof raw.device === 'string' ? raw.device : '');
        const deviceId = aliases.get(ref) || ref;
        const metric = typeof raw.metric === 'string' ? raw.metric : '';
        if (!deviceId || !metric) { stats.skipped++; continue; }
        if (!known.has(deviceId)) { stats.filtered++; continue; }
        publish({
          deviceId,
          metric,
          value: raw.value,
          at: Number(raw.at) > 0 ? Math.trunc(Number(raw.at)) : undefined,
          idem: typeof raw.idem === 'string' && raw.idem ? raw.idem : undefined,
          quality: QUALITY.includes(raw.quality) ? raw.quality : 'good',
          kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : undefined,
          source: 'dyard',
        });
        count++;
      }

      const next = isObj(payload) ? (payload.cursor ?? payload.next ?? payload.seq) : undefined;
      if (next !== undefined && next !== null && Number.isFinite(Number(next))) cursor = Number(next);

      stats.polls++;
      stats.events += count;
      stats.lastPollAt = clock();
      stats.lastError = null;
      return { ok: true, events: count, cursor };
    } catch (e) {
      stats.errors++;
      stats.lastError = e.message || String(e);
      return { ok: false, events: 0, error: stats.lastError };
    } finally {
      busy = false;
    }
  }

  return {
    id: 'dyard',
    transport: 'dyard',
    detect: () => true,
    devices: () => loadDevices(),
    subscribe(publish) {
      if (!eventsPath) return () => {};
      stopped = false;
      const tick = async () => {
        if (stopped) return;
        const startedAt = clock();
        const r = await pollNow(publish);
        if (stopped) return;
        const elapsed = clock() - startedAt;
        let delay;
        if (!r.ok) delay = retryMs;
        else if (r.events > 0) delay = 0;
        else if (waitMs > 0 && elapsed >= waitMs * 0.8) delay = 0; // 服务端按 wait 挂住了，立刻续上
        else delay = waitMs > 0 ? retryMs : pollMs; // 服务端不支持 wait：退化为轮询
        const timer = setTimeout(tick, delay);
        timer.unref?.();
      };
      tick();
      return () => { stopped = true; };
    },
    pollNow,
    status: () => ({
      id: 'dyard',
      mode: 'read-only',
      baseUrl,
      eventsMode: eventsPath ? 'poll' : 'disabled',
      devices: known.size,
      roster: roster.size,
      rosterSince,
      rosterEtag: !!rosterEtag,
      cursor,
      waitMs,
      ...stats,
    }),
  };
}
