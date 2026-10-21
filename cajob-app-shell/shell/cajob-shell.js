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

  var VERSION = '0.2.2';

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

  /**
   * 前台提示音：与通知渠道里的 res/raw/cajob_notify.wav 同音色（E6→B6 上行五度）。
   * 现场合成而非加载音频文件，避免首屏多一个请求。
   */
  var audioCtx = null;
  function chime() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t0 = audioCtx.currentTime + 0.01;
      var notes = [[1318.51, 0], [1975.53, 0.105]];
      for (var i = 0; i < notes.length; i++) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        var at = t0 + notes[i][1];
        osc.type = 'sine';
        osc.frequency.setValueAtTime(notes[i][0], at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.16, at + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.38);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(at);
        osc.stop(at + 0.4);
      }
    } catch (e) {
      /* 无音频权限或被系统静音：静默失败 */
    }
  }

  function buzz(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {
      /* 用户关闭了振动 */
    }
  }

  /**
   * 原生端视觉打磨：只在壳内注入，浏览器/微信零影响。
   * 目的：去掉 WebView 默认的灰色点击方块、橡皮筋与滚动条，把「网页感」压下去。
   */
  function polish() {
    if (document.getElementById('cajob-shell-css')) return;
    var css = [
      'html{-webkit-tap-highlight-color:transparent;overscroll-behavior:none}',
      'body{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;overscroll-behavior-y:none}',
      '::-webkit-scrollbar{width:0;height:0}',
      'a,button{-webkit-tap-highlight-color:transparent;transition:transform .12s cubic-bezier(.2,.8,.2,1),opacity .12s ease}',
      'a:active,button:active{transform:scale(.975);opacity:.85}',
    ].join('');
    var style = document.createElement('style');
    style.id = 'cajob-shell-css';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    document.documentElement.classList.add('cajob-native');
  }

  function init() {
    var p = platform();
    if (p !== 'ios' && p !== 'android') return;
    if (window.cajobShell) return;

    var P = plugins();

    polish();

    // ---- 系统栏：与 H5 背景同色，浅色图标；覆盖 WebView 不透内容 ----
    if (P.StatusBar) {
      try {
        P.StatusBar.setStyle({ style: 'DARK' });
        if (typeof P.StatusBar.setBackgroundColor === 'function') {
          P.StatusBar.setBackgroundColor({ color: '#0F1115' });
        }
      } catch (e) {
        /* iOS 不支持背景色，忽略 */
      }
    }

    // ---- 返回键：能回退就回退，到底则退到后台而不是杀进程 ----
    if (p === 'android' && P.App) {
      P.App.addListener('backButton', function (ev) {
        if (ev && ev.canGoBack) {
          window.history.back();
          return;
        }
        if (typeof P.App.minimizeApp === 'function') {
          P.App.minimizeApp();
        }
      });
    }

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
        // 前台不走系统通知，用轻提示音 + 双短振代替，避免「叮一声很响」
        chime();
        buzz([0, 14, 70, 14]);
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

      // 不传参：轻叩双短振（14ms + 70ms 间隔 + 14ms），传参则按指定时长单次
      vibrate: async function (duration) {
        var single = typeof duration === 'number' && duration > 0;
        if (navigator.vibrate) {
          navigator.vibrate(single ? [0, duration] : [0, 14, 70, 14]);
          return;
        }
        if (!P.Haptics) return;
        try {
          await P.Haptics.vibrate({ duration: single ? duration : 14 });
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

    // 收启动屏：双 rAF 确保首帧已绘制，避免「收早了露白」
    if (P.SplashScreen) {
      var splashHidden = false;
      var hideSplash = function () {
        if (splashHidden) return;
        splashHidden = true;
        try {
          P.SplashScreen.hide({ fadeOutDuration: 220 });
        } catch (e) {
          /* 启动屏已自动隐藏 */
        }
      };
      window.cajobShell.hideSplash = hideSplash;
      requestAnimationFrame(function () {
        requestAnimationFrame(hideSplash);
      });
      // 兜底：桥接成功但首帧异常时，不让启动屏长期驻留
      setTimeout(hideSplash, 1600);
    }

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
