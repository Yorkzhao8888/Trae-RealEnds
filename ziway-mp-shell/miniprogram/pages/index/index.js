// 四端选择页：客户端 / 个人端 / 企业端 / 生态端
const ENDS = [
  { id: 'hp', name: '个人端', sub: '铺主工作台 · 选品、上架、接单与结算', mark: '铺', url: 'https://ziway-hp.ziway.cewaycloud.com/shop' },
  { id: 'cp', name: '客户端', sub: '通用大市场 · 买东西、找供给、加盟采购', mark: '客', url: 'https://ziway-cp.ziway.cewaycloud.com/mall' },
  { id: 'ep', name: '企业端', sub: '企业版 · 多店协同、供应链与组织管理', mark: '企', url: 'https://ziway-ep.ziway.cewaycloud.com/' },
  { id: 'sp', name: '生态端', sub: '生态版 · 渠道接入、服务商与生态协作', mark: '态', url: 'https://ziway-sp.ziway.cewaycloud.com/' },
];
const KEY = 'ziway.end';

Page({
  data: {
    ends: ENDS,
  },

  onLoad() {
    let last = null;
    try { last = wx.getStorageSync(KEY); } catch (e) { /* 存储不可用时仍展示选择页 */ }
    if (last && ENDS.some((e) => e.id === last)) this.enter(last);
  },

  onTap(e) {
    this.enter(e.currentTarget.dataset.id);
  },

  enter(id) {
    const end = ENDS.find((e) => e.id === id);
    if (!end) return;
    try { wx.setStorageSync(KEY, id); } catch (e) { /* 忽略 */ }
    wx.navigateTo({ url: '/pages/web/web?end=' + id });
  },

  onShareAppMessage() {
    return { title: '知味工场 · ZiwayOS', path: '/pages/index/index' };
  },

  onShareTimeline() {
    return { title: '知味工场' };
  },
});
