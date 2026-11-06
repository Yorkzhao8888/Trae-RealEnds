// 厂商云 HTTP 轮询 worker：只读拉取，按配置映射为 UendOS 事件。
// 不调用任何控制接口；值类型交给 gateway 按 profile 再校验一次。
const METHODS = ['GET', 'POST'];

function pathGet(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function isPrimitive(v) {
  return (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string' || typeof v === 'boolean';
}

function eventTime(raw, fallback) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === 'string' && raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    const d = Date.parse(raw);
    if (!Number.isNaN(d)) return d;
  }
  return fallback;
}

function expand(value, env) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (env[name] === undefined) throw new Error(`missing_env:${name}`);
    return env[name];
  });
}

export function validateVendorConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, errors: ['config_object_required'] };
  }
  const pollMs = Number(config.pollMs ?? 30000);
  if (!Number.isFinite(pollMs) || pollMs < 500 || pollMs > 86400000) errors.push('pollMs_500_86400000');

  if (!Array.isArray(config.devices) || config.devices.length === 0) {
    errors.push('devices_required');
  } else {
    const ids = new Set();
    for (const d of config.devices) {
      if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id.trim()) {
        errors.push('device_id_required');
        continue;
      }
      if (ids.has(d.id)) errors.push(`duplicate_device:${d.id}`);
      ids.add(d.id);
      if (d.vendorId !== undefined && typeof d.vendorId !== 'string') errors.push(`bad_vendor_id:${d.id}`);
      if (d.profile !== undefined && typeof d.profile !== 'string') errors.push(`bad_profile:${d.id}`);
      if (d.transport !== undefined && typeof d.transport !== 'string') errors.push(`bad_transport:${d.id}`);
    }
  }

  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    errors.push('sources_required');
  } else {
    for (const s of config.sources) {
      if (!s || typeof s !== 'object') { errors.push('source_object_required'); continue; }
      if (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) errors.push('source_url_http_required');
      const method = String(s.method || 'GET').toUpperCase();
      if (!METHODS.includes(method)) errors.push(`source_method:${method}`);
      for (const k of ['itemsPath', 'deviceField', 'atField', 'tokenEnv']) {
        if (s[k] !== undefined && typeof s[k] !== 'string') errors.push(`source_${k}_string`);
      }
      if (s.metrics !== undefined) {
        if (!s.metrics || typeof s.metrics !== 'object' || Array.isArray(s.metrics)) {
          errors.push('source_metrics_object');
        } else if (Object.values(s.metrics).some((v) => typeof v !== 'string')) {
          errors.push('source_metrics_path_string');
        }
      }
      if (s.headers !== undefined) {
        if (!s.headers || typeof s.headers !== 'object' || Array.isArray(s.headers)) {
          errors.push('source_headers_object');
        } else if (Object.values(s.headers).some((v) => typeof v !== 'string')) {
          errors.push('source_headers_string');
        }
      }
      if (s.body !== undefined && (!s.body || typeof s.body !== 'object' || Array.isArray(s.body))) {
        errors.push('source_body_object');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function createVendorWorker(config, { env = process.env, fetchImpl = fetch, clock = Date.now } = {}) {
  const v = validateVendorConfig(config);
  if (!v.ok) throw new Error(`vendor_config_invalid: ${v.errors.join('; ')}`);

  const pollMs = Number(config.pollMs ?? 30000);
  const timeoutMs = Number(config.timeoutMs ?? 10000);
  const devices = config.devices.map((d) => ({
    id: d.id,
    kind: d.kind || 'device',
    transport: d.transport || 'http',
    name: d.name || d.id,
    status: 'online',
    profile: d.profile || '',
    capabilities: Array.isArray(d.capabilities) ? d.capabilities.slice() : [],
    staleAfterMs: d.staleAfterMs,
    meta: d.meta && typeof d.meta === 'object' ? { ...d.meta, vendorId: d.vendorId || d.id } : { vendorId: d.vendorId || d.id },
  }));
  const byVendor = new Map(devices.map((d) => [String(d.meta.vendorId), d]));

  const stats = {
    polls: 0,
    errors: 0,
    lastPollAt: 0,
    lastError: null,
  };
  let busy = false;
  let stopped = false;

  async function fetchSource(source, publish) {
    const headers = { accept: 'application/json' };
    for (const [k, val] of Object.entries(source.headers || {})) headers[k] = expand(val, env);
    if (source.tokenEnv) {
      const token = env[source.tokenEnv];
      if (!token) throw new Error(`missing_env:${source.tokenEnv}`);
      headers.authorization = `Bearer ${token}`;
    }
    const method = String(source.method || 'GET').toUpperCase();
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(source.body || {});
    }

    const res = await fetchImpl(source.url, init);
    if (!res.ok) throw new Error(`http_${res.status}`);
    const payload = await res.json();
    const items = source.itemsPath ? pathGet(payload, source.itemsPath) : payload;
    if (!Array.isArray(items)) throw new Error('items_not_array');

    let published = 0;
    const deviceField = source.deviceField || 'id';
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const device = byVendor.get(String(item[deviceField]));
      if (!device) continue;
      const at = eventTime(pathGet(item, source.atField), clock());
      let pairs;
      if (source.metrics) {
        pairs = Object.entries(source.metrics).map(([metric, p]) => [metric, pathGet(item, p)]);
      } else if (item.metrics && typeof item.metrics === 'object' && !Array.isArray(item.metrics)) {
        pairs = Object.entries(item.metrics);
      } else {
        pairs = [];
      }
      for (const [metric, value] of pairs) {
        if (!isPrimitive(value)) continue;
        publish({ deviceId: device.id, metric, value, at, quality: 'good', source: 'vendor-http' });
        published++;
      }
    }
    return published;
  }

  async function pollNow(publish = () => {}) {
    if (busy) return { ok: false, code: 'busy', events: 0 };
    busy = true;
    let events = 0;
    const errors = [];
    try {
      for (const source of config.sources) {
        try {
          events += await fetchSource(source, publish);
        } catch (e) {
          errors.push(e.message || String(e));
        }
      }
      stats.polls++;
      stats.lastPollAt = clock();
      if (errors.length) {
        stats.errors++;
        stats.lastError = errors.join('; ');
        return { ok: false, errors, events };
      }
      stats.lastError = null;
      return { ok: true, events };
    } finally {
      busy = false;
    }
  }

  return {
    id: 'vendor-http',
    transport: 'http',
    detect: () => true,
    devices: () => devices.map((d) => ({ ...d, capabilities: d.capabilities.slice(), meta: { ...d.meta } })),
    subscribe(publish) {
      stopped = false;
      const tick = async () => {
        if (stopped) return;
        await pollNow(publish);
        if (!stopped) {
          const timer = setTimeout(tick, pollMs);
          if (timer.unref) timer.unref();
        }
      };
      tick();
      return () => { stopped = true; };
    },
    pollNow,
    status: () => ({
      id: 'vendor-http',
      pollMs,
      sources: config.sources.length,
      devices: devices.length,
      ...stats,
    }),
  };
}
