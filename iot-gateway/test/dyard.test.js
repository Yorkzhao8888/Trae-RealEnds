import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createDyardWorker, validateDyardConfig } from '../src/workers/dyard.js';

const configPath = new URL('../config/dyard.example.json', import.meta.url);

function mockDyard(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
    const out = handler(req);
    const buf = Buffer.from(JSON.stringify(out.body));
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      calls,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

test('DyardOS 配置示例合法，非法配置被拦下', async () => {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(validateDyardConfig(config), { ok: true, errors: [] });

  assert.ok(validateDyardConfig({}).errors.includes('baseUrl_http_required'));
  assert.ok(validateDyardConfig({ baseUrl: 'ftp://box' }).errors.includes('baseUrl_http_required'));
  assert.ok(validateDyardConfig({ baseUrl: 'http://box', waitMs: 40000 }).errors.includes('waitMs_0_30000'));
  assert.ok(validateDyardConfig({ baseUrl: 'http://box', waitMs: 20000, timeoutMs: 1000 }).errors.includes('timeoutMs_must_exceed_waitMs'));
  assert.ok(validateDyardConfig({
    baseUrl: 'http://box',
    devices: [{ id: 'a', transport: 'usb' }, { id: 'a' }],
  }).errors.includes('bad_transport:a'));
});

test('DyardOS 只读接入：设备清单 + 事件长轮询 + 未知设备过滤', async (t) => {
  const mock = await mockDyard((req) => {
    if (req.url.startsWith('/api/dyardos/contract/readonly/devices')) {
      return {
        body: {
          devices: [
            { id: 'gate-01', transport: 'ble', name: '后门门禁', model: 'SL-GATE', capabilities: ['lock.state'] },
            { id: 'sensor-01', transport: 'ble', name: '冷柜探头', model: 'SL-SENSOR' },
          ],
        },
      };
    }
    const since = new URL(req.url, 'http://x').searchParams.get('since');
    if (since === null) {
      return {
        body: {
          cursor: 7,
          events: [
            { deviceId: 'gate-01', metric: 'lock.state', value: 'locked', at: 1762400000000, idem: 'd-1' },
            { deviceId: 'sensor-01', metric: 'temperature', value: 4.5, quality: 'degraded' },
          ],
        },
      };
    }
    return { body: { cursor: 8, events: [{ deviceId: 'ghost-9', metric: 'battery', value: 50 }] } };
  });
  t.after(() => mock.close());

  const worker = createDyardWorker({
    baseUrl: mock.url,
    tokenEnv: 'DYARD_TOKEN',
    headers: { 'x-tenant': '${DYARD_TENANT}' },
    waitMs: 2000,
    timeoutMs: 5000,
  }, { env: { DYARD_TOKEN: 'secret', DYARD_TENANT: 't-1' } });

  const devices = await worker.devices();
  assert.equal(devices.length, 2);
  assert.equal(devices[0].transport, 'ble');
  assert.equal(devices[0].meta.model, 'SL-GATE');
  assert.equal(devices[0].meta.source, 'dyard');

  const seen = [];
  const first = await worker.pollNow((e) => seen.push(e));
  assert.equal(first.ok, true);
  assert.equal(first.events, 2);
  assert.equal(first.cursor, 7);
  assert.equal(seen[0].idem, 'd-1');
  assert.equal(seen[0].source, 'dyard');
  assert.equal(seen[1].quality, 'degraded');

  const second = await worker.pollNow((e) => seen.push(e));
  assert.equal(second.events, 0);
  assert.equal(second.cursor, 8);
  assert.equal(worker.status().filtered, 1);

  assert.ok(mock.calls.every((c) => c.method === 'GET'), '只允许 GET');
  assert.equal(mock.calls[0].auth, 'Bearer secret');
  assert.match(mock.calls[2].url, /since=7/);
  assert.match(mock.calls[2].url, /wait=2000/);
});

test('DyardOS 不可用时记录错误，恢复后继续采集', async (t) => {
  let mode = 'error';
  const mock = await mockDyard((req) => {
    if (req.url.startsWith('/api/dyardos/contract/readonly/devices')) {
      return { body: { devices: [{ id: 'gate-01', transport: 'ble', model: 'SL-GATE' }] } };
    }
    if (mode === 'error') return { status: 503, body: { error: 'busy' } };
    return { body: { cursor: 3, events: [{ deviceId: 'gate-01', metric: 'battery', value: 77 }] } };
  });
  t.after(() => mock.close());

  const worker = createDyardWorker({ baseUrl: mock.url, waitMs: 1000, timeoutMs: 3000 });
  await worker.devices();

  const fail = await worker.pollNow(() => {});
  assert.equal(fail.ok, false);
  assert.equal(worker.status().errors, 1);
  assert.equal(worker.status().lastError, 'http_503');

  mode = 'ok';
  const seen = [];
  const ok = await worker.pollNow((e) => seen.push(e));
  assert.equal(ok.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].value, 77);
  assert.equal(worker.status().lastError, null);
});

test('DyardOS 设备清单拉不到时用配置兜底；都没有则失败关闭', async (t) => {
  const mock = await mockDyard(() => ({ status: 500, body: { error: 'boom' } }));
  t.after(() => mock.close());

  const withFallback = createDyardWorker({
    baseUrl: mock.url,
    devices: [{ id: 'gate-01', transport: 'ble', profile: 'retail.gate.v1', meta: { model: 'SL-GATE' } }],
  });
  const devices = await withFallback.devices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, 'gate-01');
  assert.equal(devices[0].meta.source, 'dyard');
  assert.equal(withFallback.status().lastDeviceError, 'http_500');

  const noFallback = createDyardWorker({ baseUrl: mock.url });
  await assert.rejects(() => noFallback.devices(), /dyard_unreachable: http_500/);
});

test('DyardOS 名册-only：真实字段映射、单份认证头、空名册不判失败', async (t) => {
  const payload = {
    devices: [
      {
        id: '3f1c-uuid', code: 'IOT-GW-0007', name: '东门门禁网关', role: 'IoT-GW',
        model: 'retail.gate.v1', transport: 'http',
        site: { namespace: 'plaz', code: 'PLZ-01' },
        online: false, last_seen_at: '2026-11-11T01:22:31.000Z',
      },
      {
        id: 'dev-2', code: 'IOT-DV-0001', name: '', role: 'IoT-DV',
        model: 'SL-GATE', transport: 'usb', online: true,
      },
      {
        id: 'dev-3', thing_code: 'IOT-DV-0002', name: '中继探头', transport: 'rs485',
        profile: '', model: 'SL-TEMP', online: true,
      },
      {
        id: 'dev-4', thing_code: 'IOT-DV-0003', name: '无线温控', transport: 'zigbee', online: true,
      },
    ],
    cursor: '2026-11-11T01:22:31.000Z',
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { ok: true, json: async () => payload };
  };

  const worker = createDyardWorker({
    baseUrl: 'https://box.example.com',
    devicesPath: '/api/dyardos/contract/readonly/devices',
    eventsPath: null,
    tokenEnv: 'DYARDOS_TOKEN',
    headers: { Authorization: 'Bearer ${DYARDOS_TOKEN}' },
  }, { env: { DYARDOS_TOKEN: 'tk' }, fetchImpl });

  const devices = await worker.devices();
  assert.equal(calls[0].url, 'https://box.example.com/api/dyardos/contract/readonly/devices');
  assert.equal(calls[0].headers.authorization, 'Bearer tk');
  assert.equal(Object.keys(calls[0].headers).filter((k) => k.toLowerCase() === 'authorization').length, 1);

  const gw = devices[0];
  assert.equal(gw.id, 'IOT-GW-0007', 'thing_code 是对外业务键');
  assert.equal(gw.meta.uuid, '3f1c-uuid');
  assert.equal(gw.kind, 'gateway');
  assert.equal(gw.status, 'offline');
  assert.equal(gw.profile, 'retail.gate.v1');
  assert.equal(gw.meta.code, 'IOT-GW-0007');
  assert.deepEqual(gw.meta.site, { namespace: 'plaz', code: 'PLZ-01' });
  assert.equal(gw.meta.lastSeenAt, '2026-11-11T01:22:31.000Z');

  const dev = devices[1];
  assert.equal(dev.name, 'IOT-DV-0001');
  assert.equal(dev.transport, 'http');
  assert.equal(dev.profile, '');
  assert.equal(dev.meta.model, 'SL-GATE');
  assert.equal(dev.status, 'online');

  // 协议原值透传，映射在网关侧：rs485 → serial，zigbee → mqtt
  assert.equal(devices[2].transport, 'serial');
  assert.equal(devices[3].transport, 'mqtt');

  // eventsPath=null：不拉事件、不算错误、不发请求
  assert.deepEqual(await worker.pollNow(() => {}), { ok: true, events: 0, disabled: true });
  assert.equal(worker.status().eventsMode, 'disabled');
  assert.equal(typeof worker.subscribe(() => {}), 'function');
  assert.equal(calls.length, 1);

  // 空名册是正常结果：不抛错，按 0 台设备启动
  const emptyFetch = async () => ({ ok: true, json: async () => ({ devices: [], cursor: 'x' }) });
  const empty = createDyardWorker({ baseUrl: 'https://box.example.com' }, { fetchImpl: emptyFetch });
  assert.deepEqual(await empty.devices(), []);
});

test('DyardOS 名册增量：since/ETag、304 复用、增量合并不丢设备', async () => {
  const calls = [];
  const ctx = { mode: 'full' };
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (ctx.mode === '304') return { status: 304, ok: false, headers: { get: () => null }, json: async () => ({}) };
    if (ctx.mode === 'archived') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ devices: [{ thing_code: 'IOT-DW-0001', id: 'u-1', status: 'archived' }] }),
      };
    }
    if (ctx.mode === 'first') {
      return {
        ok: true,
        status: 200,
        headers: { get: (n) => (n.toLowerCase() === 'etag' ? 'W/"r1"' : null) },
        json: async () => ({
          devices: [{ thing_code: 'IOT-DW-0001', id: 'u-1', transport: 'ble', model: 'SL-GATE', updated_at: '2026-11-11T01:00:00.000Z' }],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (n) => (n.toLowerCase() === 'etag' ? 'W/"r2"' : null) },
      json: async () => ({
        devices: [{
          thing_code: 'IOT-DW-0002', id: 'u-2', transport: 'serial', name: '冷柜探头',
          parent_gateway_code: 'IOT-GW-0007', updated_at: '2026-11-11T02:00:00.000Z',
        }],
        cursor: '2026-11-11T02:00:00.000Z',
      }),
    };
  };

  ctx.mode = 'first';
  const worker = createDyardWorker({ baseUrl: 'https://box.example.com', eventsPath: null }, { fetchImpl });
  const first = await worker.devices();
  assert.equal(first.length, 1);
  assert.equal(worker.status().rosterSince, '2026-11-11T01:00:00.000Z');
  assert.equal(worker.status().rosterEtag, true);

  ctx.mode = 'incremental';
  const second = await worker.devices();
  assert.match(calls[1].url, /since=2026-11-11T01%3A00%3A00.000Z/);
  assert.equal(calls[1].headers['if-none-match'], 'W/"r1"');
  assert.equal(second.length, 2, '增量结果与已有名册合并，不丢旧设备');
  assert.equal(second[1].meta.parentGateway, 'IOT-GW-0007');
  assert.equal(worker.status().rosterSince, '2026-11-11T02:00:00.000Z');

  // 304：不重放旧结果、不报错，设备台账保持不变
  ctx.mode = '304';
  const third = await worker.devices();
  assert.equal(third.length, 2);
  assert.equal(calls[2].headers['if-none-match'], 'W/"r2"');
  assert.equal(worker.status().lastDeviceError, null);

  // 归档设备：保留在名册里，以 archived 标记下发给网关清缓存
  ctx.mode = 'archived';
  const fourth = await worker.devices();
  assert.equal(fourth.length, 2);
  assert.deepEqual(fourth[0], { id: 'IOT-DW-0001', archived: true });
  assert.equal(fourth[1].id, 'IOT-DW-0002');
  assert.equal(worker.status().archived, 1);
  assert.equal(worker.status().devices, 1, '归档设备不再计入在线设备');
});
