// 店根客户端：只发 /iot/ingest 与 /iot/heartbeat，不碰控制面。
export function createEdgeClient({ url, token = '', timeoutMs = 10000 } = {}) {
  const base = String(url || '').replace(/\/$/, '');
  const headers = {
    'content-type': 'application/json',
    ...(token ? { authorization: 'Bearer ' + token } : {}),
  };

  async function post(path, body) {
    const resp = await fetch(base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let rb = null;
    try { rb = await resp.json(); } catch (e) {}
    return { status: resp.status, body: rb };
  }

  return {
    ingest: (payload) => post('/iot/ingest', payload),
    heartbeat: (payload) => post('/iot/heartbeat', payload),
  };
}
