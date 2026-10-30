// 承载页：按身份加载对应 H5 工作台；返回即回选择页
const ENDS = {
  hp: { url: 'https://ziway-hp.ziway.cewaycloud.com/shop', title: '知味工场 · 个人端' },
  cp: { url: 'https://ziway-cp.ziway.cewaycloud.com/mall', title: '知味工场 · 客户端' },
  ep: { url: 'https://ziway-ep.ziway.cewaycloud.com/', title: '知味工场 · 企业端' },
  sp: { url: 'https://ziway-sp.ziway.cewaycloud.com/', title: '知味工场 · 生态端' },
};
// 离开超过 5 分钟后回来，强制重载一次，避免长期停留在旧版本 H5
const STALE_MS = 5 * 60 * 1000;

Page({
  data: {
    src: '',
  },

  onLoad(options) {
    const end = ENDS[options.end] ? options.end : 'hp';
    this.end = end;
    this.awayAt = 0;
    wx.setNavigationBarTitle({ title: ENDS[end].title });
    wx.getNetworkType({
      success: (res) => {
        if (res.networkType === 'none') {
          this.toError('当前无网络连接');
          return;
        }
        this.setData({ src: ENDS[end].url });
      },
      fail: () => this.setData({ src: ENDS[end].url }),
    });
  },

  onHide() {
    this.awayAt = Date.now();
  },

  onShow() {
    if (!this.data.src || !this.awayAt) return;
    if (Date.now() - this.awayAt < STALE_MS) return;
    this.awayAt = 0;
    // web-view 没有 reload API，换 src 才能重新拉取 H5
    this.setData({ src: ENDS[this.end].url + '?__t=' + Date.now() });
  },

  onWebError(e) {
    const msg = (e && e.detail && e.detail.errMsg) || '页面加载失败';
    this.toError(msg);
  },

  toError(reason) {
    wx.redirectTo({
      url: '/pages/error/error?reason=' + encodeURIComponent(reason),
    });
  },
});
