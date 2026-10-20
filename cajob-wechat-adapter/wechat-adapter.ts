/**
 * 微信 JSSDK 适配器（H5 根里用）
 *
 * 职责：
 *  1. 检测当前是否在微信内置浏览器
 *  2. 后端换取 jsapi_ticket → H5 前端签名 → wx.config
 *  3. 暴露常用能力：分享、扫一扫、位置、支付、订阅消息
 *
 * 使用：
 *   import { initWeChat, wechatShare, wechatScanQR } from './wechat-adapter';
 *   await initWeChat();  // 页面加载时调一次
 */

declare global {
  interface Window {
    wx?: any;       // 微信 JSSDK
    WeixinJSBridge?: any;  // 旧版桥
  }
}

export interface WxShareOptions {
  title: string;
  desc: string;
  link: string;
  imgUrl: string;
}

/** 判断是否在微信内置浏览器 */
export function isInWeChat(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  return /micromessenger/i.test(ua);
}

/**
 * 初始化微信 JSSDK
 * 流程：H5 请求后端签名接口 → 后端用 jsapi_ticket 签名当前 URL → H5 wx.config → ready 事件
 *
 * 后端需要暴露一个接口，例如：
 *   GET /api/backend/wechat/jsapi-config?url=encodeURIComponent(window.location.href.split('#')[0])
 *   返回: { appId, timestamp, nonceStr, signature }
 */
export async function initWeChat(): Promise<boolean> {
  if (!isInWeChat()) {
    console.log('[wechat-adapter] 非微信环境，跳过');
    return false;
  }
  if (!window.wx) {
    // 动态加载 JSSDK（H5 根 index.html 里也可以直接 <script src="https://res.wx.qq.com/open/js/jweixin-1.6.0.js">）
    await loadScript('https://res.wx.qq.com/open/js/jweixin-1.6.0.js');
  }

  try {
    // 后端签名（URL 必须是当前页面带 # 之前的部分）
    const url = window.location.href.split('#')[0];
    const resp = await fetch(`/api/backend/wechat/jsapi-config?url=${encodeURIComponent(url)}`, {
      credentials: 'include',
    });
    if (!resp.ok) throw new Error(`签名接口 ${resp.status}`);
    const cfg = await resp.json();

    await new Promise<void>((resolve, reject) => {
      window.wx.config({
        debug: false,       // 上线改 false
        appId: cfg.appId,
        timestamp: cfg.timestamp,
        nonceStr: cfg.nonceStr,
        signature: cfg.signature,
        // 按需声明权限（没声明的调不了）
        jsApiList: [
          'updateAppMessageShareData',   // 分享给好友
          'updateTimelineShareData',     // 分享到朋友圈
          'scanQRCode',                  // 扫一扫
          'getLocation',                 // 获取位置
          'chooseImage',                 // 选图/拍照
          'previewImage',                // 图片预览
          'openLocation',                // 打开地图
          'chooseWXPay',                 // 微信支付
          'subscribeMessage',            // 订阅消息
          'hideMenuItems',               // 隐藏右上角菜单
          'showMenuItems',
          'closeWindow',                 // 关闭网页（跳原生）
        ],
        success: () => resolve(),
        fail: (err: any) => reject(new Error(JSON.stringify(err))),
      });
    });

    console.log('[wechat-adapter] ✅ wx.config ready');
    // 隐藏右上角"在浏览器中打开"菜单可选（看需求）
    // window.wx.hideMenuItems({ menuList: ['menuItems:openApplication'] });
    return true;
  } catch (e) {
    console.warn('[wechat-adapter] ❌ 初始化失败:', e);
    return false;
  }
}

/** 分享给好友 */
export function wechatShareToFriend(opts: WxShareOptions) {
  if (!window.wx) return;
  window.wx.updateAppMessageShareData({
    title: opts.title, desc: opts.desc, link: opts.link, imgUrl: opts.imgUrl,
    success: () => {}, fail: () => {},
  });
}
/** 分享到朋友圈 */
export function wechatShareToTimeline(opts: WxShareOptions) {
  if (!window.wx) return;
  window.wx.updateTimelineShareData({
    title: opts.title, link: opts.link, imgUrl: opts.imgUrl,
    success: () => {}, fail: () => {},
  });
}
/** 扫一扫 */
export function wechatScanQR(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!window.wx) return reject(new Error('非微信环境'));
    window.wx.scanQRCode({
      needResult: 1, scanType: ['qrCode', 'barCode'],
      success: (res: any) => resolve(res.resultStr),
      fail: reject,
    });
  });
}
/** 获取位置 */
export function wechatGetLocation(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!window.wx) return reject(new Error('非微信环境'));
    window.wx.getLocation({
      type: 'gcj02',
      success: (res: any) => resolve({ lat: res.latitude, lng: res.longitude, accuracy: res.accuracy }),
      fail: reject,
    });
  });
}
/** 微信支付（JSAPI） */
export function wechatPay(params: {
  timeStamp: string; nonceStr: string; package: string; signType: 'RSA' | 'MD5'; paySign: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!window.wx) return reject(new Error('非微信环境'));
    window.wx.chooseWXPay({
      ...params,
      success: () => resolve(),
      fail: reject,
    });
  });
}
/** 订阅消息（一次订阅多个模板） */
export function wechatSubscribe(tmplIds: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (!window.wx) return reject(new Error('非微信环境'));
    window.wx.subscribeMessage({
      tmplIds,
      success: (res: any) => resolve(Object.keys(res).filter(k => res[k] === 'accept')),
      fail: reject,
    });
  });
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve(); s.onerror = reject;
    document.head.appendChild(s);
  });
}
