'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const auth = require('./auth');
const mc = require('./minecraft');
const modpack = require('./modpack');
const status = require('./status');
const ygg = require('./yggdrasil');
const news = require('./news');

// ---------- Конфиг лаунчера ----------
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'launcher.config.json'), 'utf8'));
const ROOT = path.join(app.getPath('appData'), config.dataFolder || '.bba-smp');
const GAME_DIR = path.join(ROOT, 'game');
// настройки входа (старое поле msClientId тоже понимаем)
const AUTH = {
  yggdrasil: (config.auth && config.auth.yggdrasil) || {},
  msClientId: (config.auth && config.auth.microsoftClientId) || config.msClientId || '',
};
const MS_ENABLED = /^[0-9a-f-]{36}$/i.test(AUTH.msClientId);

let win = null;
let store = null;
let gameProcess = null;
let abort = null;
let lastPack = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: store.settings.theme === 'light' ? '#fff7fa' : '#1b0912',
    title: config.serverName || 'BBA SMP',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // ссылки — только во внешний браузер
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Обёртка: в renderer всегда приходит {ok, data} или {ok:false, error}
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      console.error(`[${channel}]`, e);
      return { ok: false, error: e.message || String(e), code: e.code };
    }
  });
}

function recommendedMemory(pack) {
  const total = Store.totalMemoryMb();
  const rec = (pack && pack.memory && pack.memory.recommended) || 4096;
  return Math.min(rec, Math.max(1024, total - 2048));
}

function packSummary(pack, installed) {
  if (!pack) return null;
  const mods = pack.files
    .filter((f) => f.path.startsWith('mods/') && f.path.endsWith('.jar'))
    .map((f) => ({ file: f.path.slice(5), size: f.size || 0, name: f.name || null }));
  return {
    name: pack.name || config.serverName,
    version: pack.version || '—',
    minecraft: pack.minecraft,
    loader: pack.loader || { type: 'vanilla' },
    server: pack.server || config.server,
    mods,
    totalSize: pack.files.reduce((s, f) => s + (f.size || 0), 0),
    installed,
    upToDate: installed === pack.version,
    offline: !!pack._offline,
    offlineError: pack._error || null,
    recommendedMemory: recommendedMemory(pack),
  };
}

// ---------- Игра ----------
async function play({ repair = false } = {}) {
  if (gameProcess) throw new Error('Игра уже запущена');
  abort = new AbortController();
  const signal = abort.signal;
  const s = store.settings;
  let stage = '';
  const progress = (text, frac = null, detail = '') => send('progress', { stage, text, frac, detail });
  const setStage = (st, text) => {
    stage = st;
    progress(text);
  };
  const bytesProgress = (label) => ({ bytes, total, done, count }) => {
    const frac = total ? bytes / total : count ? done / count : null;
    const detail = total ? `${(bytes / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} МБ` : `${done} / ${count}`;
    progress(label, frac, detail);
  };

  try {
    // 1. Аккаунт
    setStage('auth', 'Проверяем аккаунт…');
    let account = store.getSelected();
    if (!account) throw Object.assign(new Error('Сначала войдите в аккаунт'), { code: 'no_account' });
    account = account.type === 'ygg' ? await ygg.refresh(account) : await auth.refresh(account, AUTH.msClientId);
    await store.upsertAccount(account);
    let injector = null;
    if (account.type === 'ygg') {
      setStage('auth', 'Готовим вход через сервер авторизации…');
      injector = {
        jar: await ygg.ensureInjector(ROOT, { signal, customUrl: AUTH.yggdrasil.injectorUrl }),
        apiRoot: account.apiRoot,
        metadata: account.apiMetadata,
      };
    }

    // 2. Сборка
    setStage('pack', 'Получаем информацию о сборке…');
    const pack = await modpack.loadPack(config.packUrl, ROOT, { signal });
    lastPack = pack;

    // 3. Minecraft
    setStage('minecraft', `Готовим Minecraft ${pack.minecraft}…`);
    await mc.installVanillaJson(ROOT, pack.minecraft, { signal });
    const base = await mc.resolveVersion(ROOT, pack.minecraft);

    // 4. Java
    setStage('java', 'Проверяем Java…');
    const java = await mc.ensureJava(ROOT, base, {
      customPath: s.javaPath,
      repair,
      signal,
      onProgress: bytesProgress('Загружаем Java…'),
    });

    // 5. Загрузчик модов
    const loaderName = (pack.loader && pack.loader.type) || 'vanilla';
    setStage('loader', `Устанавливаем ${loaderName}…`);
    const versionId = await mc.installLoader(ROOT, pack, java.java, {
      signal,
      onLog: (line) => progress(`Устанавливаем ${loaderName}…`, null, line.trim().slice(-90)),
    });
    const version = await mc.resolveVersion(ROOT, versionId);

    // 6. Библиотеки и ассеты
    setStage('files', 'Проверяем файлы игры…');
    await mc.installGameFiles(ROOT, version, {
      repair,
      signal,
      onStage: (t) => progress(t),
      onProgress: bytesProgress('Загружаем файлы игры…'),
    });
    await mc.extractNatives(ROOT, version);

    // 7. Моды и конфиги
    setStage('modpack', 'Синхронизируем сборку…');
    fs.mkdirSync(GAME_DIR, { recursive: true });
    const sync = await modpack.syncPack(pack, ROOT, GAME_DIR, {
      repair,
      signal,
      onStage: (t) => progress(t),
      onProgress: bytesProgress('Загружаем моды…'),
    });

    // 8. Запуск
    setStage('launch', 'Запускаем игру…');
    const memoryMb = s.memoryMb || recommendedMemory(pack);
    const args = mc.buildLaunchArgs(ROOT, version, {
      account,
      gameDir: GAME_DIR,
      memoryMb,
      jvmArgs: [...(pack.jvmArgs || []), ...String(s.jvmArgs || '').split(/\s+/).filter(Boolean)],
      width: s.width,
      height: s.height,
      fullscreen: s.fullscreen,
      server: s.autoConnect ? pack.server || config.server : null,
      clientId: account.type === 'ygg' ? '' : AUTH.msClientId,
      injector,
      launcherVersion: app.getVersion(),
      versionType: `${config.serverName} ${pack.version || ''}`.trim(),
    });

    const started = Date.now();
    let shown = false;
    gameProcess = mc.launch(java.javaw, args, {
      gameDir: GAME_DIR,
      logFile: path.join(GAME_DIR, 'logs', 'launcher-last.log'),
      onLog: (line) => {
        if (!shown && /Setting user:|Backend library: LWJGL|OpenAL initialized|Reloading ResourceManager/.test(line)) {
          shown = true;
          send('game-state', { running: true, visible: true });
          if (s.afterLaunch === 'hide' && win) win.hide();
          else if (s.afterLaunch === 'minimize' && win) win.minimize();
        }
      },
    });
    send('game-state', { running: true, visible: false, removed: sync.removed });
    gameProcess.on('error', (e) => {
      send('game-state', { running: false, error: `Не удалось запустить Java: ${e.message}` });
      gameProcess = null;
    });
    gameProcess.on('exit', (code) => {
      gameProcess = null;
      if (win) {
        win.show();
        win.focus();
      }
      const crashed = code !== 0 && code !== null;
      send('game-state', {
        running: false,
        exitCode: code,
        error: crashed ? `Игра завершилась с ошибкой (код ${code})${Date.now() - started < 60000 ? ' сразу после запуска' : ''}. Подробности — в логе.` : null,
      });
    });
    return { ok: true };
  } finally {
    abort = null;
  }
}

// ---------- IPC ----------
function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    serverName: config.serverName,
    siteUrl: config.siteUrl,
    links: config.links || [],
    totalMemoryMb: Store.totalMemoryMb(),
    root: ROOT,
    auth: {
      yggdrasil: {
        configured: !!AUTH.yggdrasil.url,
        title: AUTH.yggdrasil.title || 'Аккаунт сервера',
        registerUrl: AUTH.yggdrasil.registerUrl || null,
        resetUrl: AUTH.yggdrasil.resetUrl || null,
      },
      microsoft: { configured: MS_ENABLED },
    },
    newsConfigured: !!config.newsUrl,
  }));

  handle('win:minimize', () => win.minimize());
  handle('win:close', () => win.close());

  handle('shell:external', (url) => {
    if (!/^https:\/\//.test(url)) throw new Error('Разрешены только https-ссылки');
    return shell.openExternal(url);
  });
  handle('shell:folder', async (which) => {
    const map = { game: GAME_DIR, mods: path.join(GAME_DIR, 'mods'), logs: path.join(GAME_DIR, 'logs'), screenshots: path.join(GAME_DIR, 'screenshots'), root: ROOT };
    const dir = map[which] || GAME_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });

  handle('settings:get', () => store.settings);
  handle('settings:set', (patch) => store.setSettings(patch));
  handle('settings:pickJava', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Выберите javaw.exe',
      filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [],
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('accounts:list', () => store.publicAccounts());
  const addAccount = async (acc) => {
    await store.upsertAccount(acc);
    store.setSettings({ selectedAccount: Store.key(acc) });
    return store.publicAccounts();
  };
  handle('accounts:loginMicrosoft', async () => addAccount(await auth.login(AUTH.msClientId, win)));
  handle('accounts:loginYggdrasil', async (username, password) => addAccount(await ygg.login(AUTH.yggdrasil, username, password)));
  handle('accounts:select', (id) => {
    store.setSettings({ selectedAccount: id });
    return store.publicAccounts();
  });
  handle('accounts:remove', async (key) => {
    const acc = store.accounts.find((a) => Store.key(a) === key);
    if (acc && acc.type === 'ygg') await ygg.logout(acc);
    await store.removeAccount(key);
    return store.publicAccounts();
  });

  handle('pack:info', async () => {
    const pack = await modpack.loadPack(config.packUrl, ROOT).catch(() => lastPack);
    if (pack) lastPack = pack;
    return packSummary(pack, await modpack.installedVersion(ROOT));
  });

  handle('news:list', () => news.fetchNews(config.newsUrl, ROOT));

  handle('server:status', async () => {
    const srv = (lastPack && lastPack.server) || config.server;
    if (!srv || !srv.host) return { online: false, error: 'no_server' };
    return { ...(await status.ping(srv.host, srv.port || 25565)), host: srv.host, port: srv.port || 25565 };
  });

  handle('game:play', (opts) => play(opts || {}));
  handle('game:cancel', () => {
    if (abort) abort.abort();
  });
  handle('game:running', () => !!gameProcess);
}

app.whenReady().then(async () => {
  store = await new Store().init();
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  if (gameProcess) gameProcess.unref();
  app.quit();
});
