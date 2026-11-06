/*! XSO 智慧企业 · 品牌桥 v0.2.0 — 由 shell-core 生成，勿手改。

  源：shell-core/src/core.js + shell-core/src/brands/xso.json
  契约：docs/shell-contract.md
  重新生成：node shell-core/build.mjs
*/

/**
 * BTOS 真实端壳 · 共享运行时（shell-core）
 *
 * 契约：docs/shell-contract.md（v0.3.2）
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

  var CORE_VERSION = '0.7.0';
  var BRIDGE_VERSION = '3';
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
    recordEvent(payload);
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

  // 最近事件环形缓冲：只记录、不自动重放，供 H5 断线恢复后对账（Shell.events.recent）
  var EVENT_LOG_MAX = 50;
  var eventLog = [];

  function recordEvent(payload) {
    eventLog.push(payload);
    if (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
  }

  // recent([event], [limit=20])：按时间正序返回最近 limit 条；event 可省略
  function recentEvents(event, limit) {
    var n = typeof event === 'number' ? event : limit;
    var name = typeof event === 'string' ? event : null;
    n = n === undefined ? 20 : Number(n);
    if (!isFinite(n) || n < 1) n = 20;
    if (n > EVENT_LOG_MAX) n = EVENT_LOG_MAX;
    var picked = name ? eventLog.filter(function (e) { return e.event === name; }) : eventLog.slice();
    return picked.slice(Math.max(0, picked.length - n));
  }

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

  // ---------------------------------------------------------------- 插件注册
  // 插件由 CLI 在品牌桥里以 ShellCore.registerPlugin(id, factory) 包裹嵌入；
  // 只允许构建期嵌入，禁止运行时远程加载。
  var PLUGIN_REGISTRY = { list: [], methods: {} };
  var RESERVED_NS = ['core', 'edge', 'offline', 'desktop', 'shell'];
  var IOT_TRANSPORTS = ['ble', 'serial', 'mqtt', 'nfc', 'gateway'];
  var IOT_ADAPTERS = [];
  var SECURE_ADAPTER = null;
  var CURRENT_PLUGIN_ID = null;

  // 构建期 IoT 适配器：插件 runtime 在 registerPlugin 工厂里调用；
  // 与插件生命周期绑定，插件注册失败时回滚，禁止运行时远程加载。
  function registerIotAdapter(spec) {
    if (!spec || typeof spec !== 'object') return false;
    var transport = spec.transport;
    if (typeof transport !== 'string' || IOT_TRANSPORTS.indexOf(transport) < 0) return false;
    if (typeof spec.id !== 'string' || !spec.id) return false;
    if (IOT_ADAPTERS.some(function (a) { return a.id === spec.id || a.transport === transport; })) return false;
    var fns = ['detect', 'devices', 'read', 'write', 'subscribe'];
    for (var i = 0; i < fns.length; i++) {
      if (spec[fns[i]] !== undefined && typeof spec[fns[i]] !== 'function') return false;
    }
    if (!spec.devices && !spec.read && !spec.write && !spec.subscribe) return false;
    if (spec.ingestUrl !== undefined && spec.ingestUrl !== null && typeof spec.ingestUrl !== 'string') return false;
    IOT_ADAPTERS.push({
      id: spec.id,
      transport: transport,
      capability: 'iot.' + transport,
      pluginId: CURRENT_PLUGIN_ID,
      detect: spec.detect || null,
      devices: spec.devices || null,
      read: spec.read || null,
      write: spec.write || null,
      subscribe: spec.subscribe || null,
      ingestUrl: typeof spec.ingestUrl === 'string' ? spec.ingestUrl : null,
      active: false,
    });
    return true;
  }

  function registerPlugin(id, factory) {
    var mark = IOT_ADAPTERS.length;
    var prevSecure = SECURE_ADAPTER;
    var prev = CURRENT_PLUGIN_ID;
    CURRENT_PLUGIN_ID = id;
    var accepted = false;
    try { accepted = registerPluginImpl(id, factory); } catch (e) { accepted = false; }
    CURRENT_PLUGIN_ID = prev;
    if (!accepted) {
      IOT_ADAPTERS.splice(mark);
      SECURE_ADAPTER = prevSecure;
    }
    return accepted;
  }

  // 构建期安全存储适配器：必须在 create 之前注册（原生壳在启动脚本里嵌入）。
  // 只允许一个后端；注册失败或插件回滚时回落内存。
  function registerSecureStore(spec) {
    if (SECURE_ADAPTER) return false;
    if (!spec || typeof spec !== 'object') return false;
    if (typeof spec.backend !== 'string' || ['keychain', 'keystore', 'native'].indexOf(spec.backend) < 0) return false;
    var fns = ['get', 'set', 'remove'];
    for (var i = 0; i < fns.length; i++) {
      if (typeof spec[fns[i]] !== 'function') return false;
    }
    if (spec.detect !== undefined && typeof spec.detect !== 'function') return false;
    SECURE_ADAPTER = {
      backend: spec.backend,
      pluginId: CURRENT_PLUGIN_ID,
      detect: spec.detect || null,
      get: spec.get,
      set: spec.set,
      remove: spec.remove,
      active: false,
    };
    return true;
  }

  function registerPluginImpl(id, factory) {
    if (typeof id !== 'string' || !id || typeof factory !== 'function') return false;
    for (var i = 0; i < PLUGIN_REGISTRY.list.length; i++) {
      if (PLUGIN_REGISTRY.list[i].id === id) return false;
    }
    var def;
    try { def = factory(); } catch (e) { return false; }
    if (!def || typeof def !== 'object') return false;

    var caps = def.capabilities || {};
    var methods = def.methods || {};
    var builtin = buildCapabilities('web', {});
    var item = {
      id: id,
      version: typeof def.version === 'string' ? def.version : '0.0.0',
      def: def,
      active: false,
      capabilities: [],
      methods: [],
      methodCaps: {},
    };

    for (var cap in caps) {
      if (!Object.prototype.hasOwnProperty.call(caps, cap)) continue;
      if (Object.prototype.hasOwnProperty.call(builtin, cap)) return false; // 内置能力不得重名
      for (var j = 0; j < PLUGIN_REGISTRY.list.length; j++) {
        if (PLUGIN_REGISTRY.list[j].capabilities.indexOf(cap) >= 0) return false; // 多 provider 未声明优先级
      }
      item.capabilities.push(cap);
    }
    for (var m in methods) {
      if (!Object.prototype.hasOwnProperty.call(methods, m)) continue;
      var ns = String(m).split('.')[0];
      if (RESERVED_NS.indexOf(ns) >= 0) return false; // 禁止占用内置命名空间
      var owner = null;
      for (var c = 0; c < item.capabilities.length; c++) {
        var cap = item.capabilities[c];
        if (String(m).indexOf(cap + '.') === 0 && (!owner || cap.length > owner.length)) owner = cap;
      }
      if (!owner) return false; // 方法必须落在插件声明的能力命名空间（支持 iot.ble 这类多点能力）
      if (METHODS[m] || PLUGIN_REGISTRY.methods[m]) return false; // 方法重名
      if (typeof methods[m] !== 'function') return false;
      item.methods.push(m);
      item.methodCaps[m] = owner;
    }
    if (!item.capabilities.length || !item.methods.length) return false;

    for (var k = 0; k < item.methods.length; k++) {
      PLUGIN_REGISTRY.methods[item.methods[k]] = {
        plugin: item,
        fn: methods[item.methods[k]],
        cap: item.methodCaps[item.methods[k]],
      };
    }
    PLUGIN_REGISTRY.list.push(item);
    return true;
  }

  // 插件声明的能力只在 detect(env) 为真时记 ✓，否则回落 ─
  function pluginCapabilities() {
    var cap = {};
    for (var i = 0; i < PLUGIN_REGISTRY.list.length; i++) {
      var item = PLUGIN_REGISTRY.list[i];
      for (var j = 0; j < item.capabilities.length; j++) {
        var name = item.capabilities[j];
        var v = item.def.capabilities[name];
        cap[name] = item.active
          ? (['✓', '◐', '─', 'web'].indexOf(v) >= 0 ? v : '✓')
          : '─';
      }
    }
    return cap;
  }

  function pluginList() {
    return PLUGIN_REGISTRY.list.map(function (p) {
      return { id: p.id, version: p.version, active: p.active };
    });
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
    // 安全存储：有构建期原生后端时由 create 提升为 ✓，否则内存降级 ◐
    cap.secureStore = '◐';
    // 设备身份：默认 none；配置 security.identity 后由 create 点亮（v0.8 M2）
    cap.identity = '─';
    // IoT 总开关：内置占位，由构建期适配器插件点亮 iot.* 子能力（v0.7）
    cap.iot = '─';
    cap['edge.storeRoot'] = '✓';

    return cap;
  }

  // ---------------------------------------------------------------- 能力白名单
  // caps.allow 是构建期裁剪：只收窄能力位、拦住对应方法，不是权限边界（鉴权仍归云根）。
  var CAP_METHODS = {
    vibrate: ['core.vibrate'],
    share: ['core.share'],
    geolocation: ['core.location'],
    push: ['core.push.request', 'core.push.token'],
    statusBar: ['core.statusBar'],
    splash: ['core.splash'],
    network: ['core.net'],
    offlineQueue: ['offline.enqueue', 'offline.flush', 'offline.list'],
    secureStore: ['secure.get', 'secure.set', 'secure.remove'],
    identity: ['identity.current', 'identity.refresh'],
    iot: ['iot.devices', 'iot.read', 'iot.write'],
    'edge.storeRoot': ['edge.configure', 'edge.health', 'edge.lease', 'edge.commit', 'edge.snapshot'],
  };
  var allowCaps = null; // null = 不裁剪

  function pluginCapabilityMap() {
    var map = {};
    for (var i = 0; i < PLUGIN_REGISTRY.list.length; i++) {
      var item = PLUGIN_REGISTRY.list[i];
      for (var j = 0; j < item.capabilities.length; j++) map[item.capabilities[j]] = true;
    }
    return map;
  }

  // 键保留、值置 ─：能力矩阵形状不变，握手与 core.capabilities 自动正确
  function cutCapabilities(raw) {
    if (allowCaps === null) return raw;
    var builtin = buildCapabilities('web', {});
    var pluginCaps = pluginCapabilityMap();
    var out = {};
    for (var k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      var cuttable = Object.prototype.hasOwnProperty.call(builtin, k) || pluginCaps[k];
      var cut = cuttable && allowCaps.indexOf(k) < 0;
      // 关掉 iot 总开关时，适配器子能力一并置 ─
      if (!cut && k.indexOf('iot.') === 0 && allowCaps.indexOf('iot') < 0) cut = true;
      out[k] = cut ? '─' : raw[k];
    }
    // 安全存储被裁剪时，设备身份没有可用的令牌落点，一并降级
    if (out.secureStore === '─') out.identity = '─';
    return out;
  }

  function capAllowed(cap) {
    if (allowCaps === null) return true;
    if (allowCaps.indexOf(cap) >= 0) return true;
    return cap.indexOf('iot.') === 0 && allowCaps.indexOf('iot') >= 0;
  }

  function blockedCapability(method) {
    if (allowCaps === null) return null;
    for (var cap in CAP_METHODS) {
      if (CAP_METHODS[cap].indexOf(method) >= 0) return allowCaps.indexOf(cap) < 0 ? cap : null;
    }
    return null;
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
    // 桌面壳：走 Electron 原生 shell.openExternal，避免在应用内开新窗口
    if (window.ShellDesktop && typeof window.ShellDesktop.openExternal === 'function') {
      try {
        Promise.resolve(window.ShellDesktop.openExternal(url)).catch(function () {});
        return ok();
      } catch (e) {
        return err('E_NATIVE', 'openExternal', e && e.message);
      }
    }
    if (P.Browser) {
      try { P.Browser.open({ url: url }); return ok(); } catch (e) { return err('E_NATIVE', 'openExternal', e && e.message); }
    }
    try { window.open(url, '_system'); return ok(); } catch (e) { return err('E_UNSUPPORTED', 'openExternal'); }
  }

  // ---------------------------------------------------------------- 桌面能力
  var DESKTOP_METHODS = {
    openExternal: true, openPath: true, revealFile: true, paths: true, writeTemp: true,
  };

  function desktopCapabilities() {
    var d = window.ShellDesktop;
    if (!d) return {};
    var caps = {};
    Object.keys(DESKTOP_METHODS).forEach(function (k) {
      if (typeof d[k] === 'function') caps[k] = '✓';
    });
    return caps;
  }

  // ---------------------------------------------------------------- 主题
  // 只作用于壳自有页面（选择页 / 启动兜底 / 错误页），远程 H5 不强制套用。
  // 颜色、圆角、字号全部落成 CSS 变量，页面模板不写死色值。
  var THEME_DEFAULTS = {
    light: { accent: '#4C8DFF', bg: '#FFFFFF', surface: '#F6F9FD', ink: '#0B1220', inkMuted: '#7B8AA0', line: '#E4E9F2', radius: 16, fontScale: 1 },
    dark: { accent: '#4C8DFF', bg: '#0E1218', surface: '#161C26', ink: '#E8EEF7', inkMuted: '#8A98AD', line: '#253041', radius: 16, fontScale: 1 },
  };
  var THEME_COLOR_VARS = {
    bg: '--uendos-bg',
    surface: '--uendos-surface',
    ink: '--uendos-ink',
    inkMuted: '--uendos-ink-muted',
    line: '--uendos-line',
    accent: '--uendos-accent',
  };
  var FONT_SIZES = { xs: 11, sm: 12, base: 13.5, lg: 18, xl: 24 };

  function resolveTheme(theme, accent) {
    var mode = (theme && theme.mode) || 'light';
    var def = THEME_DEFAULTS[mode] || THEME_DEFAULTS.light;
    var tokens = {};
    for (var k in def) tokens[k] = def[k];
    if (theme && theme.tokens) {
      for (var t in theme.tokens) {
        if (Object.prototype.hasOwnProperty.call(tokens, t)) tokens[t] = theme.tokens[t];
      }
    }
    if (accent && !(theme && theme.tokens && theme.tokens.accent)) tokens.accent = accent;
    return { mode: mode, tokens: tokens };
  }

  function setCssVar(style, name, value) {
    try {
      if (typeof style.setProperty === 'function') style.setProperty(name, String(value));
      else style[name] = String(value);
    } catch (e) {}
  }

  function applyTheme(theme, accent) {
    var r = resolveTheme(theme, accent);
    try {
      var style = document.documentElement && document.documentElement.style;
      if (style) {
        for (var key in THEME_COLOR_VARS) setCssVar(style, THEME_COLOR_VARS[key], r.tokens[key]);
        setCssVar(style, '--uendos-radius', r.tokens.radius + 'px');
        setCssVar(style, '--uendos-font-scale', r.tokens.fontScale);
        for (var f in FONT_SIZES) setCssVar(style, '--uendos-fs-' + f, (FONT_SIZES[f] * r.tokens.fontScale) + 'px');
        setCssVar(style, 'color-scheme', r.mode);
      }
    } catch (e) {}
    try {
      var meta = document.querySelector ? document.querySelector('meta[name="theme-color"]') : null;
      if (!meta && document.createElement) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        (document.head || document.documentElement).appendChild(meta);
      }
      if (meta) meta.setAttribute('content', r.tokens.accent);
    } catch (e) {}
    return r;
  }

  // ---------------------------------------------------------------- 店根适配器
  // 店根在店内局域网（默认 http://127.0.0.1:7321，桌面壳即店根本机）。
  // 超时 3s：门店 Wi-Fi 抖动时快速失败，由调用方决定回落到离线队列。
  var EDGE_KEY = 'shell:edge';
  var EDGE_TIMEOUT = 3000;

  function edgeConfig() {
    var cfg = {};
    try { cfg = JSON.parse(localStorage.getItem(EDGE_KEY) || '{}'); } catch (e) {}
    if (!cfg.baseUrl) {
      // 桌面壳自带店根：默认本机端口；移动壳需要显式配置门店地址
      if (window.ShellDesktop) cfg.baseUrl = 'http://127.0.0.1:7321';
      else {
        var q = parseQuery();
        if (q.edge) cfg.baseUrl = q.edge;
      }
    }
    return cfg;
  }

  function edgeConfigure(opts) {
    var o = opts || {};
    if (!o.baseUrl) return err('E_BAD_ARGS', 'edge.configure');
    var cfg = { baseUrl: String(o.baseUrl).replace(/\/$/, ''), token: o.token || '', deviceId: o.deviceId || null };
    try { localStorage.setItem(EDGE_KEY, JSON.stringify(cfg)); } catch (e) {}
    return ok(cfg);
  }

  async function edgeFetch(path, init) {
    var cfg = edgeConfig();
    if (!cfg.baseUrl) return err('E_UNSUPPORTED', 'edge', '未配置店根地址');
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, EDGE_TIMEOUT) : null;
    try {
      var headers = { 'Content-Type': 'application/json' };
      if (cfg.token) headers.authorization = 'Bearer ' + cfg.token;
      var res = await fetch(cfg.baseUrl + path, Object.assign({ headers: headers, signal: ctrl && ctrl.signal, cache: 'no-store' }, init || {}));
      var body = null;
      try { body = await res.json(); } catch (e) {}
      if (!res.ok) {
        var code = (body && body.code) || 'E_EDGE';
        var out = err(code === 'stock' ? 'E_STOCK' : code === 'limit' ? 'E_LIMIT' : code === 'lease_expired' || code === 'lease_unknown' ? 'E_LEASE' : 'E_EDGE', 'edge');
        out.status = res.status;
        out.data = body;
        return out;
      }
      return ok(body);
    } catch (e) {
      return err('E_EDGE_OFFLINE', 'edge', e && e.message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function edgeHealth() { return edgeFetch('/edge/health'); }

  async function edgeLease(opts) {
    var cfg = edgeConfig();
    var body = {
      deviceId: (opts && opts.deviceId) || cfg.deviceId || (shellDeviceId()),
      ttlMs: (opts && opts.ttlMs) || undefined,
    };
    var r = await edgeFetch('/edge/lease', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) {
      _lease = { id: r.data.leaseId, expires: r.data.expires };
    }
    return r;
  }

  var _lease = null;
  function edgeLeaseId() {
    if (_lease && _lease.expires > Date.now()) return _lease.id;
    return null;
  }

  async function edgeCommit(opts) {
    var o = opts || {};
    if (!Array.isArray(o.ops) || !o.ops.length) return err('E_BAD_ARGS', 'edge.commit');
    var leaseId = o.leaseId || edgeLeaseId();
    if (!leaseId) {
      var lr = await edgeLease({});
      if (!lr.ok) return lr;
      leaseId = lr.data.leaseId;
    }
    var r = await edgeFetch('/edge/commit', { method: 'POST', body: JSON.stringify({ leaseId: leaseId, ops: o.ops }) });
    // 店内不可达且调用方允许回落：转离线队列（队列重放目标仍是店根路径）
    if (!r.ok && o.fallback === 'queue' && r.code === 'E_EDGE_OFFLINE') {
      for (var i = 0; i < o.ops.length; i++) {
        enqueue({ url: edgeConfig().baseUrl + '/edge/commit', method: 'POST', body: { leaseId: leaseId, ops: [o.ops[i]] }, headers: { authorization: edgeConfig().token ? 'Bearer ' + edgeConfig().token : '' } });
      }
      return ok({ queued: o.ops.length });
    }
    return r;
  }

  function shellDeviceId() {
    var k = 'shell:device-id';
    var v = null;
    try { v = localStorage.getItem(k); } catch (e) {}
    if (!v) {
      v = uuid();
      try { localStorage.setItem(k, v); } catch (e) {}
    }
    return v;
  }

  // 条目：{ idem, method, url, body, at, tries }
  // 规则：幂等键由端生成；联网后按入队顺序重放；4xx 视为永久失败并出队，5xx/网络错误保留重试。
  // 队列按品牌作用域隔离：同源多品牌共用 localStorage 时互不串队。
  var QUEUE_BASE_KEY = 'shell:offline-queue';
  var flushing = false;

  function queueKey() {
    var prefix = state.config && state.config.prefix;
    return prefix ? QUEUE_BASE_KEY + ':' + prefix : QUEUE_BASE_KEY;
  }

  // 兼容旧版裸数组：读到即迁移为版本化信封 {v:1,items:[]}
  function queueParse(raw) {
    if (!raw) return null;
    try {
      var v = JSON.parse(raw);
      if (Array.isArray(v)) return { items: v };
      if (v && typeof v === 'object' && Array.isArray(v.items)) return { items: v.items };
    } catch (e) {}
    return null;
  }

  function queueRead() {
    var key = queueKey();
    var raw = null;
    try { raw = localStorage.getItem(key); } catch (e) {}
    // 作用域键存在（即使是空信封）即以它为准，避免旧队列被反复迁移
    if (raw !== null) {
      var cur = queueParse(raw);
      return cur ? cur.items : [];
    }
    try {
      var old = queueParse(localStorage.getItem(QUEUE_BASE_KEY));
      if (old && old.items.length) {
        var items = old.items.slice(0, 200);
        try { localStorage.setItem(key, JSON.stringify({ v: 1, items: items })); } catch (e) {}
        return items;
      }
    } catch (e) {}
    return [];
  }

  function queueWrite(list) {
    try { localStorage.setItem(queueKey(), JSON.stringify({ v: 1, items: list.slice(0, 200) })); } catch (e) {}
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxx-xxxx-4xxx-yxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    }) + '-' + Date.now();
  }

  function enqueue(item) {
    var it = item || {};
    if (!it.url || !it.method) return err('E_BAD_ARGS', 'offline.enqueue');
    var entry = {
      idem: it.idem || uuid(),
      method: String(it.method).toUpperCase(),
      url: it.url,
      body: it.body === undefined ? null : it.body,
      headers: it.headers || {},
      at: Date.now(),
      tries: 0,
    };
    var list = queueRead();
    list.push(entry);
    queueWrite(list);
    emit('shell:queued', { idem: entry.idem, count: list.length });
    if (netState().online) flush();
    return ok({ idem: entry.idem, count: list.length });
  }

  async function flush() {
    if (flushing || !netState().online) return ok({ flushed: 0 });
    flushing = true;
    var list = queueRead();
    var kept = [];
    var sent = 0;
    try {
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        try {
          var res = await fetch(e.url, {
            method: e.method,
            headers: Object.assign({ 'Content-Type': 'application/json', 'X-Idem-Key': e.idem }, e.headers || {}),
            body: e.body === null ? undefined : JSON.stringify(e.body),
            credentials: 'same-origin',
          });
          if (res.status >= 400 && res.status < 500) {
            emit('shell:queue-failed', { idem: e.idem, status: res.status });
            continue; // 4xx 永久失败，出队
          }
          if (!res.ok) throw new Error('status ' + res.status);
          sent++;
          emit('shell:queue-replayed', { idem: e.idem, status: res.status });
        } catch (x) {
          e.tries = (e.tries || 0) + 1;
          kept.push(e);
        }
      }
      queueWrite(kept);
    } finally {
      flushing = false;
    }
    if (sent) emit('shell:queue-drained', { sent: sent, left: kept.length });
    return ok({ flushed: sent, left: kept.length });
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

  // ---------------------------------------------------------------- IoT 接入
  function iotOn() {
    return !!(state.capabilities && state.capabilities.iot && state.capabilities.iot !== '─');
  }

  function activeIotAdapters() {
    return IOT_ADAPTERS.filter(function (a) { return a.active; });
  }

  function normalizeIotDevice(raw, adapter) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
    var status = ['online', 'offline', 'unknown'].indexOf(raw.status) >= 0 ? raw.status : 'unknown';
    return {
      id: raw.id,
      kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'device',
      transport: typeof raw.transport === 'string' && raw.transport ? raw.transport : adapter.transport,
      status: status,
      capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.slice() : [],
    };
  }

  async function iotDevices() {
    if (!iotOn()) return err('E_UNSUPPORTED', 'iot.devices', '能力未启用：iot');
    var ads = activeIotAdapters();
    if (!ads.length) return err('E_UNSUPPORTED', 'iot.devices', '未安装 IoT 适配器');
    var out = [];
    var seen = {};
    for (var i = 0; i < ads.length; i++) {
      var ad = ads[i];
      if (!ad.devices) continue;
      var list;
      try { list = await ad.devices(); } catch (e) {
        emit('shell:iot-error', { transport: ad.transport, code: 'E_NATIVE', message: (e && e.message) || '' });
        continue;
      }
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) {
        var d = normalizeIotDevice(list[j], ad);
        if (!d) continue;
        var key = d.transport + ':' + d.id;
        if (seen[key]) continue;
        seen[key] = true;
        out.push(d);
      }
    }
    return ok({ devices: out });
  }

  async function iotRead(a) {
    if (!iotOn()) return err('E_UNSUPPORTED', 'iot.read', '能力未启用：iot');
    var args = a || {};
    if (typeof args.deviceId !== 'string' || !args.deviceId) {
      return err('E_BAD_ARGS', 'iot.read', 'deviceId 必填');
    }
    var ads = activeIotAdapters();
    for (var i = 0; i < ads.length; i++) {
      var ad = ads[i];
      if (!ad.read) continue;
      try {
        var r = await ad.read(args.deviceId, args.metric === undefined ? null : args.metric);
        if (r && typeof r.value !== 'undefined') {
          return ok({
            value: r.value,
            unit: r.unit === undefined ? null : r.unit,
            at: typeof r.at === 'number' ? r.at : Date.now(),
            quality: ['good', 'degraded', 'stale', 'unknown'].indexOf(r.quality) >= 0 ? r.quality : 'unknown',
          });
        }
      } catch (e) {
        emit('shell:iot-error', {
          transport: ad.transport,
          deviceId: args.deviceId,
          metric: args.metric === undefined ? null : args.metric,
          code: 'E_NATIVE',
          message: (e && e.message) || '',
        });
      }
    }
    return err('E_UNSUPPORTED', 'iot.read', '设备或指标不可用');
  }

  async function iotWrite(a) {
    if (!iotOn()) return err('E_UNSUPPORTED', 'iot.write', '能力未启用：iot');
    var args = a || {};
    if (typeof args.deviceId !== 'string' || !args.deviceId) return err('E_BAD_ARGS', 'iot.write', 'deviceId 必填');
    if (typeof args.action !== 'string' || !args.action) return err('E_BAD_ARGS', 'iot.write', 'action 必填');
    if (typeof args.idem !== 'string' || !args.idem) return err('E_BAD_ARGS', 'iot.write', 'idem 必填（幂等键）');

    var ads = activeIotAdapters();
    if (!ads.length) return err('E_UNSUPPORTED', 'iot.write', '未安装 IoT 适配器');

    var ackId = 'ack-' + uuid();
    var done = false;
    function finish(r) {
      if (done) return;
      done = true;
      var res = r || {};
      emit('shell:iot-ack', {
        ackId: ackId,
        deviceId: args.deviceId,
        action: args.action,
        idem: args.idem,
        ok: res.ok !== false,
        code: res.code || null,
        message: res.message || '',
        data: res.data === undefined ? null : res.data,
      });
    }

    for (var i = 0; i < ads.length; i++) {
      var ad = ads[i];
      if (!ad.write) continue;
      try {
        var r = await ad.write(args.deviceId, args.action, args.params || {}, finish);
        if (r && r.accepted === false) continue;
        if (r && typeof r.ackId === 'string' && r.ackId) ackId = r.ackId;
        if (r && typeof r.ok === 'boolean') finish({ ok: r.ok, code: r.code, message: r.message, data: r.data });
        return ok({ accepted: true, ackId: ackId });
      } catch (e) {
        emit('shell:iot-error', {
          transport: ad.transport,
          deviceId: args.deviceId,
          action: args.action,
          code: 'E_NATIVE',
          message: (e && e.message) || '',
        });
      }
    }
    return err('E_UNSUPPORTED', 'iot.write', '设备不可用');
  }

  // 适配器上行：统一信封 v1；离线且有 ingestUrl 时进入品牌作用域队列
  function iotPublish(adapter, raw) {
    if (!iotOn() || !raw || typeof raw !== 'object') return;
    if (typeof raw.deviceId !== 'string' || !raw.deviceId) return;
    if (typeof raw.metric !== 'string' || !raw.metric) return;
    var data = {
      v: 1,
      deviceId: raw.deviceId,
      kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'telemetry',
      metric: raw.metric,
      value: typeof raw.value === 'undefined' ? null : raw.value,
      unit: raw.unit === undefined ? null : raw.unit,
      at: nowMonotonic(),
      seq: seq + 1,
      idem: typeof raw.idem === 'string' && raw.idem ? raw.idem : uuid(),
      quality: ['good', 'degraded', 'stale', 'unknown'].indexOf(raw.quality) >= 0 ? raw.quality : 'unknown',
      source: typeof raw.source === 'string' && raw.source ? raw.source : adapter.transport,
    };
    emit('shell:iot-data', data);
    if (!netState().online && adapter.ingestUrl) {
      enqueue({ url: adapter.ingestUrl, method: 'POST', body: data, idem: data.idem });
    }
  }

  // ---------------------------------------------------------------- 安全存储
  // 凭证边界：只允许字符串、品牌前缀键、单值 ≤ 8 KB；内存降级不落 localStorage。
  var SECURE_MEMORY = Object.create(null);
  var SECURE_MAX_VALUE = 8192;

  function securePrefix() {
    var cfg = state.config || {};
    return (cfg.prefix || cfg.brand || '') + ':';
  }

  function secureBackend() {
    return SECURE_ADAPTER && SECURE_ADAPTER.active ? SECURE_ADAPTER.backend : 'memory';
  }

  function secureOn() {
    return state.capabilities.secureStore !== undefined && state.capabilities.secureStore !== '─';
  }

  function secureKeyError(key) {
    if (typeof key !== 'string' || !key) return 'key 必填';
    var prefix = securePrefix();
    if (key.indexOf(prefix) !== 0) return 'key 必须以 ' + prefix + ' 开头';
    var purpose = key.slice(prefix.length);
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(purpose)) return 'key 的 purpose 不合法（字母开头，≤ 64）';
    return null;
  }

  function secureSet(a) {
    if (!secureOn()) return err('E_UNSUPPORTED', 'secure.set', '能力未启用：secureStore');
    var key = a && a.key;
    var value = a && a.value;
    var kerr = secureKeyError(key);
    if (kerr) return err('E_BAD_ARGS', 'secure.set', kerr);
    if (typeof value !== 'string') return err('E_BAD_ARGS', 'secure.set', 'value 必须是字符串');
    if (value.length > SECURE_MAX_VALUE) return err('E_BAD_ARGS', 'secure.set', 'value 超过 ' + SECURE_MAX_VALUE + ' 字符');
    if (SECURE_ADAPTER && SECURE_ADAPTER.active) {
      var backend = SECURE_ADAPTER.backend;
      return Promise.resolve().then(function () {
        return SECURE_ADAPTER.set(key, value);
      }).then(function (r) {
        if (r === false) throw new Error('安全存储拒绝写入');
        return ok({ stored: true, backend: backend });
      }).catch(function (e) {
        return err('E_NATIVE', 'secure.set', e && e.message);
      });
    }
    SECURE_MEMORY[key] = value;
    return ok({ stored: true, backend: 'memory' });
  }

  function secureGet(a) {
    if (!secureOn()) return err('E_UNSUPPORTED', 'secure.get', '能力未启用：secureStore');
    var key = a && a.key;
    var kerr = secureKeyError(key);
    if (kerr) return err('E_BAD_ARGS', 'secure.get', kerr);
    if (SECURE_ADAPTER && SECURE_ADAPTER.active) {
      var backend = SECURE_ADAPTER.backend;
      return Promise.resolve().then(function () {
        return SECURE_ADAPTER.get(key);
      }).then(function (v) {
        return ok({ value: typeof v === 'string' ? v : null, backend: backend });
      }).catch(function (e) {
        return err('E_NATIVE', 'secure.get', e && e.message);
      });
    }
    var hit = Object.prototype.hasOwnProperty.call(SECURE_MEMORY, key);
    return ok({ value: hit ? SECURE_MEMORY[key] : null, backend: 'memory' });
  }

  function secureRemove(a) {
    if (!secureOn()) return err('E_UNSUPPORTED', 'secure.remove', '能力未启用：secureStore');
    var key = a && a.key;
    var kerr = secureKeyError(key);
    if (kerr) return err('E_BAD_ARGS', 'secure.remove', kerr);
    if (SECURE_ADAPTER && SECURE_ADAPTER.active) {
      var backend = SECURE_ADAPTER.backend;
      return Promise.resolve().then(function () {
        return SECURE_ADAPTER.remove(key);
      }).then(function (r) {
        return ok({ removed: r !== false, backend: backend });
      }).catch(function (e) {
        return err('E_NATIVE', 'secure.remove', e && e.message);
      });
    }
    var hit = Object.prototype.hasOwnProperty.call(SECURE_MEMORY, key);
    if (hit) delete SECURE_MEMORY[key];
    return ok({ removed: hit, backend: 'memory' });
  }

  // ---------------------------------------------------------------- 设备身份
  // 设备令牌只存安全存储，identity.current 只返回元数据；令牌不进入 H5、事件与诊断。
  var IDENTITY_DEFAULT_PURPOSE = 'identity.device';
  var IDENTITY_REFRESH_INFLIGHT = null;

  function identityConfig() {
    var sec = state.config && state.config.security;
    var id = sec && sec.identity;
    return id && id.mode === 'device' ? id : null;
  }

  function identityMode() {
    return identityConfig() ? 'device' : 'none';
  }

  function identityStoreKey() {
    var cfg = identityConfig();
    if (cfg && cfg.storeKey) return cfg.storeKey;
    var prefix = (state.config && (state.config.prefix || state.config.brand)) || '';
    return prefix + ':' + IDENTITY_DEFAULT_PURPOSE;
  }

  function identityEnabled() {
    return !!identityConfig()
      && state.capabilities.identity !== undefined && state.capabilities.identity !== '─'
      && state.capabilities.secureStore !== undefined && state.capabilities.secureStore !== '─';
  }

  function secureRawGet(key) {
    if (SECURE_ADAPTER && SECURE_ADAPTER.active) return Promise.resolve(SECURE_ADAPTER.get(key));
    return Promise.resolve(Object.prototype.hasOwnProperty.call(SECURE_MEMORY, key) ? SECURE_MEMORY[key] : null);
  }

  function secureRawSet(key, value) {
    if (SECURE_ADAPTER && SECURE_ADAPTER.active) return Promise.resolve(SECURE_ADAPTER.set(key, value));
    SECURE_MEMORY[key] = value;
    return Promise.resolve(true);
  }

  function secureRawRemove(key) {
    if (SECURE_ADAPTER && SECURE_ADAPTER.active) return Promise.resolve(SECURE_ADAPTER.remove(key));
    var hit = Object.prototype.hasOwnProperty.call(SECURE_MEMORY, key);
    if (hit) delete SECURE_MEMORY[key];
    return Promise.resolve(hit);
  }

  function identityRecord(raw) {
    if (typeof raw !== 'string') return null;
    try {
      var r = JSON.parse(raw);
      if (!r || typeof r !== 'object') return null;
      if (typeof r.token !== 'string' || !r.token) return null;
      return r;
    } catch (e) {
      return null;
    }
  }

  function identityMeta(rec) {
    return {
      deviceId: rec.deviceId || null,
      owner: rec.owner || null,
      scopes: Array.isArray(rec.scopes) ? rec.scopes.slice() : [],
      expiresAt: rec.expiresAt || null,
      source: 'device',
    };
  }

  function identityCurrent() {
    if (!identityEnabled()) return err('E_UNSUPPORTED', 'identity.current', '未配置 security.identity');
    return secureRawGet(identityStoreKey()).then(function (raw) {
      var rec = identityRecord(raw);
      return ok({ identity: rec ? identityMeta(rec) : null, backend: secureBackend() });
    }).catch(function (e) {
      return err('E_NATIVE', 'identity.current', e && e.message);
    });
  }

  function identityRequest(rec, cfg) {
    return Promise.resolve().then(function () {
      return fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + rec.token },
        body: JSON.stringify({ device_id: rec.deviceId }),
      });
    }).then(function (res) {
      return Promise.resolve().then(function () { return res.json(); }).catch(function () { return null; }).then(function (body) {
        return { status: res.status, ok: !!res.ok, body: body };
      });
    });
  }

  function identityRefresh() {
    if (!identityEnabled()) return Promise.resolve(err('E_UNSUPPORTED', 'identity.refresh', '未配置 security.identity'));
    // 幂等：并发刷新复用同一请求，避免两次换令牌互相覆盖
    if (IDENTITY_REFRESH_INFLIGHT) return IDENTITY_REFRESH_INFLIGHT;
    if (!netState().online) return Promise.resolve(err('E_OFFLINE', 'identity.refresh', '离线，稍后重试'));
    var cfg = identityConfig();
    var key = identityStoreKey();
    IDENTITY_REFRESH_INFLIGHT = secureRawGet(key).then(function (raw) {
      var rec = identityRecord(raw);
      if (!rec) return err('E_UNSUPPORTED', 'identity.refresh', '设备未配对：无设备令牌');
      return identityRequest(rec, cfg).then(function (res) {
        if (res.status === 401 || res.status === 403 || res.status === 410) {
          return secureRawRemove(key).then(function () {
            emit('shell:identity-expired', { code: 'E_DENIED', deviceId: rec.deviceId || null });
            return err('E_DENIED', 'identity.refresh', '设备令牌已吊销或过期');
          });
        }
        if (!res.ok || !res.body) return err('E_NATIVE', 'identity.refresh', '刷新失败：HTTP ' + res.status);
        var b = res.body;
        var token = b.device_token || b.deviceToken;
        if (typeof token !== 'string' || !token) return err('E_NATIVE', 'identity.refresh', '响应缺少 device_token');
        var next = {
          deviceId: b.device_id || b.deviceId || rec.deviceId || null,
          token: token,
          owner: b.owner_xu || b.owner || rec.owner || null,
          scopes: Array.isArray(b.scopes) ? b.scopes : (rec.scopes || []),
          expiresAt: b.expires_at || b.expiresAt || null,
          obtainedAt: Date.now(),
        };
        return secureRawSet(key, JSON.stringify(next)).then(function (stored) {
          if (stored === false) return err('E_NATIVE', 'identity.refresh', '安全存储拒绝写入');
          var meta = identityMeta(next);
          emit('shell:identity-changed', meta);
          return ok(meta);
        });
      });
    }).catch(function (e) {
      return err('E_OFFLINE', 'identity.refresh', (e && e.message) || '网络不可用');
    }).then(function (r) {
      IDENTITY_REFRESH_INFLIGHT = null;
      return r;
    });
    return IDENTITY_REFRESH_INFLIGHT;
  }

  // 到 TTL 80% 主动刷新：离线不发请求，联网后由事件补一次；失败不阻塞本地操作
  function identityMaybeRefresh() {
    if (!identityEnabled() || !netState().online) return;
    secureRawGet(identityStoreKey()).then(function (raw) {
      var rec = identityRecord(raw);
      if (!rec) return;
      var exp = Date.parse(rec.expiresAt);
      var obtained = Number(rec.obtainedAt);
      if (!isFinite(exp) || !obtained || exp <= obtained) return;
      if (Date.now() >= obtained + (exp - obtained) * 0.8) identityRefresh();
    }).catch(function () {});
  }

  // ---------------------------------------------------------------- 诊断
  // 只做只读快照：事件只保留 event/seq/at，不携带 data（避免 token、设备唯一码、地址等外泄）
  function diagnostics() {
    var q = queueRead();
    var oldestAt = null;
    for (var i = 0; i < q.length; i++) {
      var at = q[i] && q[i].at;
      if (typeof at === 'number' && (oldestAt === null || at < oldestAt)) oldestAt = at;
    }
    var events = recentEvents(undefined, 20).map(function (e) {
      return { event: e.event, seq: e.seq, at: e.at };
    });
    return {
      version: CORE_VERSION,
      bridge: BRIDGE_VERSION,
      brand: state.config && state.config.brand,
      env: state.env,
      platform: state.platform,
      online: netState().online,
      capabilities: state.capabilities,
      plugins: pluginList(),
      security: { secureStore: secureBackend(), identity: identityMode() },
      queue: { count: q.length, oldestAt: oldestAt },
      events: events,
      at: nowMonotonic(),
    };
  }

  // ---------------------------------------------------------------- 入口路由
  // entry.open 只做校验、能力/在线检查、拼装路径、派发事件；不决定业务内容，也不写业务数据。
  var ENTRY_ID_RE = /^[a-z][a-z0-9.-]{1,31}$/;
  var ENTRY_SOURCES = ['launcher', 'deeplink', 'scan', 'nfc', 'notification', 'device'];

  function entryRoutes() {
    var cfg = state.config || {};
    var list = cfg.entry && cfg.entry.routes;
    return Array.isArray(list) ? list : [];
  }

  function entryAvailability(route) {
    var req = (route && route.requires) || {};
    if (req.capability) {
      var v = state.capabilities[req.capability];
      if (v === undefined || v === '─') return 'capability:' + req.capability;
    }
    if (req.online && !netState().online) return 'offline';
    return null;
  }

  function entriesList() {
    return entryRoutes().map(function (r) {
      var reason = entryAvailability(r);
      return {
        id: r.id,
        label: r.label || null,
        path: r.path,
        params: r.params || {},
        requires: r.requires || {},
        fallback: r.fallback || null,
        available: !reason,
        reason: reason,
      };
    });
  }

  function entryParamsError(route, params) {
    var spec = route.params || {};
    var input = params === undefined ? {} : params;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return 'params 必须是对象';
    var keys = Object.keys(input);
    for (var k = 0; k < keys.length; k++) {
      if (!Object.prototype.hasOwnProperty.call(spec, keys[k])) return '未知参数：' + keys[k];
    }
    for (var name in spec) {
      if (!Object.prototype.hasOwnProperty.call(spec, name)) continue;
      var p = spec[name] || {};
      var v = input[name];
      if (v === undefined || v === null || v === '') {
        if (p.required) return '缺少必填参数：' + name;
        continue;
      }
      if (p.type === 'string') {
        if (typeof v !== 'string') return '参数 ' + name + ' 必须是字符串';
        if (typeof p.maxLength === 'number' && v.length > p.maxLength) return '参数 ' + name + ' 超长';
      } else if (p.type === 'number') {
        if (typeof v !== 'number' || !isFinite(v)) return '参数 ' + name + ' 必须是数字';
      } else if (p.type === 'boolean') {
        if (typeof v !== 'boolean') return '参数 ' + name + ' 必须是布尔值';
      } else {
        return '参数 ' + name + ' 类型不支持';
      }
      if (Array.isArray(p.enum) && p.enum.indexOf(v) < 0) return '参数 ' + name + ' 不在允许值内';
    }
    return null;
  }

  function entryPath(route, params) {
    var spec = route.params || {};
    var qs = [];
    for (var name in spec) {
      if (!Object.prototype.hasOwnProperty.call(spec, name)) continue;
      if (!Object.prototype.hasOwnProperty.call(params, name)) continue;
      var v = params[name];
      if (v === undefined || v === null || v === '') continue;
      qs.push(encodeURIComponent(name) + '=' + encodeURIComponent(String(v)));
    }
    if (!qs.length) return route.path;
    return route.path + (route.path.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');
  }

  function entryFail(code, message, route, payload) {
    var r = err(code, 'entry.open', message);
    r.data = { opened: false, id: payload.id, fallback: (route && route.fallback) || null, reason: message };
    payload.opened = false;
    payload.fallback = r.data.fallback;
    payload.reason = message;
    emit('shell:entry-open', payload);
    return r;
  }

  function openEntry(a) {
    var input = a || {};
    var id = input.id;
    if (typeof id !== 'string' || !ENTRY_ID_RE.test(id)) return err('E_BAD_ARGS', 'entry.open', '入口 id 不合法');
    var source = input.source === undefined ? 'launcher' : input.source;
    if (ENTRY_SOURCES.indexOf(source) < 0) return err('E_BAD_ARGS', 'entry.open', 'source 不合法');
    var route = null;
    var routes = entryRoutes();
    for (var i = 0; i < routes.length; i++) {
      if (routes[i].id === id) { route = routes[i]; break; }
    }
    if (!route) return err('E_BAD_ARGS', 'entry.open', '未知入口：' + id);
    var payload = {
      id: id,
      source: source,
      idem: input.idem || null,
      params: input.params || {},
      opened: false,
      path: null,
      fallback: route.fallback || null,
      reason: null,
    };
    var perr = entryParamsError(route, input.params);
    if (perr) return entryFail('E_BAD_ARGS', perr, route, payload);
    var reason = entryAvailability(route);
    if (reason) return entryFail('E_UNSUPPORTED', reason, route, payload);
    var path = entryPath(route, input.params || {});
    payload.opened = true;
    payload.path = path;
    emit('shell:entry-open', payload);
    return ok({
      opened: true,
      id: id,
      path: path,
      fallback: route.fallback || null,
      reason: null,
      source: source,
      idem: input.idem || null,
    });
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
    'entry.open': openEntry,
    'offline.enqueue': function (a) { return enqueue(a); },
    'offline.flush': function () { return flush(); },
    'offline.list': function () { return ok(queueRead()); },
    'iot.devices': iotDevices,
    'iot.read': iotRead,
    'iot.write': iotWrite,
    'secure.get': secureGet,
    'secure.set': secureSet,
    'secure.remove': secureRemove,
    'identity.current': function () { return identityCurrent(); },
    'identity.refresh': function () { return identityRefresh(); },
    'edge.configure': function (a) { return edgeConfigure(a); },
    'edge.health': function () { return edgeHealth(); },
    'edge.lease': function (a) { return edgeLease(a); },
    'edge.commit': function (a) { return edgeCommit(a); },
    'edge.snapshot': function (a) { return edgeFetch('/edge/snapshot?since=' + Number((a && a.since) || 0)); },
    'desktop.paths': function () {
      if (!window.ShellDesktop || typeof window.ShellDesktop.paths !== 'function') return err('E_UNSUPPORTED', 'desktop.paths');
      try { return ok(window.ShellDesktop.paths()); } catch (e) { return err('E_NATIVE', 'desktop.paths', e && e.message); }
    },
    'desktop.revealFile': function (a) {
      if (!window.ShellDesktop || typeof window.ShellDesktop.revealFile !== 'function') return err('E_UNSUPPORTED', 'desktop.revealFile');
      try { window.ShellDesktop.revealFile(a && a.path); return ok(); } catch (e) { return err('E_NATIVE', 'desktop.revealFile', e && e.message); }
    },
  };

  function ok(data) { return { ok: true, data: data === undefined ? null : data, at: nowMonotonic() }; }
  function err(code, method, message) { return { ok: false, code: code, method: method, message: message || '', at: nowMonotonic() }; }

  function call(method, args) {
    var blocked = blockedCapability(method);
    if (blocked) return Promise.resolve(err('E_UNSUPPORTED', method, '能力未启用：' + blocked));
    var p = PLUGIN_REGISTRY.methods[method];
    if (p) {
      if (!capAllowed(p.cap || String(method).split('.')[0])) {
        return Promise.resolve(err('E_UNSUPPORTED', method, '能力未启用：' + (p.cap || String(method).split('.')[0])));
      }
      if (!p.plugin.active) return Promise.resolve(err('E_UNSUPPORTED', method));
      try {
        return Promise.resolve(p.fn(args || {})).then(function (r) {
          return (r && typeof r.ok === 'boolean') ? r : ok(r);
        }).catch(function (e) {
          return err('E_NATIVE', method, e && e.message);
        });
      } catch (e) {
        return Promise.resolve(err('E_NATIVE', method, e && e.message));
      }
    }
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
      accent: state.theme.tokens.accent,
      theme: state.theme,
      plugins: pluginList(),
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
    window.addEventListener('online', function () {
      emit('shell:network', netState());
      flush();
      identityMaybeRefresh();
    });
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
    state.theme = applyTheme(config.theme, config.accent);
    state.env = detect();
    P = plugins();
    for (var pi = 0; pi < PLUGIN_REGISTRY.list.length; pi++) {
      var pItem = PLUGIN_REGISTRY.list[pi];
      pItem.active = typeof pItem.def.detect === 'function' ? !!pItem.def.detect(state.env) : true;
    }
    state.platform = state.env === 'capacitor' ? window.Capacitor.getPlatform() : state.env;
    allowCaps = config && config.caps && Array.isArray(config.caps.allow) ? config.caps.allow : null;
    for (var ai = 0; ai < IOT_ADAPTERS.length; ai++) {
      var ad = IOT_ADAPTERS[ai];
      var ownerActive = true;
      if (ad.pluginId) {
        ownerActive = false;
        for (var pj = 0; pj < PLUGIN_REGISTRY.list.length; pj++) {
          if (PLUGIN_REGISTRY.list[pj].id === ad.pluginId) { ownerActive = PLUGIN_REGISTRY.list[pj].active; break; }
        }
      }
      ad.active = ownerActive && (!ad.detect || !!ad.detect(state.env));
    }
    if (SECURE_ADAPTER) {
      var secureOwnerActive = true;
      if (SECURE_ADAPTER.pluginId) {
        secureOwnerActive = false;
        for (var sk = 0; sk < PLUGIN_REGISTRY.list.length; sk++) {
          if (PLUGIN_REGISTRY.list[sk].id === SECURE_ADAPTER.pluginId) { secureOwnerActive = PLUGIN_REGISTRY.list[sk].active; break; }
        }
      }
      SECURE_ADAPTER.active = secureOwnerActive && (!SECURE_ADAPTER.detect || !!SECURE_ADAPTER.detect(state.env));
    }
    var mergedCaps = Object.assign(buildCapabilities(state.env, P), desktopCapabilities(), pluginCapabilities());
    // 原生安全存储后端就绪时提升为 ✓；否则明确为内存降级 ◐
    mergedCaps.secureStore = SECURE_ADAPTER && SECURE_ADAPTER.active ? '✓' : '◐';
    // 设备身份：配置 security.identity(mode=device) 后为 ◐（依赖云端刷新与安全存储）
    mergedCaps.identity = config.security && config.security.identity && config.security.identity.mode === 'device' ? '◐' : '─';
    // 插件声明了 iot.* 但适配器未激活（detect=false）时，子能力必须回落 ─
    for (var tk in mergedCaps) {
      if (tk.indexOf('iot.') !== 0) continue;
      var hit = IOT_ADAPTERS.some(function (a) { return a.active && a.capability === tk; });
      if (!hit) mergedCaps[tk] = '─';
    }
    for (var ck in mergedCaps) {
      if (ck.indexOf('iot.') === 0 && mergedCaps[ck] !== '─') { mergedCaps.iot = '✓'; break; }
    }
    state.capabilities = cutCapabilities(mergedCaps);

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
      accent: state.theme.tokens.accent,
      theme: state.theme,
      ends: config.ends,
      plugins: pluginList(),
      entries: entriesList,
      diagnostics: diagnostics,
      events: {
        recent: recentEvents,
      },
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
    Shell.plugins = pluginList();
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
    if (config.alias) {
      // Electron preload 通过 contextBridge 暴露的品牌对象是只读的：覆盖失败属预期，忽略即可
      try { window[config.alias] = Shell; } catch (e) {}
    }

    if (state.env === 'capacitor') {
      polish();
      statusBar({ color: state.theme.tokens.accent, style: config.statusBarStyle || 'dark' });
      armSplash();
      bindCapacitor();
    }
    // 小程序 web-view 与浏览器：只上报能力，不触碰原生
    bindWeb();
    armH5Sync();

    // IoT 适配器只做被动订阅：事件经 shell:iot-data 上报，离线时进入品牌作用域队列
    IOT_ADAPTERS.forEach(function (ad) {
      if (!ad.active || !ad.subscribe) return;
      try {
        ad.subscribe(function (raw) { iotPublish(ad, raw); });
      } catch (e) {
        emit('shell:iot-error', { transport: ad.transport, code: 'E_NATIVE', message: (e && e.message) || '' });
      }
    });

    // 握手：延迟一拍，保证 H5 侧脚本先挂好监听
    setTimeout(function () {
      Shell.ready = true;
      state.ready = true;
      emit('shell:ready', handshakePayload());
      // 重启恢复：只上报待重放数量，不自动重放（重放由 offline.flush 或联网事件触发）
      var restored = queueRead();
      if (restored.length) {
        emit('shell:queue-restored', { count: restored.length, oldestAt: restored[0].at || null });
      }
      identityMaybeRefresh();
    }, 0);

    console.log('[shell-core] v' + CORE_VERSION + ' ready (' + state.env + ')');
    return Shell;
  }

  window.ShellCore = {
    version: CORE_VERSION,
    create: create,
    detect: detect,
    registerPlugin: registerPlugin,
    registerIotAdapter: registerIotAdapter,
    registerSecureStore: registerSecureStore,
  };

  // 配置由 build.mjs 追加在文件末尾：ShellCore.create(<config>);
})();

ShellCore.create({
  "brand": "xso",
  "name": "XSO 智慧企业",
  "project": "xso-app-shell",
  "file": "xso-shell.js",
  "alias": "xsoOS",
  "prefix": "xso",
  "accent": "#1F6FEB",
  "statusBarStyle": "dark",
  "endKey": "xso.end",
  "ends": {}
});
