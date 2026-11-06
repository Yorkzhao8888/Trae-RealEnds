// 网关验收：profile 校验、归一、spool 重试、心跳与类型防护。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfiles, validateProfile } from '../src/profiles.js';
import { createGateway } from '../src/gateway.js';
import { createFixtureWorker } from '../src/workers/fixture.js';
import { createFileSpool } from '../src/spool.js';

const profilesDir = fileURLToPath(new URL('../profiles', import.meta.url));
const devicesFile = fileURLToPath(new URL('../fixtures/devices.json', import.meta.url));
const eventsFile = fileURLToPath(new URL('../fixtures/events.json', import.meta.url));

async function mockEdge(respond) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ path: req.url, body });
    const next = await respond(req.url, body, calls.length);
    res.writeHead(next.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(next.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
}

function okIngest(body) {
  return { status: 200, body: { ok: true, applied: body.events.length, replayed: 0, cursor: 42 } };
}

async function bootGateway(mock, opts = {}) {
  const worker = await createFixtureWorker({ devicesFile, eventsFile });
  const gw = createGateway({
    edgeUrl: mock.url,
    gatewayId: 'gw-test',
    profilesDir,
    spoolPath: null,
    workers: [worker],
    flushMs: 60000,
    heartbeatMs: 60000,
    ...opts,
  });
  await gw.start();
  return gw;
}

test('profile 加载与校验', async () => {
  const profiles = await loadProfiles(profilesDir);
  assert.equal(profiles.size, 4);
  assert.equal(profiles.get('retail.scanner.v1').metrics.battery.unit, '%');
  assert.deepEqual(profiles.get('retail.gate.v1').metrics['lock.state'].enum, ['locked', 'unlocked', 'ajar']);
  assert.equal(profiles.get('retail.badge.v1').metrics['scan.badge'].type, 'string');

  const bad = [
    { profile: 'x', match: { transport: 'serial' }, metrics: { a: { type: 'number' } } },
    { profile: 'retail.bad.v1', match: { transport: 'usb' }, metrics: { a: { type: 'number' } } },
    { profile: 'retail.bad.v1', match: { transport: 'serial' }, metrics: {} },
    { profile: 'retail.bad.v1', match: { transport: 'serial' }, metrics: { a: { type: 'date' } } },
    { profile: 'retail.bad.v1', match: { transport: 'serial' }, metrics: { a: { type: 'number' } }, extra: true },
  ];
  for (const p of bad) assert.equal(validateProfile(p).ok, false, JSON.stringify(p));
});

test('采集链路：fixture -> profile 归一 -> /iot/ingest', async () => {
  const mock = await mockEdge((path, body) => {
    if (path === '/iot/heartbeat') return { status: 200, body: { ok: true, devices: body.devices.length } };
    return okIngest(body);
  });
  const gw = await bootGateway(mock);

  const sent = await gw.flushNow();
  assert.equal(sent.ok, true);
  assert.equal(sent.sent, 4);
  assert.equal(gw.status().published, 4);

  const ingest = mock.calls.find((c) => c.path === '/iot/ingest');
  assert.equal(ingest.body.gatewayId, 'gw-test');
  assert.equal(ingest.body.events.length, 4);
  for (const e of ingest.body.events) {
    assert.equal(e.v, 1);
    assert.ok(e.idem);
    assert.ok(e.at > 0);
  }
  const battery = ingest.body.events.find((e) => e.metric === 'battery');
  assert.equal(battery.value, 82);
  assert.equal(battery.unit, '%');
  const temp = ingest.body.events.find((e) => e.metric === 'temperature');
  assert.equal(temp.value, 24.6);
  assert.equal(temp.unit, '°C');
  const scan = ingest.body.events.find((e) => e.metric === 'scan.code');
  assert.equal(scan.value, '6901234567890');
  assert.equal(scan.unit, null);

  const hb = mock.calls.find((c) => c.path === '/iot/heartbeat');
  assert.equal(hb.body.devices.length, 2);
  assert.equal(hb.body.devices[0].profile, 'retail.scanner.v1');
  assert.equal(hb.body.gateway.version, '0.1.0');
  assert.equal(hb.body.gateway.profiles, 4);
  assert.equal(hb.body.gateway.devices, 2);

  await gw.stop();
  await mock.close();
});

test('店根不可达时 spool 保留，恢复后重投不丢', async () => {
  const mock = await mockEdge((path, body, n) => {
    if (path === '/iot/heartbeat') return { status: 200, body: { ok: true } };
    return n === 2 ? { status: 503, body: { ok: false } } : okIngest(body);
  });
  const gw = await bootGateway(mock);

  const first = await gw.flushNow();
  assert.equal(first.ok, false);
  assert.equal(await gw.spool.size(), 4);
  assert.equal(gw.status().failed, 1);

  const second = await gw.flushNow();
  assert.equal(second.ok, true);
  assert.equal(second.sent, 4);
  assert.equal(await gw.spool.size(), 0);
  assert.equal(mock.calls.filter((c) => c.path === '/iot/ingest').length, 2);

  await gw.stop();
  await mock.close();
});

test('类型与未知指标在入口拦截，不污染 spool', async () => {
  const mock = await mockEdge((path, body) => {
    if (path === '/iot/heartbeat') return { status: 200, body: { ok: true } };
    return okIngest(body);
  });
  const gw = await bootGateway(mock);
  await gw.flushNow(); // 先清掉 fixture 的首批事件，单独验证手工 publish

  assert.equal(gw.publish({ deviceId: 'sensor-01', metric: 'temperature', value: 'hot' }), false);
  assert.equal(gw.status().lastDrop, 'bad_value');
  assert.equal(gw.publish({ deviceId: 'sensor-01', metric: 'co2', value: 400 }), false);
  assert.equal(gw.status().lastDrop, 'unknown_metric');
  assert.equal(gw.publish({ deviceId: 'nope', metric: 'temperature', value: 20 }), false);
  assert.equal(gw.status().lastDrop, 'unknown_device');

  assert.equal(gw.publish({ deviceId: 'sensor-01', metric: 'temperature', value: '24.5' }), true);
  await gw.flushNow();
  const ingest = mock.calls.filter((c) => c.path === '/iot/ingest').at(-1);
  assert.equal(ingest.body.events.length, 1);
  assert.equal(ingest.body.events[0].value, 24.5);

  await gw.stop();
  await mock.close();
});

test('文件 spool 重启后仍可续投', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iot-spool-'));
  const file = join(dir, 'spool.ndjson');
  try {
    const a = await createFileSpool(file);
    await a.append([
      { spoolId: 'k1', deviceId: 'd1', metric: 'm', value: 1, at: 1, idem: 'k1' },
      { spoolId: 'k2', deviceId: 'd1', metric: 'm', value: 2, at: 2, idem: 'k2' },
    ]);
    await a.close();

    const b = await createFileSpool(file);
    assert.equal(await b.size(), 2);
    const peek = await b.peek(2);
    assert.equal(peek[0].value, 1);
    await b.ack(['k1']);
    assert.equal(await b.size(), 1);
    await b.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('profile 热加载：新增文件生效，坏文件不破坏当前映射，移除后设备失配', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iot-profiles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(join(profilesDir, 'retail.scanner.v1.json'), join(dir, 'scanner.json'));

  const devices = JSON.parse(await readFile(devicesFile, 'utf8'));
  const gw = createGateway({
    profilesDir: dir,
    spoolPath: null,
    client: {
      async heartbeat() { return { status: 200, body: { ok: true } }; },
      async ingest() { return { status: 200, body: { ok: true, applied: 0, replayed: 0 } }; },
    },
    workers: [{ id: 'fake', transport: 'serial', detect: () => true, devices: () => devices, subscribe: () => () => {} }],
    flushMs: 60000,
    heartbeatMs: 60000,
    watchProfiles: false,
  });
  await gw.start();
  assert.equal(gw.status().profiles, 1);

  await copyFile(join(profilesDir, 'retail.sensor.v1.json'), join(dir, 'sensor.json'));
  assert.equal((await gw.reloadProfiles()).profiles, 2);

  await writeFile(join(dir, 'broken.json'), '{"profile":');
  await assert.rejects(() => gw.reloadProfiles());
  assert.equal(gw.status().profiles, 2, '坏文件不应替换当前 profile 集');

  await rm(join(dir, 'broken.json'));
  await rm(join(dir, 'scanner.json'));
  const shrunk = await gw.reloadProfiles();
  assert.equal(shrunk.profiles, 1);
  assert.deepEqual(shrunk.unmapped, ['scanner-01']);
  assert.equal(gw.status().lastProfileReload.unmapped.length, 1);

  await gw.stop();
});
