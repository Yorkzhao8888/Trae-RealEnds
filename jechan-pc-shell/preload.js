// 由 shell-core 生成 —— 勿手改。源：shell-core/src/preload-template.js
//
// 为什么放在 preload：contextIsolation 开启时页面拿不到 Node 能力，
// preload 是唯一可信的中转层；这里只暴露「最小可用」的桌面能力，
// 不开放文件系统任意读写（写只落到系统临时目录）。
const { contextBridge, shell } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');

const api = {
  isDesktopShell: true,
  platform: process.platform,
  arch: process.arch,
  version: '0.1.0',

  // 外部链接交给系统浏览器，不在应用内开新窗口
  openExternal(url) {
    return shell.openExternal(url);
  },

  // 打开本地文件（用户双击等价）
  openPath(p) {
    return shell.openPath(p);
  },

  // 在文件管理器中定位（下载完成后用）
  revealFile(p) {
    shell.showItemInFolder(p);
    return true;
  },

  paths() {
    const home = os.homedir();
    return {
      home,
      tmp: os.tmpdir(),
      downloads: path.join(home, 'Downloads'),
      appData: process.env.APPDATA || path.join(home, '.config'),
    };
  },

  // 只写临时文件：用于导出日志/凭证等一次性产物，避免任意路径写入
  writeTemp(name, text) {
    const p = path.join(os.tmpdir(), path.basename(String(name)));
    fs.writeFileSync(p, String(text), 'utf8');
    return p;
  },
};

contextBridge.exposeInMainWorld('ShellDesktop', api);

// v0.1 品牌对象保留（H5 侧旧判断 isDesktopShell / version 不变）
contextBridge.exposeInMainWorld('jechanOS', {
  platform: process.platform,
  isDesktopShell: true,
  version: api.version,
});
