/**
 * Capacitor 插件初始化（壳启动时调用一次）
 *
 * 注册的能力：
 *  1. 推送 token 上报给 H5 根（H5 调 window.cajobShell.setPushToken(token)）
 *  2. H5 原生桥：window.cajobShell.{scan,share,vibrate,getLocation,...}
 *  3. 生命周期事件：app 回到前台时通知 H5（刷新未读）
 *
 * 使用方式（壳的 index.html 或 H5 根里）：
 *   import { initCajobShell } from './capacitor-plugins';
 *   initCajobShell();
 */
import { App } from '@capacitor/app';
import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Haptics } from '@capacitor/haptics';
import { Geolocation } from '@capacitor/geolocation';
import { Share } from '@capacitor/share';
import { Browser } from '@capacitor/browser';

export interface CajobNativeBridge {
  platform: 'ios' | 'android';
  isMobileShell: true;

  // 推送
  requestPushPermission(): Promise<boolean>;
  getPushToken(): Promise<string | null>;

  // 原生 UI
  vibrate(duration?: number): Promise<void>;
  share(options: { title: string; text?: string; url?: string }): Promise<void>;

  // 定位
  getLocation(): Promise<{ lat: number; lng: number } | null>;

  // 打开外部链接（壳外系统浏览器）
  openExternal(url: string): Promise<void>;
}

declare global {
  interface Window {
    cajobShell?: CajobNativeBridge;
  }
}

export async function initCajobShell() {
  // 判断平台
  const platform = (window.Capacitor?.getPlatform?.() || 'web') as 'ios' | 'android' | 'web';
  if (platform === 'web') {
    // 非壳环境（浏览器直接访问 H5），不注册桥
    console.log('[cajob-shell] web 环境，跳过原生桥注册');
    return;
  }

  console.log(`[cajob-shell] 初始化原生桥（platform=${platform}）`);

  // 1. 推送权限请求（iOS 必须）
  try {
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive === 'granted') {
      await PushNotifications.register();
      PushNotifications.addListener('registration', (token) => {
        console.log('[cajob-shell] push token:', token.value);
        // 上报给 H5 根（H5 监听自定义事件或直接调用全局函数）
        window.dispatchEvent(new CustomEvent('cajob:push-token', { detail: token.value }));
      });
      PushNotifications.addListener('pushNotificationReceived', (notif) => {
        console.log('[cajob-shell] 收到推送:', notif);
      });
      PushNotifications.addListener('pushNotificationActionPerformed', (notif) => {
        console.log('[cajob-shell] 用户点击推送:', notif);
      });
    }
  } catch (e) {
    console.warn('[cajob-shell] 推送初始化失败（可忽略）:', e);
  }

  // 2. 本地通知（壳内提醒）
  LocalNotifications.addListener('localNotificationActionPerformed', (notif) => {
    console.log('[cajob-shell] 用户点击本地通知:', notif);
  });

  // 3. App 回到前台 → 通知 H5 刷新未读
  App.addListener('appStateChange', (state) => {
    if (state.isActive) {
      window.dispatchEvent(new CustomEvent('cajob:app-resume'));
    }
  });

  App.addListener('appUrlOpen', (data) => {
    // 处理 deeplink：cajob://chat/conv_xxx 之类
    console.log('[cajob-shell] deeplink:', data.url);
    window.dispatchEvent(new CustomEvent('cajob:deeplink', { detail: data.url }));
  });

  // 4. 注册原生桥到 window（H5 根可直接调用）
  const bridge: CajobNativeBridge = {
    platform: platform as 'ios' | 'android',
    isMobileShell: true,

    async requestPushPermission() {
      const r = await PushNotifications.requestPermissions();
      return r.receive === 'granted';
    },
    async getPushToken() {
      // PushNotifications 不直接暴露 token，需要在 registration 事件里缓存
      return (window as any).__cajobPushToken__ || null;
    },

    async vibrate(duration = 10) {
      try { await Haptics.vibrate({ type: duration > 10 ? 'Medium' : 'Light' }); } catch {}
    },
    async share(options) {
      try {
        await Share.share({ title: options.title, text: options.text, url: options.url });
      } catch (e) {
        console.warn('[cajob-shell] share 取消或失败:', e);
      }
    },

    async getLocation() {
      try {
        const pos = await Geolocation.getCurrentPosition();
        return { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch {
        return null;
      }
    },

    async openExternal(url) {
      await Browser.open({ url });
    },
  };

  window.cajobShell = bridge;
  console.log('[cajob-shell] ✅ 原生桥就绪');
}
