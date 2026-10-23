'use strict';

const { app, BrowserWindow, Menu, shell, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const APP_ID = 'com.dreamchaserstrive.drivecleaner';
const APP_NAME = 'DriveCleaner';
const LEGACY_APP_NAME = 'CDriveCleaner';

function migrateLegacyData() {
  try {
    const newDataDir = path.join(app.getPath('appData'), APP_NAME, 'data');
    const legacyDataDir = path.join(app.getPath('appData'), LEGACY_APP_NAME, 'data');
    if (fs.existsSync(newDataDir) && fs.readdirSync(newDataDir).length) return;
    if (!fs.existsSync(legacyDataDir)) return;
    fs.mkdirSync(newDataDir, { recursive: true });
    for (const name of fs.readdirSync(legacyDataDir)) {
      if (!/^(scan|progress)(\.[A-Z])?\.json$/.test(name)) continue;
      fs.copyFileSync(path.join(legacyDataDir, name), path.join(newDataDir, name));
    }
  } catch (_) {
    // 迁移失败时继续使用新目录，最多重新扫描一次，不影响数据安全。
  }
}

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
migrateLegacyData();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  let mainWindow = null;
  let backend = null;
  let backendPort = 0;
  let quitting = false;
  let logStream = null;

  function dataDir() {
    return process.env.CDRIVE_DATA_DIR
      ? path.resolve(process.env.CDRIVE_DATA_DIR)
      : path.join(app.getPath('userData'), 'data');
  }

  function backendLogPath() {
    return path.join(app.getPath('userData'), 'backend.log');
  }

  function getFreePort() {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.unref();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
  }

  function waitForServer(port, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let settled = false;

      function finish(err) {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      }

      function retry() {
        if (quitting) return finish(new Error('应用正在退出'));
        if (Date.now() - startedAt > timeoutMs) {
          return finish(new Error('后台服务启动超时'));
        }
        setTimeout(attempt, 250);
      }

      function attempt() {
        if (settled) return;
        const req = http.get(
          { host: '127.0.0.1', port, path: '/api/status', timeout: 1200 },
          (res) => {
            res.resume();
            if (res.statusCode === 200) finish();
            else retry();
          }
        );
        req.on('error', retry);
        req.on('timeout', () => {
          req.destroy();
          retry();
        });
      }

      attempt();
    });
  }

  function startBackend(port) {
    const appRoot = path.join(__dirname, '..');
    const scanDataDir = dataDir();
    fs.mkdirSync(scanDataDir, { recursive: true });
    fs.mkdirSync(app.getPath('userData'), { recursive: true });

    logStream = fs.createWriteStream(backendLogPath(), { flags: 'a' });
    logStream.write(`\n[${new Date().toISOString()}] starting backend on 127.0.0.1:${port}\n`);

    backend = spawn(process.execPath, [path.join(appRoot, 'server.js')], {
      cwd: appRoot,
      env: {
        ...process.env,
        PORT: String(port),
        NO_OPEN: '1',
        CDRIVE_DATA_DIR: scanDataDir,
        ELECTRON_RUN_AS_NODE: '1',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    backend.stdout.pipe(logStream, { end: false });
    backend.stderr.pipe(logStream, { end: false });

    backend.on('error', (err) => {
      if (logStream) logStream.write(`[backend error] ${err.stack || err}\n`);
    });

    backend.on('exit', (code, signal) => {
      backend = null;
      if (quitting) return;
      quitting = true;
      dialog.showErrorBox(
        '磁盘空间清理无法继续运行',
        `后台服务已退出（代码 ${code ?? '未知'}，信号 ${signal ?? '无'}）。\n\n日志文件：\n${backendLogPath()}`
      );
      app.quit();
    });
  }

  function stopBackend() {
    if (logStream) {
      try {
        logStream.end();
      } catch (_) {}
      logStream = null;
    }
    if (!backend || backend.killed) return;
    const pid = backend.pid;
    backend = null;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch (_) {}
  }

  function isAppUrl(url) {
    try {
      return new URL(url).origin === `http://127.0.0.1:${backendPort}`;
    } catch (_) {
      return false;
    }
  }

  async function createWindow() {
    Menu.setApplicationMenu(null);

    const { workAreaSize } = screen.getPrimaryDisplay();
    const width = Math.max(920, Math.min(1440, workAreaSize.width - 48));
    const height = Math.max(640, Math.min(920, workAreaSize.height - 48));

    mainWindow = new BrowserWindow({
      width,
      height,
      minWidth: 920,
      minHeight: 640,
      center: true,
      show: false,
      backgroundColor: '#f8f3ea',
      title: '磁盘空间清理',
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    mainWindow.once('ready-to-show', () => {
      if (!mainWindow) return;
      mainWindow.show();
      mainWindow.focus();
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (!isAppUrl(url)) {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
      }
      return { action: 'allow' };
    });

    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (isAppUrl(url)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });

    await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`);
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopBackend();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.whenReady().then(async () => {
    try {
      backendPort = await getFreePort();
      startBackend(backendPort);
      await waitForServer(backendPort);
      await createWindow();
    } catch (err) {
      if (quitting) return;
      quitting = true;
      stopBackend();
      dialog.showErrorBox(
        '磁盘空间清理启动失败',
        `${err && err.message ? err.message : String(err)}\n\n日志文件：\n${backendLogPath()}`
      );
      app.quit();
    }
  });
}
