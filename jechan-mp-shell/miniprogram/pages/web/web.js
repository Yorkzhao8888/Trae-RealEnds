// 承载页：按身份加载对应 H5 工作台；返回即回选择页
const ENDS = {
  hp: { url: 'https://hp.jechan.cewaysoft.com/', title: '捷才工友' },
  cp: { url: 'https://cp.jechan.cewaysoft.com/', title: '捷才需求方' },
  ep: { url: 'https://ep.jechan.cewaysoft.com/', title: '捷才企业' },
  sp: { url: 'https://sp.jechan.cewaysoft.com/', title: '捷才生态' },
};
// 离开超过 5 分钟后回来，强制重载一次，避免长期停留在旧版本 H5
const STALE_MS = 5 * 60 * 1000;
// 让 H5 侧的 shell-core 识别 web-view 环境（只上报能力，不触碰小程序 API）
const SHELL_Q = 'shell=mp&brand=jechan&v=0.2.0';
function withShell(url) {
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + SHELL_Q;
}

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
        this.setData({ src: withShell(ENDS[end].url) });
      },
      fail: () => this.setData({ src: withShell(ENDS[end].url) }),
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
    this.setData({ src: withShell(ENDS[this.end].url) + '&__t=' + Date.now() });
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
