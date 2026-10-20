// Cajob 真实端 H5 根 PC 壳 —— Electron 主进程
// v0.2.0：Phase 1/4 补齐（https 收紧、离线兜底、菜单收敛）+ Phase 3 自动更新接入
const { app, BrowserWindow, shell, Menu, session, nativeImage, dialog } = require('electron');
const path = require('path');

const HOME_URL = 'https://h5.cewaycloud.com/';
// 品牌图标（窗口图标：Windows/Linux 开发模式；打包后由安装器内嵌图标接管）
const APP_ICON = path.join(__dirname, 'build', 'icon.png');
// 允许在壳内导航的域（登录/授权链路会跳到 A门）；P4-1 收紧：仅 https
const ALLOWED_HOSTS = new Set([
  'h5.cewaycloud.com',
  'oas.cewaycloud.com',
]);

let mainWindow = null;

// 单实例锁：重复启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function isAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    // P4-1 仅允许 https（http 明文不放行）
    if (u.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.has(u.hostname) || u.hostname.endsWith('.cewaycloud.com');
  } catch {
    return false;
  }
}

// P4-2 离线兜底页（内联 data: URL，零新文件）
function offlinePageHtml(failedUrl, code, desc) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Cajob · 网络异常</title>
<style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6f8;
font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2430}
.card{text-align:center;max-width:420px;padding:40px}
h1{font-size:20px;margin:0 0 10px}p{font-size:13px;color:#5b6472;line-height:1.7;margin:6px 0}
button{margin-top:22px;padding:9px 26px;border:0;border-radius:8px;background:#2b6cb0;color:#fff;
font-size:14px;cursor:pointer}button:hover{background:#22598f}
code{font-size:11px;color:#9aa1ad}
</style></head><body><div class="card">
<h1>网络连接异常</h1>
<p>无法访问 Cajob 服务，请检查网络后重试。</p>
<code>${String(code)} ${String(desc || '')}</code><br>
<button onclick="location.replace('${HOME_URL}')">重新加载</button>
</div></body></html>`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'Cajob',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 会话持久化（默认即 persist:default，显式声明便于后续分区）
      partition: 'persist:cajob',
    },
  });

  mainWindow.loadURL(HOME_URL);

  // 站内导航：cewaycloud.com 域内放行（OAuth 回跳链），其余交给系统浏览器
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // 新窗口请求（target=_blank / window.open）：域内在当前窗口打开，域外系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) {
      mainWindow.loadURL(url);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // P4-2 主框架加载失败 → 内联离线兜底页（含重新加载入口）
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // ERR_ABORTED(-3)：导航被取消（如重定向接续），不当作失败
    if (!isMainFrame || errorCode === -3) return;
    mainWindow
      .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(offlinePageHtml(validatedURL, errorCode, errorDescription)))
      .catch(() => {});
  });

  // 下载改为 Electron 默认行为（弹保存对话框，用户自选落盘；P4-5 收敛：仅记录）
  session.fromPartition('persist:cajob').on('will-download', (_event, item) => {
    console.log('[cajob] download:', item.getFilename());
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Phase 3 自动更新：generic 源（/download/latest/），仅打包态启用；签名未就绪期间失败静默不阻塞
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return; // 依赖缺失（如手工运行 dist 产物）时直接跳过
  }
  autoUpdater.autoDownload = true; // 检出即后台下载，下载完成再询问重启
  autoUpdater.logger = console;

  autoUpdater.on('update-downloaded', async (info) => {
    try {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Cajob 更新',
        message: `新版本 ${info.version} 已就绪`,
        detail: '是否立即重启完成更新？',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) autoUpdater.quitAndInstall();
    } catch { /* 窗口不存在等情况：忽略，下次启动再装 */ }
  });

  // 签名未就绪 / 网络异常 / yml 缺失：静默失败，不影响主流程
  autoUpdater.on('error', (err) => {
    console.log('[cajob] updater error (suppressed):', err && err.message);
  });

  // 启动 10s 后检查一次；此后每 30 分钟轮询
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10_000);
  setInterval(check, 30 * 60_000);
}

// macOS 基础菜单（复制粘贴等编辑功能在壳内可用）；P4-4 发行版按打包状态收敛调试项
function buildMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const dev = !app.isPackaged;
  const viewSubmenu = dev
    ? [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ]
    : [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ];
  const appSubmenu = [
    { role: 'about', label: '关于 Cajob' },
    { type: 'separator' },
    {
      label: '检查更新…',
      click: () => {
        if (app.isPackaged) {
          try {
            require('electron-updater').autoUpdater.checkForUpdates().catch(() => {});
          } catch { /* ignore */ }
        }
      },
    },
    { type: 'separator' },
    { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit', label: '退出 Cajob' },
  ];
  const template = [
    { label: app.name, submenu: appSubmenu },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    { label: '视图', submenu: viewSubmenu },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // macOS 开发模式下 Dock 图标（打包后由 .app 内嵌 icns 接管）
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(APP_ICON);
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }
  buildMenu();
  createWindow();
  setupAutoUpdate();

  app.on('activate', () => {
    // macOS：点击 Dock 图标时若无窗口则重建
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
