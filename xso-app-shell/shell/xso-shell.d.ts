/**
 * XSO 智慧企业 原生桥类型契约。
 *
 * 运行时只有一份：shell/xso-shell.js（无构建、可直接被远程页面加载）。
 * 本文件仅声明 window.xsoOS 的形状，供 H5 侧获得类型提示，不产生运行时代码。
 */

export type ZiwayPlatform = 'ios' | 'android';

export interface ZiwayNativeBridge {
  readonly platform: ZiwayPlatform;
  readonly isMobileShell: true;
  readonly shellVersion: string;

  /** 请求推送权限并注册；granted 返回 true */
  requestPushPermission(): Promise<boolean>;

  /** 返回已缓存的 token；尚未注册成功时为 null */
  getPushToken(): Promise<string | null>;

  /** 震动，duration 毫秒（iOS 忽略时长） */
  vibrate(duration?: number): Promise<void>;

  share(options: { title: string; text?: string; url?: string }): Promise<void>;

  getLocation(): Promise<{ lat: number; lng: number } | null>;

  /** 在系统浏览器打开外部链接 */
  openExternal(url: string): Promise<void>;

  /** 立即收起启动屏（H5 首屏渲染完成后可主动调用，避免等待自动收起） */
  hideSplash(): void;
}

/** 桥派发的自定义事件 */
export interface ZiwayShellEvents {
  'xso:shell-ready': { version: string; platform: ZiwayPlatform };
  'xso:push-token': string | null;
  'xso:push-received': unknown;
  'xso:push-action': unknown;
  'xso:app-resume': undefined;
  'xso:deeplink': string | undefined;
}

declare global {
  interface Window {
    xsoOS?: ZiwayNativeBridge;
    __xsoPushToken__?: string | null;
  }
}

export {};
