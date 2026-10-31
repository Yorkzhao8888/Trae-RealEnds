const app = getApp();

Page({
  data: {
    url: '',
    title: '',
  },
  onLoad() {
    this.setData({
      url: app.globalData.primaryUrl,
      title: app.globalData.displayName,
    });
  },
  onError() {
    wx.navigateTo({ url: '/pages/error/error' });
  },
});
