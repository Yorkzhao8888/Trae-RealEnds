// @uendos/plugin-iot-gateway · 构建期 IoT 网关代理适配器（只读）。
// 由 uendos sync 包进函数作用域注入品牌桥：设备与最新值代理店根 HTTP API，
// 事件通过 /iot/stream 长轮询回灌 shell:iot-data。不声明 write，iot.write 保持 E_UNSUPPORTED。
// 地址与令牌由宿主注入 window.__IOT_GATEWAY__（{ url, token }），壳内不内置凭证。

function gatewayConfig() {
  var src = (typeof window !== 'undefined' && window && window.__IOT_GATEWAY__) || {};
  var url = typeof src.url === 'string' && src.url ? src.url : 'http://127.0.0.1:7321';
  return {
    url: url.replace(/\/+$/, ''),
    token: typeof src.token === 'string' ? src.token : '',
  };
}

function gatewayGet(path) {
  var cfg = gatewayConfig();
  var headers = {};
  if (cfg.token) headers.authorization = 'Bearer ' + cfg.token;
  return fetch(cfg.url + path, { headers: headers, cache: 'no-store' }).then(function (res) {
    if (!res.ok) {
      var e = new Error('HTTP ' + res.status);
      e.status = res.status;
      throw e;
    }
    return res.json();
  });
}

function gatewayDevice(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  var metrics = raw.metrics || {};
  var caps = Object.keys(metrics);
  if (!caps.length && Array.isArray(raw.capabilities)) caps = raw.capabilities.slice();
  return {
    id: raw.id,
    kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'device',
    transport: 'gateway',
    status: raw.status === 'online' ? 'online' : (raw.status === 'stale' || raw.status === 'offline' ? 'offline' : 'unknown'),
    capabilities: caps,
  };
}

function gatewayDevices() {
  return gatewayGet('/iot/devices').then(function (body) {
    var out = [];
    var list = (body && body.devices) || [];
    for (var i = 0; i < list.length; i++) {
      var d = gatewayDevice(list[i]);
      if (d) out.push(d);
    }
    return out;
  });
}

function gatewayRead(deviceId, metric) {
  return gatewayGet('/iot/devices/' + encodeURIComponent(deviceId)).then(function (body) {
    var d = (body && body.device) || {};
    var metrics = d.metrics || {};
    var key = typeof metric === 'string' && metric ? metric : Object.keys(metrics)[0];
    if (!key || !metrics[key]) return null;
    var m = metrics[key];
    return {
      value: m.value,
      unit: m.unit === undefined ? null : m.unit,
      at: m.at,
      quality: m.quality,
    };
  });
}

function gatewaySubscribe(publish) {
  var stopped = false;
  var timer = null;
  var cursor = 0;

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }
  function later(ms) {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function tick() {
    if (stopped) return;
    gatewayGet('/iot/stream?since=' + cursor + '&wait=25000').then(function (body) {
      if (stopped) return;
      if (body && typeof body.cursor === 'number' && body.cursor > cursor) cursor = body.cursor;
      var events = (body && body.events) || [];
      for (var i = 0; i < events.length; i++) publish(events[i]);
      later(0);
    }).catch(function () {
      later(3000);
    });
  }

  // 从现有最新事件的 seq 起步，避免把历史值当新事件刷进壳。
  gatewayGet('/iot/devices').then(function (body) {
    var max = 0;
    var list = (body && body.devices) || [];
    for (var i = 0; i < list.length; i++) {
      var metrics = (list[i] && list[i].metrics) || {};
      for (var k in metrics) {
        if (Object.prototype.hasOwnProperty.call(metrics, k) && typeof metrics[k].seq === 'number' && metrics[k].seq > max) {
          max = metrics[k].seq;
        }
      }
    }
    if (max > cursor) cursor = max;
    tick();
  }).catch(function () { tick(); });

  return stop;
}

if (typeof ShellCore !== 'undefined' && ShellCore && typeof ShellCore.registerIotAdapter === 'function') {
  ShellCore.registerIotAdapter({
    id: '@uendos/plugin-iot-gateway',
    transport: 'gateway',
    detect: function () { return true; },
    devices: gatewayDevices,
    read: gatewayRead,
    subscribe: gatewaySubscribe,
  });
}

return {
  version: '0.1.0',
  capabilities: { 'iot.gateway': '\u2713' },
  methods: {
    'iot.gateway.status': function () {
      var cfg = gatewayConfig();
      return { ok: true, data: { url: cfg.url, configured: !!cfg.token, readOnly: true } };
    },
  },
};
