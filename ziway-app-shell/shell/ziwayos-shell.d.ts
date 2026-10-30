/**
 * 知味工场 ZiwayOS 原生桥类型契约。
 *
 * 运行时只有一份：shell/ziwayos-shell.js（无构建、可直接被远程页面加载）。
 * 本文件仅声明 window.ziwayOS 的形状，供 H5 侧获得类型提示，不产生运行时代码。
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

  /** 四端目录：hp 个人 / cp 客户 / ep 企业 / sp 生态 */
  ends: Record<'hp' | 'cp' | 'ep' | 'sp', { url: string; name: string }>;

  /** 当前记住的端（未选择时为 null） */
  currentEnd(): 'hp' | 'cp' | 'ep' | 'sp' | null;

  /** 切到指定端并跳转，返回是否切换成功 */
  switchEnd(id: 'hp' | 'cp' | 'ep' | 'sp'): boolean;
}

/** 桥派发的自定义事件 */
export interface ZiwayShellEvents {
  'ziwayos:shell-ready': { version: string; platform: ZiwayPlatform };
  'ziwayos:push-token': string | null;
  'ziwayos:push-received': unknown;
  'ziwayos:push-action': unknown;
  'ziwayos:app-resume': undefined;
  'ziwayos:deeplink': string | undefined;
}

declare global {
  interface Window {
    ziwayOS?: ZiwayNativeBridge;
    __ziwayosPushToken__?: string | null;
  }
}

export {};
