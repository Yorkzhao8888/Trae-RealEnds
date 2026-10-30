// 加载失败页：给出原因、重试与复制入口
const HOME = 'https://hp.jechan.cewaysoft.com';

Page({
  data: {
    reason: '页面加载失败',
  },

  onLoad(query) {
    if (query && query.reason) {
      this.setData({ reason: decodeURIComponent(query.reason) });
    }
  },

  retry() {
    wx.redirectTo({ url: '/pages/index/index' });
  },

  copyLink() {
    wx.setClipboardData({ data: HOME });
  },
});
