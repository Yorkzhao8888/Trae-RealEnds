/*! 知味工场 · 品牌桥 v0.2.0 — 由 shell-core 生成，勿手改。

  源：shell-core/src/core.js + shell-core/src/brands/ziway.json
  契约：docs/shell-contract.md
  重新生成：node shell-core/build.mjs
*/

/**
 * BTOS 真实端壳 · 共享运行时（shell-core）
 *
 * 契约：docs/shell-contract.md（v0.2.0）
 * 形态：无构建依赖的自包含脚本，可被远程 H5 直接 <script> 引入。
 *
 * 设计要点：
 *   1. 单一命名空间 window.Shell；品牌别名（ziwayOS / jechanOS / xsoOS / cajobOS）为兼容层。
 *   2. 适配器按能力探测（Capacitor / Electron / 小程序 web-view / 浏览器），不靠 UA 猜。
 *   3. 所有事件带 seq 与单调时间；握手可重放（Shell.call('core.handshake')）。
 *
 * 本文件不含品牌配置：由 build.mjs 追加 config 片段后产出 <brand>-shell.js。
 */
(function () {
  'use strict';

  var CORE_VERSION = '0.2.0';
  var BRIDGE_VERSION = '2';
  var READY_TIMEOUT_MS = 1500;

  if (window.Shell && window.Shell.__core) return;

  // ---------------------------------------------------------------- 基础工具
  var seq = 0;
  function nowMonotonic() {
    try {
      if (window.performance && performance.now) return Math.round(performance.now());
    } catch (e) {}
    return Date.now();
  }

  function emit(event, detail) {
    var payload = { event: event, seq: ++seq, at: nowMonotonic(), data: detail === undefined ? null : detail };
    try {
      window.dispatchEvent(new CustomEvent(event, { detail: payload }));
    } catch (e) {}
    var brandPrefix = state.config && state.config.prefix;
    if (brandPrefix) {
      // 品牌事件名沿用 v0.1 桥的既有命名，避免已上线的 H5 监听失效
      var suffix = ALIAS_SUFFIX[event] || event.replace(/^shell:/, '');
      try {
        window.dispatchEvent(new CustomEvent(brandPrefix + ':' + suffix, { detail: payload }));
      } catch (e) {}
    }
    listeners.forEach(function (entry) {
      if (entry.event === event) safeCall(entry.fn, payload);
    });
    return payload;
  }

  var listeners = [];
  // 契约事件 → 品牌事件后缀（兼容 v0.1 命名）
  var ALIAS_SUFFIX = {
    'shell:ready': 'shell-ready',
    'shell:resume': 'app-resume',
    'shell:pause': 'app-pause',
  };

  function safeCall(fn, arg) {
    try { fn(arg); } catch (e) { /* 订阅者异常不影响壳 */ }
  }

  // ---------------------------------------------------------------- 环境探测
  function detect() {
    if (window.ShellDesktop && window.ShellDesktop.isDesktopShell) return 'electron';
    if (window.process && window.process.versions && window.process.versions.electron) return 'electron';
    var c = window.Capacitor;
    if (c && typeof c.getPlatform === 'function') {
      var p = c.getPlatform();
      if (p === 'ios' || p === 'android') return 'capacitor';
    }
    var q = parseQuery();
    if (q.shell === 'mp' || /miniProgram/i.test(navigator.userAgent)) return 'mp';
    return 'web';
  }

  function parseQuery() {
    var out = {};
    try {
      var s = (location.search || '').replace(/^\?/, '');
      if (!s) return out;
      s.split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
        var v = decodeURIComponent(i < 0 ? '' : kv.slice(i + 1));
        out[k] = v;
      });
    } catch (e) {}
    return out;
  }

  function plugins() {
    var c = window.Capacitor;
    return (c && c.Plugins) || {};
  }

  // ---------------------------------------------------------------- 能力矩阵
  // 依据契约：✓ 支持 / ◐ 受限 / —— 仅占位（无实现）
  function buildCapabilities(env, P) {
    var has = function (k) { return !!(P && P[k]); };
    var cap = {};

    function set(name, mobile, desktop, mp) {
      cap[name] = env === 'capacitor' ? mobile : env === 'electron' ? desktop : env === 'mp' ? mp : 'web';
    }

    var hasWeb = typeof navigator !== 'undefined' && !!navigator.vibrate;

    set('vibrate', has('Haptics') || hasWeb ? '✓' : '◐', '─', '─');
    set('share', has('Share') ? '✓' : '─', '─', '─');
    set('geolocation', has('Geolocation') ? '✓' : '─', '─', '─');
    set('push', has('PushNotifications') ? '✓' : '─', '─', '─');
    set('haptics', has('Haptics') ? '✓' : '◐', '─', '─');
    set('statusBar', has('StatusBar') ? '✓' : '◐', '─', '─');
    set('splash', has('SplashScreen') ? '✓' : '◐', '─', '─');
    set('backButton', env === 'capacitor' && window.Capacitor.getPlatform() === 'android' ? '✓' : '◐', '─', '─');
    set('openExternal', has('Browser') ? '✓' : '◐', '✓', '◐');
    set('deeplink', env === 'capacitor' || env === 'electron' ? '✓' : '─', '✓', '─');
    set('network', true ? '✓' : '─', '✓', '◐');
    set('safeArea', true ? '✓' : '─', '✓', '✓');
    set('files', has('Filesystem') ? '✓' : '─', '✓', '─');
    set('camera', has('Camera') ? '✓' : '─', '─', '◐');
    set('biometric', has('BiometricAuth') ? '✓' : '─', '─', '─');
    set('offlineQueue', '✓', '✓', '─');
    set('subscribeMsg', '─', '─', '✓');

    return cap;
  }

  // ---------------------------------------------------------------- 网络状态
  function netState() {
    var on = navigator.onLine !== false;
    var type = 'unknown';
    try {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c && c.effectiveType) type = c.effectiveType;
    } catch (e) {}
    return { online: on, type: on ? type : 'offline', weak: !on || type === 'slow-2g' || type === '2g' };
  }

  // ---------------------------------------------------------------- 状态
  var state = { config: null, env: null, ready: false, capabilities: {}, platform: 'web' };

  // ---------------------------------------------------------------- 方法实现
  var P;

  function statusBar(opts) {
    if (!P.StatusBar) return err('E_UNSUPPORTED', 'statusBar');
    var o = opts || {};
    try {
      if (o.style) P.StatusBar.setStyle({ style: o.style === 'light' ? 'LIGHT' : 'DARK' });
      if (o.color && typeof P.StatusBar.setBackgroundColor === 'function') {
        P.StatusBar.setBackgroundColor({ color: o.color });
      }
      return ok();
    } catch (e) {
      return err('E_NATIVE', 'statusBar', e && e.message);
    }
  }

  function hideSplash() {
    if (!P.SplashScreen) return;
    try { P.SplashScreen.hide({ fadeOutDuration: 220 }); } catch (e) {}
  }

  var splashArmed = false;
  function armSplash() {
    if (splashArmed || !P.SplashScreen) return;
    splashArmed = true;
    requestAnimationFrame(function () {
      requestAnimationFrame(hideSplash);
    });
    setTimeout(hideSplash, 1600);
  }

  function vibrate(duration) {
    var single = typeof duration === 'number' && duration > 0;
    var pattern = single ? [0, duration] : [0, 14, 70, 14];
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
      return ok();
    }
    if (!P.Haptics) return err('E_UNSUPPORTED', 'vibrate');
    try {
      if (single) {
        P.Haptics.vibrate({ duration: duration });
      } else {
        var tap = function () {
          return P.Haptics.impact ? P.Haptics.impact({ style: 'LIGHT' }) : P.Haptics.vibrate();
        };
        tap();
        setTimeout(tap, 70);
      }
      return ok();
    } catch (e) {
      return err('E_NATIVE', 'vibrate', e && e.message);
    }
  }

  async function share(options) {
    if (!P.Share) return err('E_UNSUPPORTED', 'share');
    var o = options || {};
    try {
      await P.Share.share({ title: o.title, text: o.text, url: o.url });
      return ok();
    } catch (e) {
      return err('E_CANCELLED', 'share', e && e.message);
    }
  }

  async function getLocation(options) {
    if (!P.Geolocation) return err('E_UNSUPPORTED', 'geolocation');
    try {
      var pos = await P.Geolocation.getCurrentPosition({
        enableHighAccuracy: !!(options && options.highAccuracy),
      });
      return ok({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
    } catch (e) {
      return err('E_DENIED', 'geolocation', e && e.message);
    }
  }

  function openExternal(url) {
    if (!url) return err('E_BAD_ARGS', 'openExternal');
    if (P.Browser) {
      try { P.Browser.open({ url: url }); return ok(); } catch (e) { return err('E_NATIVE', 'openExternal', e && e.message); }
    }
    try { window.open(url, '_system'); return ok(); } catch (e) { return err('E_UNSUPPORTED', 'openExternal'); }
  }

  function pushRequest() {
    if (!P.PushNotifications) return err('E_UNSUPPORTED', 'push');
    return P.PushNotifications.requestPermissions().then(function (r) {
      if (r && r.receive === 'granted') {
        return P.PushNotifications.register().then(function () { return ok({ granted: true }); });
      }
      return err('E_DENIED', 'push');
    }).catch(function (e) {
      return err('E_NATIVE', 'push', e && e.message);
    });
  }

  function pushToken() {
    return ok({ token: window.__shellPushToken__ || null });
  }

  function switchEnd(id) {
    var ends = (state.config && state.config.ends) || {};
    if (!ends[id]) return err('E_BAD_ARGS', 'switchEnd');
    try { localStorage.setItem(state.config.endKey, id); } catch (e) {}
    emit('shell:end-changed', { id: id });
    location.replace(ends[id].url);
    return ok({ id: id });
  }

  function currentEnd() {
    var id = null;
    try { id = localStorage.getItem(state.config.endKey); } catch (e) {}
    if (!id) {
      var q = parseQuery();
      if (q.end) id = q.end;
    }
    return ok({ id: id });
  }

  // ---------------------------------------------------------------- 分发
  var METHODS = {
    'core.handshake': function () { return ok(handshakePayload()); },
    'core.capabilities': function () { return ok(state.capabilities); },
    'core.ready': function () { return ok({ ready: state.ready }); },
    'core.statusBar': statusBar,
    'core.splash': function () { hideSplash(); return ok(); },
    'core.vibrate': function (a) { return vibrate(a && a.duration); },
    'core.share': function (a) { return share(a); },
    'core.location': function (a) { return getLocation(a); },
    'core.openExternal': function (a) { return openExternal(a && a.url); },
    'core.push.request': pushRequest,
    'core.push.token': pushToken,
    'core.net': function () { return ok(netState()); },
    'core.end': function () { return currentEnd(); },
    'core.switchEnd': function (a) { return switchEnd(a && a.id); },
  };

  function ok(data) { return { ok: true, data: data === undefined ? null : data, at: nowMonotonic() }; }
  function err(code, method, message) { return { ok: false, code: code, method: method, message: message || '', at: nowMonotonic() }; }

  function call(method, args) {
    var fn = METHODS[method];
    if (!fn) return Promise.resolve(err('E_UNSUPPORTED', method));
    try {
      return Promise.resolve(fn(args || {})).catch(function (e) {
        return err('E_NATIVE', method, e && e.message);
      });
    } catch (e) {
      return Promise.resolve(err('E_NATIVE', method, e && e.message));
    }
  }

  function handshakePayload() {
    return {
      bridge: BRIDGE_VERSION,
      version: CORE_VERSION,
      brand: state.config.brand,
      platform: state.platform,
      env: state.env,
      capabilities: state.capabilities,
      ends: state.config.ends || {},
      end: currentEnd().data.id,
      accent: state.config.accent,
    };
  }

  // ---------------------------------------------------------------- 事件绑定
  function bindCapacitor() {
    var App = P.App;
    if (App && App.addListener) {
      App.addListener('appStateChange', function (s) {
        if (s && s.isActive) return emit('shell:resume');
        emit('shell:pause');
      });
      App.addListener('appUrlOpen', function (d) { emit('shell:deeplink', { url: d && d.url }); });
    }
    if (state.env === 'capacitor' && P.App && window.Capacitor.getPlatform() === 'android') {
      P.App.addListener('backButton', function (ev) {
        if (ev && ev.canGoBack) return window.history.back();
        if (typeof P.App.minimizeApp === 'function') P.App.minimizeApp();
      });
    }
    if (P.PushNotifications) {
      P.PushNotifications.addListener('registration', function (t) {
        window.__shellPushToken__ = t && t.value ? t.value : null;
        emit('shell:push-token', { token: window.__shellPushToken__ });
      });
      P.PushNotifications.addListener('registrationError', function (e) {
        emit('shell:error', { code: 'E_PUSH', message: (e && e.message) || '' });
      });
      P.PushNotifications.addListener('pushNotificationReceived', function (n) {
        emit('shell:push-received', n);
        vibrate();
      });
      P.PushNotifications.addListener('pushNotificationActionPerformed', function (n) {
        emit('shell:push-action', n);
      });
    }
  }

  function bindWeb() {
    window.addEventListener('online', function () { emit('shell:network', netState()); });
    window.addEventListener('offline', function () { emit('shell:network', netState()); });
    document.addEventListener('visibilitychange', function () {
      emit(document.hidden ? 'shell:pause' : 'shell:resume');
    });
  }

  // ---------------------------------------------------------------- H5 版本同频（沿用旧壳行为）
  function armH5Sync() {
    var SYNC = { hiddenMs: 5 * 60 * 1000, gapMs: 10 * 60 * 1000 };
    var hiddenAt = 0, syncing = false;
    function chunkPaths(root) {
      var list = (root || document).querySelectorAll('script[src*="/_next/static/chunks/"]');
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var raw = list[i].getAttribute('src');
        if (!raw) continue;
        try { out.push(new URL(raw, location.href).pathname); } catch (e) {}
      }
      return out;
    }
    function hasNewBuild(doc) {
      var remote = chunkPaths(doc);
      if (!remote.length) return false;
      var local = {};
      var cur = chunkPaths(document);
      for (var i = 0; i < cur.length; i++) local[cur[i]] = true;
      for (var j = 0; j < remote.length; j++) if (!local[remote[j]]) return true;
      return false;
    }
    function editing() {
      var el = document.activeElement;
      if (!el) return false;
      var tag = (el.tagName || '').toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }
    function last() { try { return Number(sessionStorage.getItem('shell:h5-sync') || 0); } catch (e) { return 0; } }
    function mark() { try { sessionStorage.setItem('shell:h5-sync', String(Date.now())); } catch (e) {} }
    async function run() {
      if (syncing || editing()) return;
      if (Date.now() - hiddenAt < SYNC.hiddenMs) return;
      if (Date.now() - last() < SYNC.gapMs) return;
      syncing = true;
      try {
        var res = await fetch(location.pathname + location.search, { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) return;
        var doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        if (hasNewBuild(doc)) { mark(); location.reload(); }
      } catch (e) {}
      finally { syncing = false; }
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      run();
    });
    window.addEventListener('shell:resume', run);
  }

  // ---------------------------------------------------------------- 视觉打磨
  function polish() {
    if (document.getElementById('shell-core-css')) return;
    var css = [
      'html{-webkit-tap-highlight-color:transparent;overscroll-behavior:none}',
      'body{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;overscroll-behavior-y:none}',
      '::-webkit-scrollbar{width:0;height:0}',
      'a,button{-webkit-tap-highlight-color:transparent;transition:transform .12s cubic-bezier(.2,.8,.2,1),opacity .12s ease}',
      'a:active,button:active{transform:scale(.975);opacity:.85}',
    ].join('');
    var style = document.createElement('style');
    style.id = 'shell-core-css';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    document.documentElement.classList.add('shell-native');
  }

  // ---------------------------------------------------------------- 启动
  function create(config) {
    if (window.Shell && window.Shell.__core) return window.Shell;

    state.config = config;
    state.env = detect();
    P = plugins();
    state.platform = state.env === 'capacitor' ? window.Capacitor.getPlatform() : state.env;
    state.capabilities = buildCapabilities(state.env, P);

    var Shell = {
      __core: true,
      version: CORE_VERSION,
      bridge: BRIDGE_VERSION,
      brand: config.brand,
      platform: state.platform,
      env: state.env,
      isMobileShell: state.env === 'capacitor' || state.env === 'mp',
      isDesktopShell: state.env === 'electron',
      capabilities: state.capabilities,
      ready: false,
      accent: config.accent,
      ends: config.ends,
      call: call,
      on: function (event, fn) {
        if (typeof fn !== 'function') return function () {};
        var entry = { event: event, fn: fn };
        listeners.push(entry);
        return function () {
          var i = listeners.indexOf(entry);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      off: function (event, fn) {
        listeners = listeners.filter(function (e) { return !(e.event === event && e.fn === fn); });
      },
    };

    // 便捷直调（契约示例用法）
    Shell.openExternal = openExternal;
    Shell.hideSplash = hideSplash;
    Shell.statusBar = statusBar;
    Shell.currentEnd = function () { return currentEnd().data.id; };
    Shell.switchEnd = function (id) { return switchEnd(id).ok; };

    // 兼容 v0.1 品牌桥的直调签名（H5 已上线的调用不变）
    Shell.shellVersion = CORE_VERSION;
    Shell.requestPushPermission = function () {
      return pushRequest().then(function (r) { return !!r.ok; });
    };
    Shell.getPushToken = function () {
      return Promise.resolve(window.__shellPushToken__ || null);
    };
    Shell.getLocation = function () {
      return getLocation().then(function (r) { return r.ok ? { lat: r.data.lat, lng: r.data.lng } : null; });
    };
    Shell.share = function (o) { return share(o).then(function () {}); };
    Shell.vibrate = function (d) { vibrate(d); };

    window.Shell = Shell;
    if (config.alias) window[config.alias] = Shell;

    if (state.env === 'capacitor') {
      polish();
      statusBar({ color: config.accent, style: config.statusBarStyle || 'dark' });
      armSplash();
      bindCapacitor();
    }
    // 小程序 web-view 与浏览器：只上报能力，不触碰原生
    bindWeb();
    armH5Sync();

    // 握手：延迟一拍，保证 H5 侧脚本先挂好监听
    setTimeout(function () {
      Shell.ready = true;
      emit('shell:ready', handshakePayload());
    }, 0);

    console.log('[shell-core] v' + CORE_VERSION + ' ready (' + state.env + ')');
    return Shell;
  }

  window.ShellCore = { version: CORE_VERSION, create: create, detect: detect };

  // 配置由 build.mjs 追加在文件末尾：ShellCore.create(<config>);
})();

ShellCore.create({
  "brand": "ziway",
  "name": "知味工场",
  "project": "ziway-app-shell",
  "file": "ziwayos-shell.js",
  "alias": "ziwayOS",
  "prefix": "ziwayos",
  "accent": "#F97316",
  "statusBarStyle": "dark",
  "endKey": "ziway.end",
  "ends": {
    "hp": {
      "url": "https://ziway-hp.ziway.cewaycloud.com/shop",
      "name": "个人端 · 铺主工作台"
    },
    "cp": {
      "url": "https://ziway-cp.ziway.cewaycloud.com/mall",
      "name": "客户端 · 通用大市场"
    },
    "ep": {
      "url": "https://ziway-ep.ziway.cewaycloud.com/",
      "name": "企业端 · 企业版"
    },
    "sp": {
      "url": "https://ziway-sp.ziway.cewaycloud.com/",
      "name": "生态端 · 生态版"
    }
  }
});
