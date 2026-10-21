// 首页：品牌启动层 → 全屏 web-view 承载 H5 根
const HOME = 'https://h5.cewaycloud.com/';
const SPLASH_MS = 600;

Page({
  data: {
    ready: false,
    src: '',
  },

  onLoad() {
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
