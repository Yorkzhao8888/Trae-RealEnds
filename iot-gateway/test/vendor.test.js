import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createVendorWorker, validateVendorConfig } from '../src/workers/vendor-http.js';

const configPath = new URL('../config/vendor.example.json', import.meta.url);

test('厂商云配置示例合法，非法配置被拦下', async () => {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(validateVendorConfig(config), { ok: true, errors: [] });

  assert.equal(validateVendorConfig({}).ok, false);
  assert.ok(validateVendorConfig({ devices: [], sources: [] }).errors.includes('devices_required'));
  assert.ok(validateVendorConfig({ devices: [{ id: 'x' }], sources: [{ url: 'ftp://x' }] }).errors.includes('source_url_http_required'));
  assert.ok(validateVendorConfig({ devices: [{ id: 'x' }], sources: [{ url: 'http://x', metrics: { a: 1 } }] }).errors.includes('source_metrics_path_string'));
});

test('厂商云轮询：认证头、路径取值、时间解析与设备映射', async (t) => {
  const bodies = [];
  const server = createServer((req, res) => {
    bodies.push({ auth: req.headers.authorization || '', url: req.url });
    const buf = Buffer.from(JSON.stringify({
      data: [
        { id: 'VG-001', state: 'locked', battery: 88, updatedAt: '2026-11-06T10:00:00+08:00' },
        { id: 'VG-404', state: 'unlocked', battery: 10, updatedAt: '2026-11-06T10:00:00+08:00' },
      ],
    }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const config = {
    pollMs: 30000,
    devices: [{
      id: 'gate-01', vendorId: 'VG-001', kind: 'gate', transport: 'http',
      name: '后门门禁', profile: 'retail.gate.v1', capabilities: ['lock.state', 'battery'], staleAfterMs: 120000,
    }],
    sources: [{
      url: `http://127.0.0.1:${server.address().port}/api/v1/devices`,
      tokenEnv: 'TEST_VENDOR_TOKEN',
      itemsPath: 'data',
      deviceField: 'id',
      atField: 'updatedAt',
      metrics: { 'lock.state': 'state', battery: 'battery' },
    }],
  };
  const env = { TEST_VENDOR_TOKEN: 'secret' };
  const worker = createVendorWorker(config, { env });

  const seen = [];
  const r = await worker.pollNow((e) => seen.push(e));
  assert.equal(r.ok, true);
  assert.equal(r.events, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].deviceId, 'gate-01');
  assert.equal(seen[0].metric, 'lock.state');
  assert.equal(seen[0].value, 'locked');
  assert.equal(seen[0].source, 'vendor-http');
  assert.equal(seen[1].value, 88);
  assert.equal(seen[0].at, Date.parse('2026-11-06T10:00:00+08:00'));
  assert.equal(bodies[0].auth, 'Bearer secret');
  assert.equal(worker.status().errors, 0);

  const devices = worker.devices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].transport, 'http');
  assert.equal(devices[0].meta.vendorId, 'VG-001');
});

test('厂商云失败不抛断：记录错误，恢复后继续采集', async (t) => {
  let mode = 'error';
  const server = createServer((req, res) => {
    if (mode === 'error') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"busy"}');
      return;
    }
    const buf = Buffer.from(JSON.stringify([{ id: 'VG-001', state: 'locked', battery: 77 }]));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const worker = createVendorWorker({
    pollMs: 30000,
    devices: [{ id: 'gate-01', vendorId: 'VG-001', kind: 'gate', transport: 'http', profile: 'retail.gate.v1' }],
    sources: [{
      url: `http://127.0.0.1:${server.address().port}/devices`,
      metrics: { 'lock.state': 'state', battery: 'battery' },
    }],
  });

  const fail = await worker.pollNow(() => {});
  assert.equal(fail.ok, false);
  assert.equal(fail.events, 0);
  assert.equal(worker.status().errors, 1);
  assert.equal(worker.status().lastError, 'http_503');

  mode = 'ok';
  const seen = [];
  const ok = await worker.pollNow((e) => seen.push(e));
  assert.equal(ok.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(worker.status().lastError, null);
});
