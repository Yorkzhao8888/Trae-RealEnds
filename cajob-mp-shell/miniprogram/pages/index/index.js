// 首页：品牌启动层 → 全屏 web-view 承载 H5 根
const HOME = 'https://cajob.cewaysoft.com/';
const SPLASH_MS = 600;
// 离开超过 5 分钟后回来，强制重载一次 web-view，避免长期停留在旧版本 H5
const STALE_MS = 5 * 60 * 1000;

Page({
  data: {
    ready: false,
    src: '',
  },

  onLoad() {
    this.awayAt = 0;
    // 先亮品牌层，避免 web-view 首帧白屏；同时确认网络可用
    wx.getNetworkType({
      success: (res) => {
        if (res.networkType === 'none') {
          this.toError('当前无网络连接');
          return;
        }
        this.mount();
      },
      fail: () => this.mount(),
    });
  },

  onHide() {
    this.awayAt = Date.now();
  },

  onShow() {
    if (!this.data.ready || !this.awayAt) return;
    if (Date.now() - this.awayAt < STALE_MS) return;
    this.awayAt = 0;
    // web-view 没有 reload API，换 src 才能重新拉取 H5
    this.setData({ src: HOME + '?__t=' + Date.now() });
  },

  mount() {
    setTimeout(() => {
      this.setData({ src: HOME, ready: true });
    }, SPLASH_MS);
  },

  // web-view 加载失败：小程序内无法在 web-view 上叠加提示，改为跳独立错误页
  onWebError(e) {
    const msg = (e && e.detail && e.detail.errMsg) || '页面加载失败';
    this.toError(msg);
  },

  toError(reason) {
    wx.redirectTo({
      url: '/pages/error/error?reason=' + encodeURIComponent(reason),
    });
  },

  onShareAppMessage() {
    return {
      title: 'Cajob · 捷才智通',
      path: '/pages/index/index',
    };
  },

  onShareTimeline() {
    return { title: 'Cajob · 捷才智通' };
  },
});
