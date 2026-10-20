// 预加载脚本：壳与页面之间的安全桥（当前保持最小，后续桌面能力在此扩展）
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('cajobShell', {
  platform: process.platform,
  isDesktopShell: true,
});
