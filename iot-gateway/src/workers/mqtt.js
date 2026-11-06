// MQTT 只读采集 worker：订阅固定 topic，把 JSON/原始载荷按映射转成网关事件。
// 不提供 publish，QoS 由 broker 降级到 0；retain 消息标记 degraded，避免旧值冒充实时。
import { createMqttClient } from '../protocols/mqtt.js';

function fieldOf(body, field) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  if (!field) return body.value;
  return body[field];
}

function timestampOf(body) {
  if (body === null || typeof body !== 'object') return undefined;
  const value = body.at ?? body.ts;
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
}

export function createMqttWorker(config = {}) {
  const devices = Array.isArray(config.devices) ? config.devices : [];
  const topics = Array.isArray(config.topics) ? config.topics : [];
  if (devices.length === 0) throw new Error('mqtt devices 不能为空');
  if (topics.length === 0) throw new Error('mqtt topics 不能为空');
  for (const rule of topics) {
    if (typeof rule?.topic !== 'string' || !rule.topic) throw new Error('mqtt topic 缺少 topic');
    if (typeof rule.deviceId !== 'string' || !rule.deviceId) throw new Error(`mqtt topic ${rule.topic} 缺少 deviceId`);
    const hasMetrics = rule.metrics && typeof rule.metrics === 'object' && Object.keys(rule.metrics).length > 0;
    if (!hasMetrics && typeof rule.metric !== 'string') {
      throw new Error(`mqtt topic ${rule.topic} 需要 metric 或 metrics`);
    }
  }

  const client = createMqttClient({
    host: config.host,
    port: config.port,
    tls: config.tls,
    servername: config.servername,
    rejectUnauthorized: config.rejectUnauthorized,
    clientId: config.clientId || 'uendos-iot-gw',
    username: config.username,
    password: config.password,
    keepalive: config.keepalive,
    connectTimeoutMs: config.connectTimeoutMs,
    reconnectMs: config.reconnectMs,
    maxReconnectMs: config.maxReconnectMs,
  });

  let publish = null;
  let lastError = null;

  client.onMessage(({ topic, payload, retain }) => {
    if (!publish) return;
    const rule = topics.find((item) => item.topic === topic);
    if (!rule) return;
    const text = payload.toString('utf8');
    let body = text;
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        body = JSON.parse(trimmed);
      } catch {
        lastError = `bad_payload:${topic}`;
        return;
      }
    }
    if (typeof body !== 'object' && rule.field) {
      lastError = `bad_payload:${topic}`;
      return;
    }
    const at = timestampOf(body);
    const quality = retain ? 'degraded' : 'good';

    if (rule.metrics) {
      for (const [metric, field] of Object.entries(rule.metrics)) {
        const value = fieldOf(body, field);
        if (value === undefined || value === null) continue;
        publish({
          deviceId: rule.deviceId,
          metric,
          value,
          unit: rule.units?.[metric],
          at,
          quality,
          source: 'mqtt',
        });
      }
      return;
    }

    const value = rule.field
      ? fieldOf(body, rule.field)
      : (typeof body === 'object' ? fieldOf(body, undefined) : body);
    if (value === undefined || value === null) return;
    publish({
      deviceId: rule.deviceId,
      metric: rule.metric,
      value,
      unit: rule.unit,
      at,
      quality,
      source: 'mqtt',
    });
  });

  return {
    id: 'mqtt',
    transport: 'mqtt',
    detect: () => config.enabled !== false,
    devices: () => devices.slice(),
    status: () => ({ ...client.status(), lastError: lastError || client.status().lastError }),
    subscribe(fn) {
      publish = fn;
      client.subscribe(topics.map((item) => item.topic));
      client.start().catch((err) => {
        lastError = err.message;
      });
      return () => client.stop();
    },
  };
}
