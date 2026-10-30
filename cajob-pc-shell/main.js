// Cajob 真实端 H5 根 PC 壳 —— Electron 主进程
// v0.2.2：三端体验统一（窗口记忆、主题跟随、下载/更新进度、崩溃自恢复、跨平台快捷键）
const { app, BrowserWindow, shell, Menu, session, nativeImage, dialog, screen, nativeTheme, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');

const HOME_URL = 'https://cajob.cewaysoft.com/';
// 品牌图标（窗口图标：Windows/Linux 开发模式；打包后由安装器内嵌图标接管）
const APP_ICON = path.join(__dirname, 'build', 'icon.png');
// 允许在壳内导航的域（登录/授权链路会跳到 A门）；P4-1 收紧：仅 https
const ALLOWED_HOSTS = new Set([
  'cajob.cewaysoft.com',
  'oas.cewaysoft.com',
]);

const THEME_BG = { dark: '#0F1115', light: '#FFFFFF' };
const isDark = () => nativeTheme.shouldUseDarkColors;
const bgColor = () => (isDark() ? THEME_BG.dark : THEME_BG.light);

let mainWindow = null;
let rendererCrashes = 0;

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

// ── 窗口状态记忆（位置/尺寸/最大化/缩放）────────────────────────────
const statePath = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(statePath(), JSON.stringify({
      bounds,
      maximized: win.isMaximized(),
      zoom: win.webContents.getZoomFactor(),
    }));
  } catch { /* 状态写入失败不影响使用 */ }
}

// 副屏拔出后旧坐标可能落在可见区域外，这里回退到默认尺寸
function visibleBounds(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !b.width || !b.height) return null;
  const ok = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return overlapX > 160 && overlapY > 120;
  });
  return ok ? b : null;
}

function isAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    // P4-1 仅允许 https（http 明文不放行）
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_HOSTS.has(host) || host.endsWith('.cewaysoft.com');
  } catch {
    return false;
  }
}

// 兜底页是 data: URL 拼出来的，任何外部字符串都必须转义后再进 HTML
function escapeHtml(v) {
  const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => MAP[c]);
}

// P4-2 离线兜底页（内联 data: URL，零新文件）
function offlinePageHtml(code, desc) {
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
<code>${escapeHtml(code)} ${escapeHtml(desc || '')}</code><br>
<button onclick="location.replace('${HOME_URL}')">重新加载</button>
</div></body></html>`;
}

// ── H5 版本同频：离开一段时间后回到窗口，比对 chunk 指纹，变了才重载 ──
const SYNC_MIN_AWAY = 5 * 60 * 1000;
const SYNC_MIN_GAP = 10 * 60 * 1000;
let blurredAt = 0;
let lastSyncAt = 0;
let syncingH5 = false;

// 只取 /_next/static/chunks/ 的路径；判断服务端是否多出本地没有的 chunk
function chunkPathsFromHtml(html, base) {
  const out = [];
  const re = /<script[^>]+src="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1], base);
      if (u.pathname.includes('/_next/static/chunks/')) out.push(u.pathname);
    } catch { /* 忽略非法 src */ }
  }
  return out;
}

async function syncH5Version() {
  if (syncingH5 || !mainWindow || mainWindow.isDestroyed()) return;
  if (Date.now() - lastSyncAt < SYNC_MIN_GAP) return;
  const url = mainWindow.webContents.getURL();
  if (!/^https:\/\/cajob\.cewaysoft\.com\//.test(url)) return;

  syncingH5 = true;
  lastSyncAt = Date.now();
  try {
    // 必须用窗口自己的 session 取，否则拿不到登录态，会被重定向到登录页
    const res = await mainWindow.webContents.session.fetch(url, { cache: 'no-store' });
    if (!res.ok) return;
    const remote = chunkPathsFromHtml(await res.text(), url);
    const local = await mainWindow.webContents.executeJavaScript(
      `Array.from(document.scripts).map(s => s.getAttribute('src') || '').filter(s => s.indexOf('/_next/static/chunks/') >= 0).map(s => new URL(s, location.href).pathname)`,
      true
    );
    if (!local || !local.length || !remote.length) return;
    const localSet = new Set(local);
    if (!remote.some((p) => !localSet.has(p))) return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  } catch { /* 网络异常：下次回到前台再试 */ }
  finally { syncingH5 = false; }
}

function syncH5IfAway() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) return;
  if (Date.now() - blurredAt < SYNC_MIN_AWAY) return;
  syncH5Version();
}

function createWindow() {
  const saved = loadWindowState() || {};
  const bounds = visibleBounds(saved.bounds) || { width: 1280, height: 840 };

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    title: 'Cajob',
    // 先不显示，等首帧绘完再 show，避免白底闪一下（移动端启动屏的桌面等价做法）
    show: false,
    backgroundColor: bgColor(),
    autoHideMenuBar: true,
    icon: APP_ICON,
    // macOS 保留原生标题栏：H5 页头自带品牌栏，隐藏后红绿灯会压住页面内容
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 会话持久化（默认即 persist:default，显式声明便于后续分区）
      partition: 'persist:cajob',
    },
  });

  if (saved.maximized) mainWindow.maximize();
  if (Number.isFinite(saved.zoom) && saved.zoom !== 1) {
    mainWindow.webContents.setZoomFactor(Math.min(3, Math.max(0.5, saved.zoom)));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  blurredAt = Date.now();
  mainWindow.loadURL(HOME_URL);

  // 离开 ≥5 分钟再回到窗口：与线上 H5 对一次版本，变了静默重载
  mainWindow.on('blur', () => { blurredAt = Date.now(); });
  mainWindow.on('focus', syncH5IfAway);
  mainWindow.on('minimize', () => { blurredAt = Date.now(); });
  mainWindow.on('restore', syncH5IfAway);

  // 窗口尺寸/位置变化时落盘（拖动过程中节流，关闭时再存一次兜底）
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(mainWindow), 400);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('maximize', scheduleSave);
  mainWindow.on('unmaximize', scheduleSave);

  // 站内导航：cewaysoft.com 域内放行（OAuth 回跳链），其余交给系统浏览器
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // 新窗口请求（target=_blank / window.open）：域内在当前窗口打开，域外系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url) && mainWindow) {
      mainWindow.loadURL(url);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // P4-2 主框架加载失败 → 内联离线兜底页（含重新加载入口）
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    // ERR_ABORTED(-3)：导航被取消（如重定向接续），不当作失败
    if (!isMainFrame || errorCode === -3 || !mainWindow) return;
    mainWindow
      .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(offlinePageHtml(errorCode, errorDescription)))
      .catch(() => {});
  });

  // 渲染进程崩溃：自动恢复一次，仍失败才提示（避免白屏无反馈）
  mainWindow.webContents.on('render-process-gone', async (_e, details) => {
    if (details.reason === 'clean-exit') return;
    if (rendererCrashes < 1) {
      rendererCrashes += 1;
      mainWindow.reload();
      return;
    }
    try {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Cajob',
        message: '页面异常退出',
        detail: `原因：${details.reason}。点击确定重新加载。`,
        buttons: ['重新加载'],
      });
      rendererCrashes = 0;
      mainWindow.loadURL(HOME_URL);
    } catch { /* 窗口已关闭 */ }
  });

  // 下载：任务栏显示进度，完成后复位并提示保存位置
  session.fromPartition('persist:cajob').on('will-download', (_event, item) => {
    const total = item.getTotalBytes();
    item.on('updated', (_e, state) => {
      if (state !== 'progressing' || !mainWindow || total <= 0) return;
      mainWindow.setProgressBar(Math.min(1, item.getReceivedBytes() / total));
    });
    item.once('done', (_e, state) => {
      if (mainWindow) mainWindow.setProgressBar(-1);
      if (state === 'completed') {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: '下载完成',
          message: item.getFilename(),
          detail: item.getSavePath(),
          buttons: ['好'],
        }).catch(() => {});
      }
    });
  });

  // Windows/Linux 没有应用菜单，快捷键在这里补齐（macOS 由菜单角色提供）
  if (process.platform !== 'darwin') {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const mod = input.control || input.meta;
      const wc = mainWindow.webContents;
      const key = input.key;
      if (mod && (key === '=' || key === '+')) { wc.setZoomLevel(wc.getZoomLevel() + 0.5); event.preventDefault(); }
      else if (mod && key === '-') { wc.setZoomLevel(wc.getZoomLevel() - 0.5); event.preventDefault(); }
      else if (mod && key === '0') { wc.setZoomLevel(0); event.preventDefault(); }
      else if (key === 'F11') { mainWindow.setFullScreen(!mainWindow.isFullScreen()); event.preventDefault(); }
      else if (key === 'F5') { wc.reload(); event.preventDefault(); }
      else if (input.alt && key === 'ArrowLeft') { wc.navigationHistory.goBack(); event.preventDefault(); }
      else if (input.alt && key === 'ArrowRight') { wc.navigationHistory.goForward(); event.preventDefault(); }
      else if (mod && input.shift && (key === 'I' || key === 'i') && !app.isPackaged) { wc.toggleDevTools(); event.preventDefault(); }
    });

    // 鼠标侧键（上一页/下一页）
    mainWindow.on('app-command', (_e, cmd) => {
      if (cmd === 'browser-backward') mainWindow.webContents.navigationHistory.goBack();
      if (cmd === 'browser-forward') mainWindow.webContents.navigationHistory.goForward();
    });
  }

  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Phase 3 自动更新：generic 源（/download/latest/），仅打包态启用
let autoUpdater = null;
let manualCheck = false;

function checkForUpdates(manual) {
  if (!app.isPackaged || !autoUpdater) return;
  manualCheck = !!manual;
  autoUpdater.checkForUpdates().catch(() => {});
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return; // 依赖缺失（如手工运行 dist 产物）时直接跳过
  }
  autoUpdater.autoDownload = true; // 检出即后台下载，下载完成再询问重启
  autoUpdater.logger = console;

  autoUpdater.on('download-progress', (p) => {
    if (mainWindow && Number.isFinite(p.percent)) mainWindow.setProgressBar(Math.min(1, p.percent / 100));
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (mainWindow) mainWindow.setProgressBar(-1);
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

  // 手动检查时给出明确反馈；后台轮询保持静默
  autoUpdater.on('update-not-available', () => {
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Cajob 更新',
      message: '当前已是最新版本',
      detail: `版本 ${app.getVersion()}`,
      buttons: ['好'],
    }).catch(() => {});
  });

  // 签名未就绪 / 网络异常 / yml 缺失：静默失败，不影响主流程
  autoUpdater.on('error', (err) => {
    console.log('[cajob] updater error (suppressed):', err && err.message);
    if (mainWindow) mainWindow.setProgressBar(-1);
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Cajob 更新',
      message: '检查更新失败',
      detail: '请稍后重试，或前往下载页手动获取最新版本。',
      buttons: ['好'],
    }).catch(() => {});
  });

  // 启动 10s 后检查一次；此后每 30 分钟轮询
  setTimeout(() => checkForUpdates(false), 10_000);
  setInterval(() => checkForUpdates(false), 30 * 60_000);
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
    { label: '检查更新…', accelerator: 'Cmd+U', click: () => checkForUpdates(true) },
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
  // Windows：任务栏分组与通知归属（缺这行系统会把通知算到 electron.exe 名下）
  if (process.platform === 'win32') app.setAppUserModelId('com.cewaycloud.cajob');

  // macOS 开发模式下 Dock 图标（打包后由 .app 内嵌 icns 接管）
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(APP_ICON);
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    app.setAboutPanelOptions({
      applicationName: 'Cajob',
      applicationVersion: app.getVersion(),
      copyright: '© 2026 捷才智通',
    });
  }

  // 系统主题切换时同步窗口底色，避免深色模式下露出白底
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(bgColor());
  });

  buildMenu();
  createWindow();
  setupAutoUpdate();

  // 系统休眠唤醒后也做一次同频检查（唤醒时窗口可能没触发 blur/focus）
  powerMonitor.on('resume', () => {
    blurredAt = 0;
    syncH5IfAway();
  });

  app.on('activate', () => {
    // macOS：点击 Dock 图标时若无窗口则重建
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) {
      mainWindow.focus();
      syncH5IfAway();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
