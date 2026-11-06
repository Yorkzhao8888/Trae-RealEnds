// 最小 MQTT 3.1.1 订阅端：CONNECT / SUBSCRIBE / PUBLISH(QoS 0-1) / PING。
// 只读：不提供 publish，不实现 QoS 2，不依赖第三方库。
import net from 'node:net';
import tls from 'node:tls';

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const PUBACK = 4;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;
const PINGRESP = 13;
const DISCONNECT = 14;

export function encodeLength(len) {
  const out = [];
  do {
    let b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    out.push(b);
  } while (len > 0);
  return Buffer.from(out);
}

export function encodeString(value) {
  const body = Buffer.from(String(value), 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export function encodePacket(type, flags = 0, payload = Buffer.alloc(0)) {
  return Buffer.concat([
    Buffer.from([(type << 4) | (flags & 0x0f)]),
    encodeLength(payload.length),
    payload,
  ]);
}

export function readString(buffer, offset = 0) {
  const len = buffer.readUInt16BE(offset);
  const next = offset + 2 + len;
  return { value: buffer.toString('utf8', offset + 2, next), next };
}

export function parsePackets(buffer) {
  const packets = [];
  let off = 0;
  while (off < buffer.length) {
    if (off + 1 >= buffer.length) break;
    const first = buffer[off];
    let len = 0;
    let mult = 1;
    let i = off + 1;
    let byte = 0;
    do {
      if (i >= buffer.length) return { packets, rest: buffer.subarray(off) };
      byte = buffer[i++];
      len += (byte & 0x7f) * mult;
      mult *= 128;
      if (mult > 128 * 128 * 128) return { packets, rest: buffer.subarray(off) };
    } while (byte & 0x80);
    if (buffer.length < i + len) return { packets, rest: buffer.subarray(off) };
    packets.push({
      type: (first >> 4) & 0x0f,
      flags: first & 0x0f,
      payload: buffer.subarray(i, i + len),
    });
    off = i + len;
  }
  return { packets, rest: Buffer.alloc(0) };
}

export function createMqttClient(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port || 1883);
  const useTls = Boolean(options.tls);
  const clientId = options.clientId || `uendos-${Math.random().toString(16).slice(2, 10)}`;
  const keepalive = Number(options.keepalive || 60);
  const connectTimeoutMs = Number(options.connectTimeoutMs || 5000);
  const baseReconnectMs = Number(options.reconnectMs || 1000);
  const maxReconnectMs = Number(options.maxReconnectMs || 30000);
  const clock = options.clock || Date.now;

  let socket = null;
  let connected = false;
  let started = false;
  let stopped = false;
  let reconnectTimer = null;
  let pingTimer = null;
  let pingOutstanding = false;
  let pingAt = 0;
  let connectTimer = null;
  let packetId = 1;
  let incoming = Buffer.alloc(0);
  let reconnectMs = baseReconnectMs;
  let firstWaiter = null;
  const topics = [];
  const messageHandlers = [];
  const connectHandlers = [];
  const offlineHandlers = [];
  const stats = { connects: 0, messages: 0, reconnects: 0, errors: 0, lastError: null };

  function status() {
    return {
      connected,
      connects: stats.connects,
      messages: stats.messages,
      reconnects: stats.reconnects,
      errors: stats.errors,
      lastError: stats.lastError,
      topics: topics.slice(),
    };
  }

  function write(buf) {
    if (!socket || socket.destroyed) return false;
    try {
      socket.write(buf);
      return true;
    } catch (e) {
      stats.lastError = e.message;
      return false;
    }
  }

  function settleFirst(err) {
    if (!firstWaiter) return;
    const waiter = firstWaiter;
    firstWaiter = null;
    if (err) waiter.reject(err);
    else waiter.resolve(status());
  }

  function nextId() {
    packetId = packetId >= 0xffff ? 1 : packetId + 1;
    return packetId;
  }

  function buildConnect() {
    const hasUser = typeof options.username === 'string' && options.username.length > 0;
    const hasPass = hasUser && typeof options.password === 'string' && options.password.length > 0;
    let flags = options.clean === false ? 0 : 0x02;
    if (hasUser) flags |= 0x80;
    if (hasPass) flags |= 0x40;
    const variables = Buffer.from([4, flags, keepalive >> 8, keepalive & 0xff]);
    const parts = [encodeString('MQTT'), variables, encodeString(clientId)];
    if (hasUser) parts.push(encodeString(options.username));
    if (hasPass) parts.push(encodeString(options.password));
    return encodePacket(CONNECT, 0, Buffer.concat(parts));
  }

  function sendSubscribe() {
    if (!connected || topics.length === 0) return;
    const id = nextId();
    const parts = [Buffer.from([id >> 8, id & 0xff])];
    for (const topic of topics) {
      parts.push(encodeString(topic));
      parts.push(Buffer.from([0]));
    }
    write(encodePacket(SUBSCRIBE, 0x02, Buffer.concat(parts)));
  }

  function startPing() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (!connected || !socket) return;
      if (pingOutstanding) {
        if (clock() - pingAt > keepalive * 1000) {
          stats.lastError = 'ping_timeout';
          socket.destroy();
        }
        return;
      }
      pingOutstanding = true;
      pingAt = clock();
      write(encodePacket(PINGREQ, 0));
    }, Math.max(1000, (keepalive * 1000) / 2));
    if (pingTimer.unref) pingTimer.unref();
  }

  function handlePublish(flags, payload) {
    const qos = (flags >> 1) & 0x03;
    if (qos === 2) {
      stats.lastError = 'qos2_unsupported';
      return;
    }
    const topic = readString(payload, 0);
    let off = topic.next;
    let id = 0;
    if (qos > 0) {
      id = payload.readUInt16BE(off);
      off += 2;
    }
    const body = payload.subarray(off);
    if (qos === 1) write(encodePacket(PUBACK, 0, Buffer.from([id >> 8, id & 0xff])));
    stats.messages++;
    const message = { topic: topic.value, payload: body, qos, retain: Boolean(flags & 1) };
    for (const fn of messageHandlers) fn(message);
  }

  function handlePacket(packet) {
    if (packet.type === CONNACK) {
      const code = packet.payload.length > 1 ? packet.payload[1] : 5;
      if (code !== 0) {
        stats.lastError = `connack_${code}`;
        socket?.destroy();
        return;
      }
      connected = true;
      stats.connects++;
      reconnectMs = baseReconnectMs;
      pingOutstanding = false;
      clearTimeout(connectTimer);
      connectTimer = null;
      sendSubscribe();
      startPing();
      for (const fn of connectHandlers) fn(status());
      settleFirst(null);
      return;
    }
    if (packet.type === PUBLISH) {
      handlePublish(packet.flags, packet.payload);
      return;
    }
    if (packet.type === SUBACK) {
      const bad = [...packet.payload.subarray(2)].some((code) => code === 0x80);
      if (bad) stats.lastError = 'suback_failure';
      return;
    }
    if (packet.type === PINGRESP) {
      pingOutstanding = false;
    }
  }

  function handleData(chunk) {
    incoming = incoming.length ? Buffer.concat([incoming, chunk]) : chunk;
    const parsed = parsePackets(incoming);
    incoming = parsed.rest;
    for (const packet of parsed.packets) handlePacket(packet);
  }

  function scheduleReconnect() {
    if (!started || stopped || reconnectTimer) return;
    stats.reconnects++;
    const delay = reconnectMs;
    reconnectMs = Math.min(maxReconnectMs, reconnectMs * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectOnce();
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function handleClose(err) {
    const wasConnected = connected;
    connected = false;
    socket = null;
    pingOutstanding = false;
    clearInterval(pingTimer);
    pingTimer = null;
    clearTimeout(connectTimer);
    connectTimer = null;
    incoming = Buffer.alloc(0);
    if (err) {
      stats.errors++;
      stats.lastError = err.message || String(err);
    }
    if (wasConnected) for (const fn of offlineHandlers) fn(status());
    settleFirst(err || new Error('mqtt_closed'));
    scheduleReconnect();
  }

  function connectOnce() {
    if (stopped || socket) return;
    const sock = useTls
      ? tls.connect({
        host,
        port,
        servername: options.servername || host,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      })
      : net.connect({ host, port });
    socket = sock;
    sock.setNoDelay?.(true);
    const timer = setTimeout(() => {
      stats.lastError = 'connect_timeout';
      sock.destroy();
    }, connectTimeoutMs);
    if (timer.unref) timer.unref();
    connectTimer = timer;

    const onReady = () => {
      sock.write(buildConnect());
    };
    if (useTls) sock.once('secureConnect', onReady);
    else sock.once('connect', onReady);

    sock.on('data', handleData);
    sock.on('error', (err) => handleClose(err));
    sock.on('close', () => handleClose(null));
  }

  return {
    start() {
      if (stopped) return Promise.reject(new Error('mqtt_stopped'));
      if (firstWaiter) return firstWaiter.promise;
      if (started && connected) return Promise.resolve(status());
      started = true;
      const promise = new Promise((resolve, reject) => {
        firstWaiter = { promise: null, resolve, reject };
      });
      firstWaiter.promise = promise;
      connectOnce();
      return promise;
    },
    subscribe(list) {
      for (const topic of list || []) {
        if (typeof topic === 'string' && !topics.includes(topic)) topics.push(topic);
      }
      sendSubscribe();
    },
    onMessage(fn) {
      if (typeof fn === 'function') messageHandlers.push(fn);
    },
    onConnect(fn) {
      if (typeof fn === 'function') connectHandlers.push(fn);
    },
    onOffline(fn) {
      if (typeof fn === 'function') offlineHandlers.push(fn);
    },
    status,
    stop() {
      stopped = true;
      started = false;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearInterval(pingTimer);
      pingTimer = null;
      clearTimeout(connectTimer);
      connectTimer = null;
      if (socket) {
        if (connected) write(encodePacket(DISCONNECT, 0));
        socket.end();
        socket = null;
      }
      connected = false;
      settleFirst(new Error('mqtt_stopped'));
    },
  };
}
