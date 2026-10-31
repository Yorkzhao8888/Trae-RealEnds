// {{displayName}} · UendOS PC 壳主进程（由 uendos init 生成）
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const runtime = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'uendos.runtime.json'), 'utf8'));
  } catch (e) {
    return { displayName: '{{displayName}}', ends: {}, primaryEnd: null };
  }
})();

const primaryUrl = runtime.ends && runtime.primaryEnd ? runtime.ends[runtime.primaryEnd].url : null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: runtime.displayName || '{{displayName}}',
    backgroundColor: '#0B0F17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (primaryUrl) {
    win.loadURL(primaryUrl).catch(() => win.loadFile('offline.html'));
  } else {
    win.loadFile('offline.html');
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

ipcMain.handle('desktop:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) return shell.openExternal(url);
  throw new Error('invalid url');
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
