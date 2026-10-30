// 四端选择页：客户端 / 个人端 / 企业端 / 生态端
const ENDS = [
  { id: 'hp', name: '个人端', sub: '捷才工友 · 挂出技能，活来找你', mark: '工', url: 'https://hp.jechan.cewaysoft.com/' },
  { id: 'cp', name: '客户端', sub: '捷才需求方 · 说清需求，人才上门', mark: '需', url: 'https://cp.jechan.cewaysoft.com/' },
  { id: 'ep', name: '企业端', sub: '捷才企业 · 批量招人，合规留痕', mark: '企', url: 'https://ep.jechan.cewaysoft.com/' },
  { id: 'sp', name: '生态端', sub: '捷才生态 · 把渠道接进人才大市场', mark: '态', url: 'https://sp.jechan.cewaysoft.com/' },
];
const KEY = 'jechan.end';

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
    return { title: '捷才工友 · 挂出技能，活来找你', path: '/pages/index/index' };
  },

  onShareTimeline() {
    return { title: '捷才工友' };
  },
});
