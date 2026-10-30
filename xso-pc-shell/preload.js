// 预加载脚本：壳与页面之间的安全桥（当前保持最小，后续桌面能力在此扩展）
const { contextBridge } = require('electron');

// 与移动端壳同名（window.xsoOS），H5 侧用 isDesktopShell / isMobileShell 区分环境
contextBridge.exposeInMainWorld('xsoOS', {
  platform: process.platform,
  isDesktopShell: true,
  version: require('./package.json').version,
});
