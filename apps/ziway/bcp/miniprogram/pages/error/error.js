Page({
  data: {
    brand: '知味客户端',
  },
  retry() {
    wx.navigateBack({ delta: 1 });
  },
});
