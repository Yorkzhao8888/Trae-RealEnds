// MQTT 只读链路：协议订阅/重连 + worker 映射 → 网关归一。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createMqttClient, encodePacket, encodeString, parsePackets, readString } from '../src/protocols/mqtt.js';
import { createMqttWorker } from '../src/workers/mqtt.js';
import { createGateway } from '../src/gateway.js';

const profilesDir = fileURLToPath(new URL('../profiles', import.meta.url));

async function waitFor(fn, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等待超时');
}

async function fakeBroker() {
  const connections = new Set();
  const server = net.createServer((sock) => {
    const state = { sock, topics: [], buffer: Buffer.alloc(0) };
    connections.add(state);
    sock.on('data', (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      const parsed = parsePackets(state.buffer);
      state.buffer = parsed.rest;
      for (const packet of parsed.packets) {
        if (packet.type === 1) {
          sock.write(encodePacket(2, 0, Buffer.from([0, 0])));
        } else if (packet.type === 8) {
          const id = packet.payload.readUInt16BE(0);
          state.topics = [];
          let off = 2;
          while (off < packet.payload.length) {
            const item = readString(packet.payload, off);
            state.topics.push(item.value);
            off = item.next + 1;
          }
          const grants = Buffer.alloc(state.topics.length + 2);
          grants.writeUInt16BE(id, 0);
          sock.write(encodePacket(9, 0, grants));
        } else if (packet.type === 12) {
          sock.write(encodePacket(13, 0));
        } else if (packet.type === 14) {
          sock.end();
        }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => connections.delete(state));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  return {
    port: server.address().port,
    connections,
    hasTopic(topic) {
      return [...connections].some((c) => c.topics.includes(topic));
    },
    publish(topic, text, { retain = false } = {}) {
      const payload = Buffer.concat([encodeString(topic), Buffer.from(text, 'utf8')]);
      const packet = encodePacket(3, retain ? 1 : 0, payload);
      for (const conn of connections) {
        if (conn.topics.includes(topic)) conn.sock.write(packet);
      }
    },
    drop() {
      for (const conn of connections) conn.sock.destroy();
    },
    close() {
      for (const conn of connections) conn.sock.destroy();
      return new Promise((r) => server.close(r));
    },
  };
}

test('MQTT 订阅：CONNACK/SUBACK、消息接收与掉线重连', async () => {
  const broker = await fakeBroker();
  const client = createMqttClient({
    host: '127.0.0.1',
    port: broker.port,
    clientId: 'mqtt-test',
    keepalive: 60,
    reconnectMs: 50,
    maxReconnectMs: 200,
  });
  const seen = [];
  client.onMessage((msg) => seen.push(msg));

  await client.start();
  client.subscribe(['iot/test']);
  await waitFor(() => broker.hasTopic('iot/test'));

  broker.publish('iot/test', '{"value":1}');
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0].topic, 'iot/test');
  assert.equal(seen[0].payload.toString(), '{"value":1}');
  assert.equal(client.status().messages, 1);

  broker.drop();
  await waitFor(() => client.status().connects >= 2, 3000);
  await waitFor(() => broker.hasTopic('iot/test'));
  broker.publish('iot/test', '{"value":2}');
  await waitFor(() => seen.length === 2);
  assert.equal(seen[1].payload.toString(), '{"value":2}');

  client.stop();
  await broker.close();
});

test('MQTT worker：按 topic 映射为网关事件，retain 标 degraded', async () => {
  const broker = await fakeBroker();
  const worker = createMqttWorker({
    host: '127.0.0.1',
    port: broker.port,
    clientId: 'mqtt-worker',
    reconnectMs: 50,
    devices: [{
      id: 'sensor-01',
      kind: 'sensor',
      transport: 'mqtt',
      name: '后厨温湿度',
      profile: 'retail.sensor.v1',
      staleAfterMs: 60000,
    }],
    topics: [
      { topic: 'iot/sensor-01/temp', deviceId: 'sensor-01', metric: 'temperature', field: 'value' },
      { topic: 'iot/sensor-01/env', deviceId: 'sensor-01', metrics: { humidity: 'humidity' }, units: { humidity: '%' } },
    ],
  });

  const sent = [];
  const client = {
    async heartbeat() { return { status: 200, body: { ok: true } }; },
    async ingest(body) {
      sent.push(body);
      return { status: 200, body: { ok: true, applied: body.events.length, replayed: 0 } };
    },
  };
  const gw = createGateway({
    profilesDir,
    spoolPath: null,
    client,
    workers: [worker],
    flushMs: 60000,
    heartbeatMs: 60000,
  });
  await gw.start();
  await waitFor(() => broker.hasTopic('iot/sensor-01/temp') && broker.hasTopic('iot/sensor-01/env'));

  broker.publish('iot/sensor-01/temp', JSON.stringify({ value: 24.6 }));
  broker.publish('iot/sensor-01/env', JSON.stringify({ humidity: 58 }));
  await waitFor(() => gw.status().published === 2);
  await gw.flushNow();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].events.length, 2);
  const temp = sent[0].events.find((e) => e.metric === 'temperature');
  const humidity = sent[0].events.find((e) => e.metric === 'humidity');
  assert.equal(temp.value, 24.6);
  assert.equal(temp.unit, '°C');
  assert.equal(humidity.value, 58);
  assert.equal(humidity.unit, '%');

  broker.publish('iot/sensor-01/temp', JSON.stringify({ value: 25.1 }), { retain: true });
  await waitFor(() => gw.status().published === 3);
  await gw.flushNow();
  const retained = sent[1].events.find((e) => e.metric === 'temperature');
  assert.equal(retained.value, 25.1);
  assert.equal(retained.quality, 'degraded');

  await gw.stop();
  await broker.close();
});

test('MQTT worker 配置校验', () => {
  const device = { id: 'd1', kind: 'sensor', transport: 'mqtt', profile: 'retail.sensor.v1' };
  assert.throws(() => createMqttWorker({ devices: [device], topics: [{ topic: 'x', deviceId: 'd1' }] }), /metric/);
  assert.throws(() => createMqttWorker({ devices: [], topics: [] }), /devices/);
  assert.throws(() => createMqttWorker({ devices: [device], topics: [{ topic: 'x' }] }), /deviceId/);
});
