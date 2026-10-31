// {{displayName}} · UendOS PC 桥（由 uendos init 生成）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ShellDesktop', {
  isDesktopShell: true,
  platform: 'electron',
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
});
