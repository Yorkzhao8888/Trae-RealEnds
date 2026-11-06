// IoT 数据面验收：批量幂等、心跳/超期、设备详情、时序与长轮询。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEdge } from '../src/server.js';

async function boot() {
  const app = createEdge({ dbPath: ':memory:', token: 'tk' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: 'Bearer tk', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { app, api, base };
}

const scanner = {
  id: 'scanner-01',
  kind: 'scanner',
  transport: 'serial',
  name: '收银台扫码枪',
  status: 'online',
  capabilities: ['scan.code', 'battery'],
  profile: 'retail.scanner.v1',
  staleAfterMs: 60000,
  meta: { model: 'GM65' },
};

const batch = {
  gatewayId: 'gw-1',
  devices: [scanner],
  events: [
    { v: 1, deviceId: 'scanner-01', kind: 'telemetry', metric: 'scan.code', value: '6901234567890', unit: null, at: 1700000000000, idem: 'e1', quality: 'good', source: 'serial' },
    { v: 1, deviceId: 'scanner-01', kind: 'telemetry', metric: 'battery', value: 82, unit: '%', at: 1700000000000, idem: 'e2', quality: 'good', source: 'serial' },
  ],
};

test('批量入库与 idem 幂等重放', async () => {
  const { app, api } = await boot();

  const r1 = await api('POST', '/iot/ingest', batch);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.applied, 2);
  assert.equal(r1.body.replayed, 0);

  const r2 = await api('POST', '/iot/ingest', batch);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.applied, 0);
  assert.equal(r2.body.replayed, 2);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM iot_event').get().n, 2);

  const list = await api('GET', '/iot/devices');
  assert.equal(list.body.devices.length, 1);
  const d = list.body.devices[0];
  assert.equal(d.status, 'online');
  assert.equal(d.profile, 'retail.scanner.v1');
  assert.equal(d.metrics['scan.code'].value, '6901234567890');
  assert.equal(d.metrics.battery.value, 82);
  assert.equal(d.metrics.battery.unit, '%');

  const detail = await api('GET', '/iot/devices/scanner-01');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.events.length, 2);
  assert.equal(detail.body.events[0].idem, 'gw-1:e1');
  await app.close();
});

test('心跳续活；超期由读侧判 stale，不冒充在线', async () => {
  const { app, api } = await boot();

  const hb = await api('POST', '/iot/heartbeat', { gatewayId: 'gw-1', devices: [{ ...scanner, staleAfterMs: 1000 }] });
  assert.equal(hb.status, 200);
  assert.equal(hb.body.devices, 1);

  // 让心跳时间过期：台账本身仍写 online，但读侧必须降级
  app.db.prepare('UPDATE iot_device SET last_seen = ? WHERE id = ?').run(Date.now() - 5000, 'scanner-01');
  const list = await api('GET', '/iot/devices');
  assert.equal(list.body.devices[0].status, 'stale');

  // 灌一条当前事件，指标质量按设备 staleAfterMs 判定
  const r = await api('POST', '/iot/ingest', {
    gatewayId: 'gw-1',
    events: [{ deviceId: 'scanner-01', metric: 'battery', value: 81, unit: '%', quality: 'good', idem: 'e3' }],
  });
  assert.equal(r.status, 200);
  const detail = await api('GET', '/iot/devices/scanner-01');
  assert.equal(detail.body.device.status, 'online');
  assert.equal(detail.body.device.metrics.battery.quality, 'good');

  // 显式离线优先于时间判定
  await api('POST', '/iot/heartbeat', { devices: [{ id: 'scanner-01', status: 'offline' }] });
  const off = await api('GET', '/iot/devices');
  assert.equal(off.body.devices[0].status, 'offline');
  await app.close();
});

test('网关存活：心跳登记、版本、积压计数与超期判定', async () => {
  const { app, api } = await boot();

  await api('POST', '/iot/heartbeat', {
    gatewayId: 'gw-1',
    gateway: { version: '0.1.0', profiles: 4, spooled: 2, failed: 1, lastError: 'HTTP 503' },
    devices: [{ ...scanner, source: 'gw-1' }],
  });

  const r = await api('GET', '/iot/gateways');
  assert.equal(r.status, 200);
  assert.equal(r.body.gateways.length, 1);
  const g = r.body.gateways[0];
  assert.equal(g.id, 'gw-1');
  assert.equal(g.online, true);
  assert.equal(g.version, '0.1.0');
  assert.equal(g.devices, 1);
  assert.equal(g.onlineDevices, 1);
  assert.equal(g.meta.spooled, 2);
  assert.equal(g.meta.failed, 1);
  assert.equal(g.meta.lastError, 'HTTP 503');

  // 网关进程挂了：最后心跳超过阈值即离线
  app.db.prepare('UPDATE iot_gateway SET last_seen = ? WHERE id = ?').run(Date.now() - 120000, 'gw-1');
  const off = await api('GET', '/iot/gateways');
  assert.equal(off.body.gateways[0].online, false);

  // 没走心跳的旧网关：只 ingest 也会登记，便于运维发现
  await api('POST', '/iot/ingest', {
    gatewayId: 'gw-legacy',
    devices: [{ id: 'scanner-02', kind: 'scanner', transport: 'serial', source: 'gw-legacy' }],
    events: [{ deviceId: 'scanner-02', metric: 'battery', value: 50, idem: 'lg1' }],
  });
  const legacy = await api('GET', '/iot/gateways');
  const l = legacy.body.gateways.find((x) => x.id === 'gw-legacy');
  assert.ok(l);
  assert.equal(l.online, true);
  assert.equal(l.devices, 1);
  await app.close();
});

test('设备时序：since / limit 与单位', async () => {
  const { app, api } = await boot();
  const base = Date.now() - 1000;

  for (let i = 0; i < 3; i++) {
    await api('POST', '/iot/ingest', {
      gatewayId: 'gw-1',
      events: [{ deviceId: 'sensor-01', metric: 'temperature', value: 20 + i, unit: '°C', at: base + i * 100, idem: 't' + i }],
    });
    await api('POST', '/iot/heartbeat', { devices: [{ id: 'sensor-01', kind: 'sensor', transport: 'mqtt' }] });
  }

  const all = await api('GET', '/iot/devices/sensor-01/series?metric=temperature');
  assert.equal(all.status, 200);
  assert.equal(all.body.points.length, 3);
  assert.deepEqual(all.body.points.map((p) => p.value), [20, 21, 22]);
  assert.equal(all.body.points[0].unit, '°C');

  const delta = await api('GET', `/iot/devices/sensor-01/series?metric=temperature&since=${base + 100}`);
  assert.equal(delta.body.points.length, 2);

  const one = await api('GET', '/iot/devices/sensor-01/series?metric=temperature&limit=1');
  assert.equal(one.body.points.length, 1);

  const missing = await api('GET', '/iot/devices/sensor-01/series');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'metric_required');

  const unknown = await api('GET', '/iot/devices/nope/series?metric=temperature');
  assert.equal(unknown.status, 404);
  await app.close();
});

test('长轮询：有增量唤醒，无增量超时返回空', async () => {
  const { app, api } = await boot();

  const pending = api('GET', '/iot/stream?since=0&wait=800');
  await new Promise((r) => setTimeout(r, 100));
  await api('POST', '/iot/ingest', {
    gatewayId: 'gw-1',
    events: [{ deviceId: 'scanner-01', metric: 'scan.code', value: 'X1', idem: 's1' }],
  });

  const got = await pending;
  assert.equal(got.status, 200);
  assert.equal(got.body.events.length, 1);
  assert.equal(got.body.events[0].metric, 'scan.code');
  assert.equal(got.body.cursor, got.body.events[0].seq);

  const timeout = await api(`GET`, `/iot/stream?since=${got.body.cursor}&wait=100`);
  assert.equal(timeout.status, 200);
  assert.equal(timeout.body.events.length, 0);
  assert.equal(timeout.body.timedOut, true);
  await app.close();
});

test('IoT 接口沿用店根鉴权与参数校验', async () => {
  const { app, api } = await boot();

  const noAuth = await fetch(`http://127.0.0.1:${app.server.address().port}/iot/devices`);
  assert.equal(noAuth.status, 401);

  const empty = await api('POST', '/iot/ingest', { events: [] });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'events_required');

  const badEvent = await api('POST', '/iot/ingest', { events: [{ deviceId: 'x', value: 1, idem: 'k' }] });
  assert.equal(badEvent.status, 400);
  assert.equal(badEvent.body.code, 'bad_event');
  assert.equal(badEvent.body.field, 'metric');

  const badDevices = await api('POST', '/iot/heartbeat', { devices: {} });
  assert.equal(badDevices.status, 400);
  assert.equal(badDevices.body.code, 'bad_devices');

  const badGateway = await api('POST', '/iot/heartbeat', { gateway: [] });
  assert.equal(badGateway.status, 400);
  assert.equal(badGateway.body.code, 'bad_gateway');

  const unknown = await api('GET', '/iot/devices/nope');
  assert.equal(unknown.status, 404);
  await app.close();
});

test('IoT 看板免鉴权可开，页内数据接口仍要 token', async () => {
  const { app, base, api } = await boot();

  const page = await fetch(base + '/edge/ui/iot');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /IoT 看板/);
  assert.ok(html.includes('/iot/devices'));
  assert.ok(html.includes('/iot/gateways'));
  assert.ok(html.includes('/iot/stream'));

  const data = await fetch(base + '/iot/devices');
  assert.equal(data.status, 401);

  // 页面里有 token 时的数据链路仍然正常
  await api('POST', '/iot/ingest', batch);
  const list = await api('GET', '/iot/devices');
  assert.equal(list.status, 200);
  assert.equal(list.body.devices.length, 1);
  await app.close();
});
