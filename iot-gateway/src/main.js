// 网关入口：默认用 fixture 假设备源跑通「采集 → 归一 → spool → 店根」链路。
// IOT_DYARD_CONFIG 用物物引擎 DyardOS 只读源；IOT_MQTT_CONFIG 用 MQTT 订阅源；
// IOT_VENDOR_CONFIG 用厂商云 HTTP 轮询源；真实串口/BLE 适配器替换 workers 数组即可。
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createGateway } from './gateway.js';
import { createFixtureWorker } from './workers/fixture.js';
import { createMqttWorker } from './workers/mqtt.js';
import { createVendorWorker } from './workers/vendor-http.js';
import { createDyardWorker } from './workers/dyard.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = process.env;

let worker;
let source;
if (env.IOT_DYARD_CONFIG) {
  const config = JSON.parse(await readFile(env.IOT_DYARD_CONFIG, 'utf8'));
  worker = createDyardWorker(config);
  source = `dyard:${config.baseUrl || 'http://127.0.0.1:7410'}`;
} else if (env.IOT_MQTT_CONFIG) {
  const config = JSON.parse(await readFile(env.IOT_MQTT_CONFIG, 'utf8'));
  worker = createMqttWorker(config);
  source = `mqtt:${config.host || '127.0.0.1'}:${config.port || 1883}`;
} else if (env.IOT_VENDOR_CONFIG) {
  const config = JSON.parse(await readFile(env.IOT_VENDOR_CONFIG, 'utf8'));
  worker = createVendorWorker(config);
  source = `vendor-http:${config.sources.length} source(s)`;
} else {
  worker = await createFixtureWorker({
    devicesFile: env.IOT_DEVICES || join(root, 'fixtures/devices.json'),
    eventsFile: env.IOT_EVENTS || join(root, 'fixtures/events.json'),
    intervalMs: Number(env.IOT_FIXTURE_INTERVAL_MS || 5000),
  });
  source = 'fixture';
}

const gateway = createGateway({
  edgeUrl: env.IOT_EDGE_URL || 'http://127.0.0.1:7321',
  token: env.IOT_EDGE_TOKEN || env.EDGE_TOKEN || '',
  gatewayId: env.IOT_GATEWAY_ID || 'gw-local',
  profilesDir: env.IOT_PROFILES_DIR || join(root, 'profiles'),
  spoolPath: env.IOT_SPOOL || join(root, 'iot-spool.ndjson'),
  flushMs: Number(env.IOT_FLUSH_MS || 1000),
  heartbeatMs: Number(env.IOT_HEARTBEAT_MS || 30000),
  // 设备名册重取：DyardOS 用 ?since= + ETag，增量拉取成本很低；0 表示只在启动时取一次。
  refreshDevicesMs: Number(env.IOT_DEVICE_REFRESH_MS || 0),
  watchProfiles: true,
  workers: [worker],
});

await gateway.start();
console.log(`[iot-gateway] id=${gateway.status().gatewayId} source=${source} devices=${gateway.status().devices} edge=${env.IOT_EDGE_URL || 'http://127.0.0.1:7321'}`);

// 网关是常驻进程：定时器都 unref 了，这里保留一个句柄避免进程提前退出
const keepAlive = setInterval(() => {}, 1 << 30);

async function shutdown(signal) {
  console.log(`[iot-gateway] ${signal}，停止采集`);
  clearInterval(keepAlive);
  await gateway.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
