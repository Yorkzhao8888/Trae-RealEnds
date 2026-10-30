// 局域网发现：店根周期性 UDP 广播，端壳/收银机监听即得地址。
// 不用 mDNS：门店网络（尤其是 Windows POS + 老旧 AP）经常屏蔽组播，
// 而广播在同网段通常仍可达；发现失败也不影响手填 IP 兜底。
import dgram from 'node:dgram';

const BEACON_PORT = Number(process.env.EDGE_BEACON_PORT || 7322);
const EDGE_PORT = Number(process.env.EDGE_PORT || 7321);

export function startBeacon(storeId, { port = BEACON_PORT, edgePort = EDGE_PORT, everyMs = 3000 } = {}) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const payload = () => Buffer.from(JSON.stringify({ edge: true, storeId, port: edgePort, at: Date.now() }));
  sock.bind(() => {
    sock.setBroadcast(true);
    const timer = setInterval(() => {
      sock.send(payload(), port, '255.255.255.255', (err) => { if (err) console.warn('[edge-beacon]', err.message); });
    }, everyMs);
    timer.unref();
  });
  return () => new Promise((r) => { try { sock.close(() => r()); } catch (e) { r(); } });
}

/** 监听广播，返回首个店根地址（超时返回 null）。 */
export function discover({ port = BEACON_PORT, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = (v) => { try { sock.close(); } catch (e) {} resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on('message', (msg) => {
      try {
        const d = JSON.parse(msg.toString());
        if (d.edge) { clearTimeout(timer); done(d); }
      } catch (e) {}
    });
    sock.on('error', () => { clearTimeout(timer); done(null); });
    sock.bind(() => {});
  });
}
