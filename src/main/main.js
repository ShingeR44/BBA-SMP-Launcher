'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const auth = require('./auth');
const mc = require('./minecraft');
const modpack = require('./modpack');
const status = require('./status');
const ygg = require('./yggdrasil');
const news = require('./news');
const { Content } = require('./content');
const { Updater } = require('./updater');

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
let content = null;
let updater = null;
// pack.json без сети: берём сохранённый, чтобы вкладка «Сборка» работала офлайн
function cachedPack() {
  if (lastPack) return lastPack;
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'pack.json'), 'utf8'));
  } catch {
    return null;
  }
}

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

// Размер окна: прошлый, если он ещё помещается на экран; иначе — под рабочую область экрана
function initialBounds() {
  const saved = store.settings.windowBounds;
  const fits = (b) =>
    b && screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x >= a.x - 50 && b.y >= a.y - 50 && b.x + Math.min(b.width, 300) <= a.x + a.width && b.y + 100 <= a.y + a.height;
    });
  if (fits(saved)) return saved;
  const wa = screen.getPrimaryDisplay().workAreaSize;
  return { width: Math.max(980, Math.min(1360, Math.round(wa.width * 0.8))), height: Math.max(640, Math.min(860, Math.round(wa.height * 0.85))) };
}

function createWindow() {
  const bounds = initialBounds();
  win = new BrowserWindow({
    ...bounds,
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
  win.once('ready-to-show', () => {
    if (store.settings.windowMaximized) win.maximize();
    win.show();
  });
  // запоминаем размер, положение и «развёрнуто ли»
  let saveTimer = null;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      const maximized = win.isMaximized();
      store.setSettings(maximized ? { windowMaximized: true } : { windowMaximized: false, windowBounds: win.getBounds() });
    }, 400);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  const sendMax = () => send('win-state', { maximized: win.isMaximized() });
  win.on('maximize', () => (sendMax(), saveBounds()));
  win.on('unmaximize', () => (sendMax(), saveBounds()));
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

// ---------- Адреса сервера ----------
// Список берётся из pack.json (servers), иначе из launcher.config.json (servers), иначе один адрес server.
function normServer(x) {
  if (!x || !x.host) return null;
  const port = Number(x.port) || 25565;
  return {
    id: `${String(x.host).toLowerCase()}:${port}`,
    host: String(x.host),
    port,
    name: x.name ? String(x.name) : null,
    description: x.description ? String(x.description) : null,
  };
}
function serverList(pack) {
  const p = pack || cachedPack();
  const pick = (a) => (Array.isArray(a) && a.length ? a : null);
  const raw = pick(p && p.servers) || pick(config.servers) || [(p && p.server) || config.server];
  const seen = new Set();
  return raw.map(normServer).filter((x) => x && !seen.has(x.id) && seen.add(x.id));
}
function selectedServer(pack) {
  const list = serverList(pack);
  return list.find((x) => x.id === store.settings.serverAddress) || list[0] || null;
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
    server: selectedServer(pack),
    mods,
    totalSize: pack.files.reduce((s, f) => s + (f.size || 0), 0),
    installed,
    upToDate: installed === pack.version,
    offline: !!pack._offline,
    mirror: !!pack._mirror,
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
    const pack = await modpack.loadPack(config.packUrl, ROOT, { signal, mirror: config.packMirror });
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
    // свои моды игрока, которые дублируют моды сборки или сделаны под другой загрузчик, выключаем
    const disabled = await content.enforce();

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
      server: s.autoConnect ? selectedServer(pack) : null,
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
    send('game-state', { running: true, visible: false, removed: sync.removed, disabled });
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
  handle('win:maximize', () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  handle('win:isMaximized', () => win.isMaximized());
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
    const pack = await modpack.loadPack(config.packUrl, ROOT, { mirror: config.packMirror }).catch(() => lastPack);
    if (pack) lastPack = pack;
    return packSummary(pack, await modpack.installedVersion(ROOT));
  });

  handle('news:list', () => news.fetchNews(config.newsUrl, ROOT));

  // ---- свои файлы игрока ----
  const FILTERS = {
    mods: [{ name: 'Моды (.jar)', extensions: ['jar'] }],
    shaderpacks: [{ name: 'Шейдеры (.zip)', extensions: ['zip'] }],
    resourcepacks: [{ name: 'Ресурспаки (.zip)', extensions: ['zip'] }],
  };
  handle('content:list', (kind) => content.list(kind));
  handle('content:add', async (kind, paths) => {
    if (!paths || !paths.length) {
      const r = await dialog.showOpenDialog(win, {
        title: 'Добавить файлы',
        filters: [...(FILTERS[kind] || []), { name: 'Все подходящие', extensions: ['jar', 'zip'] }],
        properties: ['openFile', 'multiSelections'],
      });
      if (r.canceled) return { added: [], rejected: [] };
      paths = r.filePaths;
    }
    return content.add(paths.filter((p) => typeof p === 'string'), kind);
  });
  handle('content:toggle', (kind, file, enabled) => content.toggle(kind, file, !!enabled));
  handle('content:remove', (kind, file) => content.remove(kind, file));
  handle('content:folder', async (kind) => {
    const dir = content.dir(kind);
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });

  // ---- обновление лаунчера ----
  handle('update:state', () => updater.state);
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.install());

  handle('server:status', async () => {
    const srv = selectedServer(lastPack);
    if (!srv) return { online: false, error: 'no_server' };
    return { ...(await status.ping(srv.host, srv.port)), id: srv.id, host: srv.host, port: srv.port };
  });
  handle('server:list', () => {
    const sel = selectedServer(lastPack);
    return serverList(lastPack).map((x) => ({ ...x, selected: !!sel && x.id === sel.id }));
  });
  handle('server:select', (id) => {
    if (!serverList(lastPack).some((x) => x.id === id)) throw new Error('Такого адреса нет в списке');
    store.setSettings({ serverAddress: id });
    return serverList(lastPack).map((x) => ({ ...x, selected: x.id === id }));
  });
  // пинг всех адресов сразу — чтобы игрок видел, какой у него работает
  handle('server:pingAll', async () =>
    Promise.all(
      serverList(lastPack).map(async (x) => {
        const r = await status.ping(x.host, x.port, 5000);
        return { id: x.id, online: !!r.online, latency: r.latency || null, players: r.players || null, error: r.error || null };
      })
    )
  );

  handle('game:play', (opts) => play(opts || {}));
  handle('game:cancel', () => {
    if (abort) abort.abort();
  });
  handle('game:running', () => !!gameProcess);
}

app.whenReady().then(async () => {
  store = await new Store().init();
  content = new Content({ gameDir: GAME_DIR, getPack: cachedPack, trash: (p) => shell.trashItem(p) });
  updater = new Updater({
    repo: config.update && config.update.github,
    allowPrerelease: !!(config.update && config.update.allowPrerelease),
    send,
    canInstall: () => !gameProcess,
  });
  registerIpc();
  createWindow();
  updater.start();
});

app.on('window-all-closed', () => {
  if (gameProcess) gameProcess.unref();
  app.quit();
});
