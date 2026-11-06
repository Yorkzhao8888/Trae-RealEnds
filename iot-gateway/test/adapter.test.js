import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { validatePluginManifest } from '../../sdk/packages/contract/src/index.js';

async function loadRuntime() {
  const src = await readFile(new URL('../adapter/runtime.js', import.meta.url), 'utf8');
  const captured = [];
  const ShellCore = {
    registerIotAdapter(spec) { captured.push(spec); return true; },
  };
  const def = new Function('ShellCore', src)(ShellCore);
  return { captured, def };
}

async function mockEdge() {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization || '' });
    const u = new URL(req.url, 'http://edge');
    const send = (code, body) => {
      const buf = Buffer.from(JSON.stringify(body));
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
      res.end(buf);
    };
    const metrics = {
      temperature: { value: 24.6, unit: '°C', at: 1000, quality: 'good', seq: 5 },
      humidity: { value: 58, unit: '%', at: 1000, quality: 'good', seq: 6 },
    };
    if (u.pathname === '/iot/devices') {
      return send(200, { ok: true, devices: [{ id: 'sensor-01', kind: 'sensor', status: 'stale', metrics }] });
    }
    if (u.pathname === '/iot/devices/sensor-01') {
      return send(200, { ok: true, device: { id: 'sensor-01', metrics } });
    }
    if (u.pathname === '/iot/stream') {
      return send(200, {
        ok: true,
        cursor: 7,
        events: [{ deviceId: 'sensor-01', kind: 'telemetry', metric: 'temperature', value: 25.1, unit: '°C', at: 2000, idem: 'gw-1:7', quality: 'good', source: 'gateway' }],
      });
    }
    send(404, { ok: false, code: 'not_found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('插件声明合法，运行期注册 gateway 只读适配器', async () => {
  const manifest = JSON.parse(await readFile(new URL('../adapter/uendos.plugin.json', import.meta.url), 'utf8'));
  const v = validatePluginManifest(manifest, { name: manifest.id });
  assert.equal(v.ok, true, v.errors.join('; '));

  const { captured, def } = await loadRuntime();
  assert.equal(captured.length, 1);
  const ad = captured[0];
  assert.equal(ad.transport, 'gateway');
  assert.equal(ad.id, manifest.id);
  assert.equal(ad.write, undefined, '只读适配器不得声明 write');
  assert.equal(typeof ad.devices, 'function');
  assert.equal(typeof ad.read, 'function');
  assert.equal(typeof ad.subscribe, 'function');
  assert.deepEqual(def.capabilities, { 'iot.gateway': '✓' });
});

test('devices/read 代理店根并归一为 gateway 设备', async (t) => {
  const edge = await mockEdge();
  const { captured } = await loadRuntime();
  const ad = captured[0];
  const prev = globalThis.window;
  globalThis.window = { __IOT_GATEWAY__: { url: edge.base, token: 'tk' } };
  t.after(async () => {
    if (prev === undefined) delete globalThis.window;
    else globalThis.window = prev;
    await edge.close();
  });

  const devices = await ad.devices();
  assert.deepEqual(devices, [{
    id: 'sensor-01',
    kind: 'sensor',
    transport: 'gateway',
    status: 'offline',
    capabilities: ['temperature', 'humidity'],
  }]);

  const temp = await ad.read('sensor-01', 'temperature');
  assert.deepEqual(temp, { value: 24.6, unit: '°C', at: 1000, quality: 'good' });
  assert.equal(await ad.read('sensor-01', 'nope'), null);
  assert.deepEqual(await ad.read('sensor-01', null), { value: 24.6, unit: '°C', at: 1000, quality: 'good' });

  assert.ok(edge.calls.length >= 3);
  assert.ok(edge.calls.every((c) => c.auth === 'Bearer tk'));
});

test('subscribe 长轮询把事件回灌为适配器事件', async (t) => {
  const edge = await mockEdge();
  const { captured } = await loadRuntime();
  const ad = captured[0];
  const prev = globalThis.window;
  globalThis.window = { __IOT_GATEWAY__: { url: edge.base, token: 'tk' } };
  t.after(async () => {
    if (prev === undefined) delete globalThis.window;
    else globalThis.window = prev;
    await edge.close();
  });

  const seen = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('未收到事件')), 2000);
    let stop = null;
    stop = ad.subscribe((ev) => {
      clearTimeout(timer);
      try {
        assert.equal(ev.deviceId, 'sensor-01');
        assert.equal(ev.metric, 'temperature');
        assert.equal(ev.value, 25.1);
        assert.equal(ev.idem, 'gw-1:7');
        resolve(ev);
      } finally {
        if (stop) stop();
      }
    });
  });

  assert.equal(seen.unit, '°C');
  // 从现有一新事件 seq 起轮询，而不是从 0 灌历史
  const streamCall = edge.calls.find((c) => c.url.startsWith('/iot/stream'));
  assert.ok(streamCall, '应发起 /iot/stream 请求');
  assert.match(streamCall.url, /since=6/);
});
