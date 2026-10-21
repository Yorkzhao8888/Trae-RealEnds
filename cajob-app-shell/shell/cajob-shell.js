/**
 * Cajob 原生桥运行时（无构建版本，直接以 <script> 引入）
 *
 * 为什么是纯 JS 而不是打包产物：
 *   壳以 server.url 直连 H5 根，本地 webDir 的入口页不会执行，
 *   因此桥必须是一份「可被远程页面直接加载」的自包含脚本，
 *   不能依赖打包器、不能 import。
 *
 * 引入方式（H5 根，任选其一）：
 *   A. 直接调用 Capacitor 原生插件（window.Capacitor.Plugins.*），不引本文件；
 *   B. <script src="/cajob-shell.js" defer></script>（与 H5 同域部署时）；
 *   C. 由壳注入（需原生侧配合），见 README「桥接入」。
 *
 * 契约：window.cajobShell（幂等，重复引入不会覆盖）
 */
(function () {
  'use strict';

  var VERSION = '0.2.0';

  // 幂等：已注册则直接返回，避免重复绑定监听导致事件翻倍
  if (window.cajobShell) return;

  function cap() {
    return window.Capacitor;
  }

  function plugins() {
    var c = cap();
    return (c && c.Plugins) || {};
  }

  function platform() {
    var c = cap();
    if (c && typeof c.getPlatform === 'function') return c.getPlatform();
    return 'web';
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (e) {
      /* 老 WebView 不支持 CustomEvent 构造器：忽略 */
    }
  }

  function init() {
    var p = platform();
    if (p !== 'ios' && p !== 'android') return;
    if (window.cajobShell) return;

    var P = plugins();

    // ---- 推送：token 既缓存也广播，保证「取」和「推」两条路径都可用 ----
    function bindPush() {
      if (!P.PushNotifications) return;
      P.PushNotifications.addListener('registration', function (token) {
        window.__cajobPushToken__ = token && token.value ? token.value : null;
        emit('cajob:push-token', window.__cajobPushToken__);
      });
      P.PushNotifications.addListener('registrationError', function (err) {
        console.warn('[cajob-shell] push registrationError:', err);
      });
      P.PushNotifications.addListener('pushNotificationReceived', function (n) {
        emit('cajob:push-received', n);
      });
      P.PushNotifications.addListener('pushNotificationActionPerformed', function (n) {
        emit('cajob:push-action', n);
      });
    }

    bindPush();

    // ---- 生命周期 ----
    if (P.App) {
      P.App.addListener('appStateChange', function (state) {
        if (state && state.isActive) emit('cajob:app-resume');
      });
      P.App.addListener('appUrlOpen', function (data) {
        emit('cajob:deeplink', data && data.url);
      });
    }

    var bridge = {
      platform: p,
      isMobileShell: true,
      shellVersion: VERSION,

      requestPushPermission: async function () {
        if (!P.PushNotifications) return false;
        var r = await P.PushNotifications.requestPermissions();
        if (r && r.receive === 'granted') {
          await P.PushNotifications.register();
          return true;
        }
        return false;
      },

      // 只返回已缓存的 token；未注册成功前为 null（不伪造）
      getPushToken: async function () {
        return window.__cajobPushToken__ || null;
      },

      vibrate: async function (duration) {
        if (!P.Haptics) return;
        var ms = typeof duration === 'number' && duration > 0 ? duration : 12;
        try {
          await P.Haptics.vibrate({ duration: ms });
        } catch (e) {
          /* iOS 忽略 duration，失败不影响调用方 */
        }
      },

      share: async function (options) {
        if (!P.Share) return;
        var o = options || {};
        try {
          await P.Share.share({ title: o.title, text: o.text, url: o.url });
        } catch (e) {
          /* 用户取消：不视为错误 */
        }
      },

      getLocation: async function () {
        if (!P.Geolocation) return null;
        try {
          var pos = await P.Geolocation.getCurrentPosition({ enableHighAccuracy: false });
          return { lat: pos.coords.latitude, lng: pos.coords.longitude };
        } catch (e) {
          return null;
        }
      },

      openExternal: async function (url) {
        if (!P.Browser) {
          window.open(url, '_system');
          return;
        }
        await P.Browser.open({ url: url });
      },
    };

    window.cajobShell = bridge;
    console.log('[cajob-shell] 原生桥就绪 v' + VERSION + ' (' + p + ')');
    emit('cajob:shell-ready', { version: VERSION, platform: p });
  }

  // Capacitor 的原生注入可能晚于本脚本：deviceready 后再兜一次
  if (cap()) {
    init();
  } else {
    document.addEventListener('deviceready', init, { once: true });
    // 兜底：部分环境不派发 deviceready，轮询至多 3 秒
    var tries = 0;
    var timer = setInterval(function () {
      if (cap() || ++tries > 30) {
        clearInterval(timer);
        if (cap()) init();
      }
    }, 100);
  }
})();
