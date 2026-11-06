// 只读 IoT 网关：适配器 -> profile 归一 -> spool -> 店根 /iot/ingest。
// 独立进程的原因：串口/BLE/MQTT 需要原生模块与长连接，不能污染店根的零依赖。
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';
import { loadProfiles, resolveProfile } from './profiles.js';
import { openSpool } from './spool.js';
import { createEdgeClient } from './ingest.js';

const VERSION = '0.1.0';
const QUALITY = ['good', 'degraded', 'stale', 'unknown'];
const DEFAULT_PROFILES = fileURLToPath(new URL('../profiles/', import.meta.url));

export function createGateway({
  edgeUrl = 'http://127.0.0.1:7321',
  token = '',
  gatewayId = 'gw-local',
  profiles = null,
  profilesDir = DEFAULT_PROFILES,
  workers = [],
  spoolPath = null,
  batchSize = 100,
  flushMs = 1000,
  heartbeatMs = 30000,
  maxBackoffMs = 60000,
  watchProfiles = false,
  client = null,
  clock = () => Date.now(),
  onEvent = null,
} = {}) {
  const http = client || createEdgeClient({ url: edgeUrl, token });
  let profilesMap = profiles;
  let spool = null;
  let started = false;
  let stopped = false;
  let activeWorkers = [];
  const subscriptions = [];
  const known = new Map();
  const pending = [];

  let seq = 0;
  let startedAt = 0;
  let spooled = 0;
  let backoff = flushMs;
  let flushing = null;
  let drainTimer = null;
  let flushTimer = null;
  let heartbeatTimer = null;
  let profileWatcher = null;
  let profileWatchTimer = null;

  const stats = {
    published: 0,
    dropped: 0,
    sent: 0,
    replayed: 0,
    failed: 0,
    heartbeats: 0,
    lastError: null,
    lastDrop: null,
    lastFlush: null,
    lastHeartbeat: null,
    lastProfileReload: null,
  };

  async function init() {
    if (!profilesMap) profilesMap = await loadProfiles(profilesDir);

    activeWorkers = [];
    for (const w of workers) {
      if (typeof w.detect === 'function' && !(await w.detect())) continue;
      const list = typeof w.devices === 'function' ? await w.devices() : [];
      for (const d of Array.isArray(list) ? list : []) {
        if (!d || typeof d.id !== 'string' || !d.id) continue;
        const profile = resolveProfile(profilesMap, d);
        if (!profile) {
          stats.lastError = `设备 ${d.id} 没有匹配的 profile`;
          continue;
        }
        known.set(d.id, {
          ...d,
          profile: profile.profile,
          kind: d.kind || profile.kind || 'device',
          status: d.status === 'offline' ? 'offline' : 'online',
          staleAfterMs: Number(d.staleAfterMs) || profile.staleAfterMs || 60000,
          capabilities: Array.isArray(d.capabilities) ? d.capabilities : [],
          meta: d.meta && typeof d.meta === 'object' ? d.meta : {},
        });
      }
      activeWorkers.push(w);
    }

    spool = spool || await openSpool(spoolPath);
    spooled = await spool.size();
  }

  // 新增型号只需加 profile 文件；热加载后已知设备重新匹配，匹配不到的下次事件会被拦下。
  async function reloadProfiles() {
    const next = await loadProfiles(profilesDir);
    const unmapped = [];
    for (const d of known.values()) {
      const p = resolveProfile(next, d);
      if (!p) {
        unmapped.push(d.id);
        d.profile = '';
        continue;
      }
      d.profile = p.profile;
      d.kind = d.kind || p.kind || 'device';
      d.staleAfterMs = Number(d.staleAfterMs) || p.staleAfterMs || 60000;
    }
    profilesMap = next;
    stats.lastProfileReload = { at: clock(), profiles: next.size, unmapped };
    return { profiles: next.size, unmapped };
  }

  function startProfileWatch() {
    if (profileWatcher || !watchProfiles) return;
    try {
      profileWatcher = watch(profilesDir, { persistent: false }, () => {
        clearTimeout(profileWatchTimer);
        profileWatchTimer = setTimeout(() => {
          reloadProfiles().catch((e) => { stats.lastError = 'profile reload: ' + e.message; });
        }, 200);
        profileWatchTimer.unref?.();
      });
      profileWatcher.unref?.();
    } catch (e) {
      stats.lastError = 'profile watch: ' + e.message;
    }
  }

  function drop(reason) {
    stats.dropped++;
    stats.lastDrop = reason;
  }

  // ---------------------------------------------------------------- 上行事件
  function publish(raw) {
    if (stopped || !raw || typeof raw !== 'object') return false;
    if (!spool) { drop('not_started'); return false; }

    const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : '';
    const metric = typeof raw.metric === 'string' ? raw.metric : '';
    if (!deviceId || !metric) { drop('bad_envelope'); return false; }

    const device = known.get(deviceId);
    if (!device) { drop('unknown_device'); return false; }
    const profile = profilesMap.get(device.profile);
    const spec = profile && profile.metrics ? profile.metrics[metric] : null;
    if (!spec) { drop('unknown_metric'); return false; }

    let value = raw.value;
    if (spec.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) { drop('bad_value'); return false; }
      value = spec.scale === undefined ? n : n * spec.scale;
    } else if (spec.type === 'string') {
      if (typeof value !== 'string') { drop('bad_value'); return false; }
      if (spec.enum && !spec.enum.includes(value)) { drop('bad_value'); return false; }
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') { drop('bad_value'); return false; }
    }

    const localSeq = ++seq;
    const at = Number(raw.at) > 0 ? Math.trunc(Number(raw.at)) : clock();
    const idem = typeof raw.idem === 'string' && raw.idem ? raw.idem : `${gatewayId}:${clock()}:${localSeq}`;
    const event = {
      v: 1,
      spoolId: idem,
      deviceId,
      kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'telemetry',
      metric,
      value,
      unit: raw.unit !== undefined ? raw.unit : (spec.unit ?? null),
      at,
      seq: localSeq,
      idem,
      quality: QUALITY.includes(raw.quality) ? raw.quality : 'unknown',
      source: typeof raw.source === 'string' && raw.source ? raw.source : device.transport,
    };

    pending.push(event);
    stats.published++;
    scheduleDrain();
    if (onEvent) onEvent(event);
    return true;
  }

  function scheduleDrain() {
    if (drainTimer) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      drainPending().catch(() => {});
    }, 50);
    drainTimer.unref?.();
  }

  async function drainPending() {
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    await spool.append(batch);
    spooled = await spool.size();
  }

  // ---------------------------------------------------------------- 发店根
  function scheduleFlush(ms) {
    if (stopped) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch(() => {});
    }, Math.max(0, ms));
    flushTimer.unref?.();
  }

  async function runFlush() {
    await drainPending();
    const batch = await spool.peek(batchSize);
    spooled = await spool.size();

    if (!batch.length) {
      scheduleFlush(flushMs);
      return { ok: true, sent: 0, empty: true };
    }

    const events = batch.map(({ spoolId, ...e }) => e); // spoolId 只在本进程内用
    let res;
    try {
      res = await http.ingest({ gatewayId, sentAt: clock(), events });
    } catch (e) {
      res = { status: 0, error: e.message };
    }

    const accepted = !!res && res.status >= 200 && res.status < 300 && res.body && res.body.ok !== false;
    stats.lastFlush = {
      at: clock(),
      status: res ? res.status : 0,
      accepted,
      count: batch.length,
      error: res && res.error ? res.error : null,
    };

    if (!accepted) {
      stats.failed++;
      stats.lastError = res && res.error ? res.error : `HTTP ${res ? res.status : 0}`;
      backoff = Math.min(Math.max(backoff * 2, flushMs), maxBackoffMs);
      scheduleFlush(backoff);
      return { ok: false, sent: 0, status: res ? res.status : 0, error: stats.lastError };
    }

    await spool.ack(batch.map((e) => e.spoolId));
    stats.sent += batch.length;
    stats.replayed += Number(res.body.replayed) || 0;
    stats.lastError = null;
    backoff = flushMs;
    spooled = await spool.size();
    // 还有积压就立刻继续排空，避免断网恢复后慢吞吞地一条条发
    scheduleFlush(spooled > 0 ? 0 : flushMs);
    return { ok: true, sent: batch.length, replayed: Number(res.body.replayed) || 0, cursor: res.body.cursor ?? null };
  }

  function flush() {
    if (!spool) return Promise.reject(new Error('gateway 未 start'));
    if (flushing) return flushing;
    flushing = runFlush();
    return flushing.finally(() => { flushing = null; });
  }

  async function flushNow() {
    clearTimeout(flushTimer);
    flushTimer = null;
    return flush();
  }

  // ---------------------------------------------------------------- 心跳
  function devicePayload() {
    return [...known.values()].map((d) => ({
      id: d.id,
      kind: d.kind,
      transport: d.transport,
      name: d.name || '',
      status: d.status,
      capabilities: d.capabilities,
      profile: d.profile,
      staleAfterMs: d.staleAfterMs,
      source: gatewayId,
      meta: d.meta,
    }));
  }

  async function heartbeat() {
    if (stopped) return { ok: false, code: 'stopped' };
    const devices = devicePayload();
    const gateway = {
      version: VERSION,
      startedAt,
      uptimeMs: startedAt ? clock() - startedAt : 0,
      profiles: profilesMap ? profilesMap.size : 0,
      workers: activeWorkers.map((w) => w.id || w.transport || 'worker'),
      devices: known.size,
      spooled,
      sent: stats.sent,
      failed: stats.failed,
      replayed: stats.replayed,
      lastError: stats.lastError,
    };
    let res;
    try {
      res = await http.heartbeat({ gatewayId, at: clock(), devices, gateway });
    } catch (e) {
      res = { status: 0, error: e.message };
    }
    const accepted = !!res && res.status >= 200 && res.status < 300 && res.body && res.body.ok !== false;
    stats.heartbeats++;
    stats.lastHeartbeat = { at: clock(), status: res ? res.status : 0, accepted, devices: devices.length };
    if (!accepted) stats.lastError = res && res.error ? res.error : `HTTP ${res ? res.status : 0}`;
    return { ok: accepted, devices: devices.length, status: res ? res.status : 0 };
  }

  function scheduleHeartbeat() {
    if (stopped) return;
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(async () => {
      await heartbeat();
      scheduleHeartbeat();
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  // ---------------------------------------------------------------- 生命周期
  // 适配器在 start 之前注册；协议实现只需满足 detect/devices/subscribe 契约。
  function registerWorker(worker) {
    if (started) throw new Error('gateway 已启动，不能再注册 worker');
    if (!worker || typeof worker !== 'object') throw new Error('worker 必须是对象');
    workers.push(worker);
    return worker;
  }

  async function start() {
    if (started) return status();
    await init();
    stopped = false;
    started = true;
    startedAt = clock();

    for (const w of activeWorkers) {
      if (typeof w.subscribe !== 'function') continue;
      const off = w.subscribe(publish);
      if (typeof off === 'function') subscriptions.push(off);
    }

    startProfileWatch();
    await drainPending();
    await heartbeat();
    scheduleFlush(flushMs);
    scheduleHeartbeat();
    return status();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(drainTimer);
    clearTimeout(flushTimer);
    clearTimeout(heartbeatTimer);
    clearTimeout(profileWatchTimer);
    drainTimer = flushTimer = heartbeatTimer = profileWatchTimer = null;

    try { profileWatcher?.close(); } catch (e) {}
    profileWatcher = null;

    for (const off of subscriptions.splice(0)) {
      try { off(); } catch (e) {}
    }
    await drainPending().catch(() => {});
    await spool?.close?.();
    started = false;
  }

  function status() {
    return {
      gatewayId,
      version: VERSION,
      started,
      startedAt,
      profiles: profilesMap ? profilesMap.size : 0,
      workers: activeWorkers.map((w) => w.id || w.transport || 'worker'),
      devices: known.size,
      spooled,
      backoffMs: backoff,
      ...stats,
    };
  }

  return {
    registerWorker,
    start,
    stop,
    reloadProfiles,
    flushNow,
    heartbeat,
    publish,
    status,
    get spool() { return spool; },
    get profiles() { return profilesMap; },
    get devices() { return [...known.values()]; },
  };
}
