Page({
  data: {
    brand: '{{displayName}}',
  },
  retry() {
    wx.navigateBack({ delta: 1 });
  },
});
