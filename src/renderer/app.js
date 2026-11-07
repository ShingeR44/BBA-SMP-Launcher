'use strict';
/* global bba */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
};

const state = {
  info: null,
  settings: null,
  accounts: [],
  pack: null,
  server: null,
  busy: false,
  running: false,
  news: [],
  newsLoaded: false,
};

const LOADER_NAMES = { vanilla: 'Ванилла', fabric: 'Fabric', quilt: 'Quilt', neoforge: 'NeoForge', forge: 'Forge' };
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);
const fmtMem = (mb) => (mb % 1024 === 0 ? `${mb / 1024} ГБ` : `${(mb / 1024).toFixed(1)} ГБ`);

// ---------- Пиксельный логотип (замените на assets/logo.png — подхватится автоматически) ----------
const GLYPHS = {
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
};
function pixelText(text, px, x0, y0, fill) {
  let out = '';
  [...text].forEach((ch, i) => {
    GLYPHS[ch].forEach((row, y) =>
      [...row].forEach((b, x) => {
        if (b === '1') out += `<rect x="${x0 + (i * 6 + x) * px}" y="${y0 + y * px}" width="${px}" height="${px}" fill="${fill}"/>`;
      })
    );
  });
  return out;
}
function renderLogo() {
  const host = $('#logo');
  const img = new Image();
  img.alt = 'BBA SMP';
  img.onload = () => host.replaceChildren(img);
  img.onerror = () => {
    const svg =
      `<svg viewBox="0 0 80 52" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">` +
      `<defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff4fd8"/><stop offset="1" stop-color="#b000c8"/></linearGradient></defs>` +
      pixelText('BBA', 4, 7, 5, '#3a0030') +
      pixelText('BBA', 4, 5, 3, 'url(#lg)') +
      `<rect x="20" y="36" width="40" height="14" fill="#f3a7c8"/>` +
      pixelText('SMP', 1.6, 26, 38.5, '#7a0040') +
      `</svg>`;
    host.innerHTML = svg;
  };
  img.src = 'assets/logo.png';
}

// ---------- Аватар из скина ----------
function faceCanvas(skin, name, size = 48) {
  const c = el('canvas', { class: 'face', width: 8, height: 8 });
  c.style.width = c.style.height = `${size}px`;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (!skin) {
    ctx.fillStyle = '#e0005a';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = '#fff';
    ctx.fillRect(2, 3, 1, 1);
    ctx.fillRect(5, 3, 1, 1);
    ctx.fillRect(3, 5, 2, 1);
    return c;
  }
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
    ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);
  };
  img.src = skin;
  return c;
}

// ---------- Уведомления ----------
function toast(text, { ok = false, actions = [], timeout = 7000 } = {}) {
  const t = el('div', { class: `toast${ok ? ' ok' : ''}` }, text);
  if (actions.length) t.append(el('div', { class: 'toast-actions' }, actions.map((a) => el('button', { class: 'btn ghost small', onclick: () => { a.run(); t.remove(); } }, a.label))));
  t.addEventListener('click', (e) => { if (e.target === t) t.remove(); });
  $('#toasts').append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
}
const showError = (e, extra = {}) => toast(e.message || String(e), { timeout: 12000, ...extra });

// ---------- Навигация ----------
function go(page) {
  if (page === 'news') markNewsSeen();
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  $('.content').scrollTop = 0;
}

// ---------- Отрисовка ----------
function stat(label, value, cls = '') {
  return el('div', { class: 'stat' }, el('div', { class: 'label' }, label), el('div', { class: `value ${cls}` }, value));
}

function loaderLabel(p) {
  const l = (p && p.loader) || {};
  const name = LOADER_NAMES[(l.type || 'vanilla').toLowerCase()] || l.type;
  return l.version && l.version !== 'latest' ? `${name} ${l.version}` : name;
}

function renderHome() {
  const p = state.pack;
  const s = state.server;
  $('#homeStats').replaceChildren(
    stat('Версия', p ? `Java ${p.minecraft}` : '—'),
    stat('Загрузчик', p ? loaderLabel(p) : '—'),
    stat('Модов', p ? String(p.mods.length) : '—'),
    stat('Сборка', p ? p.version : '—', p && !p.upToDate ? 'warn' : ''),
    stat('Онлайн', s && s.online ? `${s.players.online} / ${s.players.max}` : 'нет связи', s && s.online ? 'ok' : '')
  );
  const srv = p && p.server;
  $('#serverAddress').textContent = srv && srv.host ? (srv.port && srv.port !== 25565 ? `${srv.host}:${srv.port}` : srv.host) : '—';
  $('#serverMotd').textContent = s && s.online ? [s.motd, s.version && `Версия сервера: ${s.version}`, `Пинг ${s.latency} мс`].filter(Boolean).join(' · ') : '';
  if (state.info) $('#heroTitle').textContent = state.info.serverName || 'BBA SMP';
}

function renderPack() {
  const p = state.pack;
  $('#packStats').replaceChildren(
    stat('Minecraft', p ? p.minecraft : '—'),
    stat('Загрузчик', p ? loaderLabel(p) : '—'),
    stat('Версия сборки', p ? p.version : '—'),
    stat('Размер', p ? fmtSize(p.totalSize) : '—'),
    stat('Установлено', p ? (p.installed ? (p.upToDate ? 'актуальная' : `${p.installed} → обновить`) : 'нет') : '—', p && p.upToDate ? 'ok' : 'warn')
  );
  const list = $('#modList');
  if (!p) {
    list.replaceChildren(el('div', { class: 'empty' }, 'Не удалось получить сборку. Проверьте интернет.'));
    $('#modCount').textContent = '';
    return;
  }
  $('#modCount').textContent = p.mods.length ? `· ${p.mods.length}` : '';
  const mods = [...p.mods].sort((a, b) => (a.name || a.file).localeCompare(b.name || b.file));
  list.replaceChildren(
    ...(mods.length
      ? mods.map((m) => el('div', { class: 'mod', title: m.file }, el('span', { class: 'name' }, m.name || prettyMod(m.file)), el('span', { class: 'size' }, m.size ? fmtSize(m.size) : '')))
      : [el('div', { class: 'empty' }, 'В сборке пока нет модов.')])
  );
}

function prettyMod(file) {
  return file
    .replace(/\.jar$/i, '')
    .replace(/[-_+](mc|fabric|neoforge|forge|quilt)?[-_]?\d[\w.+-]*$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------- Аккаунт (внизу слева) ----------
const ACCOUNT_TYPE = { ygg: () => (state.info && state.info.auth.yggdrasil.title) || 'Аккаунт сервера', msa: () => 'Microsoft' };
const selectedAccount = () => state.accounts.find((x) => x.selected) || state.accounts[0] || null;

function renderAccounts() {
  const a = selectedAccount();
  $('#accountChip').replaceChildren(
    ...[
      faceCanvas(a && a.skin, a && a.name, 44),
      el('div', {}, el('b', {}, a ? a.name : 'Не выполнен вход'), el('span', {}, a ? `${ACCOUNT_TYPE[a.type]()} · сменить` : 'Нажмите, чтобы войти')),
      a ? el('span', { class: 'caret' }, '▴') : null,
    ].filter(Boolean)
  );
  if (!$('#accountMenu').hidden) renderAccountMenu();
}

function renderAccountMenu() {
  const menu = $('#accountMenu');
  menu.replaceChildren(
    el('div', { class: 'menu-title' }, 'Аккаунты'),
    ...state.accounts.map((a) =>
      el(
        'div',
        { class: 'menu-account', role: 'menuitem', onclick: () => selectAccount(a.key) },
        faceCanvas(a.skin, a.name, 36),
        el('div', { class: 'meta' }, el('b', {}, a.name), el('span', {}, ACCOUNT_TYPE[a.type]())),
        a.selected ? el('span', { class: 'check', title: 'Активный' }) : null,
        el('button', { class: 'remove', title: 'Выйти из аккаунта', onclick: (e) => { e.stopPropagation(); removeAccount(a); } }, 'Выйти')
      )
    ),
    el('button', { class: 'menu-action', onclick: () => { closeAccountMenu(); openLogin(); } }, '+ Добавить аккаунт')
  );
}

function toggleAccountMenu() {
  if (!state.accounts.length) return openLogin();
  const menu = $('#accountMenu');
  if (menu.hidden) {
    renderAccountMenu();
    menu.hidden = false;
  } else menu.hidden = true;
}
const closeAccountMenu = () => ($('#accountMenu').hidden = true);

// ---------- Окно входа ----------
function openLogin() {
  const auth = state.info.auth;
  const ygg = auth.yggdrasil;
  $('#loginSubtitle').textContent = ygg.configured
    ? 'Тот же ник и пароль, что на сайте сервера.'
    : auth.microsoft.configured
      ? 'Войдите через аккаунт Microsoft, на котором куплен Minecraft.'
      : 'Войдите в аккаунт сервера, чтобы играть.';
  $('#yggForm').hidden = !ygg.configured && auth.microsoft.configured;
  $('#yggNotice').hidden = ygg.configured;
  $('#yggUser').disabled = $('#yggPass').disabled = $('#yggSubmit').disabled = !ygg.configured;
  $('#yggRegister').hidden = !ygg.registerUrl;
  $('#yggReset').hidden = !ygg.resetUrl;
  $('#msAlt').hidden = !auth.microsoft.configured;
  $('#msAlt .divider').hidden = $('#yggForm').hidden;
  $('#loginError').hidden = true;
  $('#yggPass').value = '';
  $('#loginModal').hidden = false;
  setTimeout(() => (ygg.configured ? ($('#yggUser').value ? $('#yggPass') : $('#yggUser')).focus() : null), 50);
}
const closeLogin = () => ($('#loginModal').hidden = true);

function loginError(e) {
  const box = $('#loginError');
  box.textContent = e.message || String(e);
  box.hidden = false;
}

async function afterLogin(accounts) {
  state.accounts = accounts;
  closeLogin();
  renderAccounts();
  renderPlay();
  const a = selectedAccount();
  toast(`Вы вошли как ${a ? a.name : 'игрок'}`, { ok: true, timeout: 3500 });
}

async function loginYggdrasil(ev) {
  ev.preventDefault();
  const btn = $('#yggSubmit');
  btn.disabled = true;
  btn.textContent = 'Входим…';
  $('#loginError').hidden = true;
  try {
    await afterLogin(await bba.accounts.loginYggdrasil($('#yggUser').value, $('#yggPass').value));
  } catch (e) {
    loginError(e);
    if (e.code === 'bad_credentials') $('#yggPass').select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Войти';
  }
}

async function loginMicrosoft() {
  try {
    await afterLogin(await bba.accounts.loginMicrosoft());
  } catch (e) {
    if (e.code === 'cancelled') return;
    loginError(e);
    if (e.code === 'app_not_approved') toast('Заявка на доступ к Minecraft API ещё не одобрена', { actions: [{ label: 'Открыть форму', run: () => bba.openExternal('https://aka.ms/mce-reviewappid') }] });
  }
}

function renderStatus() {
  const s = state.server;
  const box = $('#serverStatus');
  box.classList.toggle('online', !!(s && s.online));
  $('#serverStatusText').textContent = !s ? 'проверяем…' : s.online ? `онлайн · ${s.players.online}/${s.players.max}` : 'нет связи';
  renderHome();
}

function renderPlay() {
  const btn = $('#playBtn');
  btn.classList.remove('secondary');
  btn.disabled = false;
  if (state.running) {
    btn.textContent = 'В игре';
    btn.disabled = true;
  } else if (state.busy) {
    btn.textContent = 'Отмена';
    btn.classList.add('secondary');
  } else if (!state.accounts.length) {
    btn.textContent = 'Войти';
  } else if (state.pack && !state.pack.installed) {
    btn.textContent = 'Установить';
  } else if (state.pack && !state.pack.upToDate) {
    btn.textContent = 'Обновить';
  } else {
    btn.textContent = 'Играть';
  }
}

function setProgress(text, frac = null, detail = '', indeterminate = false) {
  $('#progressText').textContent = text;
  $('#progressDetail').textContent = detail || '';
  const bar = $('.progress');
  bar.classList.toggle('indeterminate', indeterminate && frac == null);
  $('#progressFill').style.width = frac == null ? (indeterminate ? '' : '0') : `${Math.round(frac * 100)}%`;
}

function idleProgress() {
  const p = state.pack;
  if (!p) setProgress('Нет связи с сайтом сборки');
  else if (p.offline) setProgress('Офлайн: используется сохранённая сборка', null, p.version);
  else if (!p.installed) setProgress(`Сборка ${p.version} ещё не установлена`, null, fmtSize(p.totalSize));
  else if (!p.upToDate) setProgress(`Доступно обновление сборки: ${p.version}`, null, `сейчас ${p.installed}`);
  else setProgress('Готово к запуску', 1, `сборка ${p.version}`);
}

// ---------- Новости ----------
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};

function newsUnread(item) {
  const seen = state.settings.lastNewsSeen;
  if (!seen) return false; // при первом запуске не помечаем всё подряд как новое
  return (item.date || '') > seen;
}

function renderNews() {
  const list = $('#newsList');
  const items = state.news;
  $('#newsDot').hidden = !items.some(newsUnread);
  if (!state.newsLoaded) {
    list.replaceChildren(el('div', { class: 'empty' }, 'Загружаем новости…'));
    return;
  }
  if (!items.length) {
    list.replaceChildren(
      el('div', { class: 'empty' }, state.info.newsConfigured ? 'Новостей пока нет.' : 'Ленту новостей ещё не подключили (newsUrl в launcher.config.json).')
    );
    return;
  }
  list.replaceChildren(
    ...items.map((n) => {
      const paras = (n.text || '').split(/\n{2,}/).filter(Boolean);
      const text = el('div', { class: `news-text${paras.length > 2 ? ' collapsed' : ''}` }, paras.map((p) => el('p', {}, p)));
      const actions = el('div', { class: 'news-actions' });
      if (paras.length > 2) {
        actions.append(
          el('button', { class: 'link', onclick: (e) => { const c = text.classList.toggle('collapsed'); e.target.textContent = c ? 'Читать дальше' : 'Свернуть'; } }, 'Читать дальше')
        );
      }
      if (n.url) actions.append(el('button', { class: 'link', onclick: () => bba.openExternal(n.url).catch(showError) }, 'Открыть на сайте'));
      const img = n.image ? el('img', { class: 'news-img', src: n.image, alt: '', loading: 'lazy' }) : null;
      if (img) img.addEventListener('error', () => img.remove());
      return el(
        'article',
        { class: `news-item${img ? '' : ' no-image'}${newsUnread(n) ? ' unread' : ''}` },
        el(
          'div',
          {},
          el('div', { class: 'news-meta' }, n.tag ? el('span', { class: 'badge' }, n.tag) : null, el('span', { class: 'muted' }, fmtDate(n.date))),
          el('h3', {}, n.title),
          text,
          actions.childNodes.length ? actions : null
        ),
        img
      );
    })
  );
}

async function refreshNews() {
  try {
    const r = await bba.news.list();
    state.news = r.items || [];
    $('#newsStatus').textContent = r.offline && state.news.length ? 'Нет связи с сайтом — показаны сохранённые новости.' : '';
  } catch {
    /* оставляем, что было */
  }
  state.newsLoaded = true;
  if (!state.settings.lastNewsSeen && state.news.length) await markNewsSeen();
  renderNews();
}

async function markNewsSeen() {
  const newest = state.news.reduce((m, n) => ((n.date || '') > m ? n.date : m), '');
  if (!newest || newest === state.settings.lastNewsSeen) return;
  // подсветка «новое» на открытой вкладке остаётся до следующего обновления ленты
  state.settings = await bba.settings.set({ lastNewsSeen: newest });
  $('#newsDot').hidden = true;
}

// ---------- Настройки ----------
function renderSettings() {
  const s = state.settings;
  const info = state.info;
  const rec = (state.pack && state.pack.recommendedMemory) || 4096;
  const range = $('#memRange');
  range.max = Math.max(2048, Math.min(32768, info.totalMemoryMb - 1024));
  range.value = s.memoryMb || rec;
  $('#memValue').textContent = `${fmtMem(+range.value)}${s.memoryMb ? '' : ' (авто)'}`;
  $('#memHint').textContent = `Всего в системе ${fmtMem(Math.round(info.totalMemoryMb / 256) * 256)}. Рекомендуется ${fmtMem(rec)}.`;
  $('#javaPath').value = s.javaPath || '';
  $('#width').value = s.width;
  $('#height').value = s.height;
  $('#fullscreen').checked = !!s.fullscreen;
  $('#autoConnect').checked = !!s.autoConnect;
  $('#afterLaunch').value = s.afterLaunch;
  $('#jvmArgs').value = s.jvmArgs || '';
  $('#rootPath').textContent = info.root;
  $('#aboutLine').textContent = `${info.serverName} Launcher v${info.version}`;
}

async function saveSetting(patch) {
  state.settings = await bba.settings.set(patch);
  renderSettings();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme === 'light' ? 'light' : 'dark';
}

// ---------- Действия ----------
async function selectAccount(key) {
  state.accounts = await bba.accounts.select(key);
  closeAccountMenu();
  renderAccounts();
}
async function removeAccount(a) {
  if (!confirm(`Выйти из аккаунта ${a.name}?`)) return;
  state.accounts = await bba.accounts.remove(a.key);
  if (!state.accounts.length) closeAccountMenu();
  renderAccounts();
  renderPlay();
}

async function play(opts = {}) {
  if (state.busy) {
    await bba.game.cancel();
    return;
  }
  if (!state.accounts.length) return openLogin();
  state.busy = true;
  renderPlay();
  setProgress('Подготовка…', null, '', true);
  try {
    await bba.game.play(opts);
  } catch (e) {
    state.busy = false;
    if (e.code === 'ABORTED' || /Отменено/.test(e.message)) setProgress('Загрузка отменена');
    else {
      setProgress('Не удалось запустить игру');
      showError(e, { actions: [{ label: 'Открыть логи', run: () => bba.openFolder('logs') }] });
      if (e.code === 'no_account' || e.code === 'invalid_grant') openLogin();
    }
    renderPlay();
    return;
  }
  state.busy = false;
  renderPlay();
}

async function refreshPack() {
  try {
    state.pack = await bba.pack.info();
  } catch {
    state.pack = null;
  }
  renderHome();
  renderPack();
  renderPlay();
  if (!state.busy && !state.running) idleProgress();
}

async function refreshStatus() {
  try {
    state.server = await bba.server.status();
  } catch {
    state.server = { online: false };
  }
  renderStatus();
}

// ---------- События ----------
function bind() {
  $$('[data-page]').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
  $$('[data-folder]').forEach((b) => b.addEventListener('click', () => bba.openFolder(b.dataset.folder).catch(showError)));
  $('#minBtn').addEventListener('click', () => bba.win.minimize());
  $('#closeBtn').addEventListener('click', () => bba.win.close());
  $('#themeBtn').addEventListener('click', async () => {
    await saveSetting({ theme: state.settings.theme === 'light' ? 'dark' : 'light' });
    applyTheme();
  });
  $('#playBtn').addEventListener('click', () => play());
  $('#repairBtn').addEventListener('click', () => play({ repair: true }));
  $('#accountChip').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAccountMenu();
  });
  document.addEventListener('click', (e) => {
    if (!$('#accountMenu').hidden && !e.target.closest('.account-box')) closeAccountMenu();
  });
  $('#yggForm').addEventListener('submit', loginYggdrasil);
  $('#msLogin').addEventListener('click', loginMicrosoft);
  $('#loginClose').addEventListener('click', closeLogin);
  $('#loginModal').addEventListener('mousedown', (e) => e.target.id === 'loginModal' && closeLogin());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeLogin();
    closeAccountMenu();
  });
  $('#yggRegister').addEventListener('click', () => bba.openExternal(state.info.auth.yggdrasil.registerUrl).catch(showError));
  $('#yggReset').addEventListener('click', () => bba.openExternal(state.info.auth.yggdrasil.resetUrl).catch(showError));
  $('#copyAddress').addEventListener('click', () => {
    navigator.clipboard.writeText($('#serverAddress').textContent);
    toast('Адрес скопирован', { ok: true, timeout: 2500 });
  });

  $('#memRange').addEventListener('input', (e) => ($('#memValue').textContent = fmtMem(+e.target.value)));
  $('#memRange').addEventListener('change', (e) => saveSetting({ memoryMb: +e.target.value }));
  $('#memAuto').addEventListener('click', () => saveSetting({ memoryMb: 0 }));
  $('#javaPick').addEventListener('click', async () => {
    const p = await bba.settings.pickJava();
    if (p) saveSetting({ javaPath: p });
  });
  $('#javaAuto').addEventListener('click', () => saveSetting({ javaPath: '' }));
  $('#width').addEventListener('change', (e) => saveSetting({ width: Math.max(640, +e.target.value || 1280) }));
  $('#height').addEventListener('change', (e) => saveSetting({ height: Math.max(480, +e.target.value || 720) }));
  $('#fullscreen').addEventListener('change', (e) => saveSetting({ fullscreen: e.target.checked }));
  $('#autoConnect').addEventListener('change', (e) => saveSetting({ autoConnect: e.target.checked }));
  $('#afterLaunch').addEventListener('change', (e) => saveSetting({ afterLaunch: e.target.value }));
  $('#jvmArgs').addEventListener('change', (e) => saveSetting({ jvmArgs: e.target.value.trim() }));

  bba.on('progress', ({ text, frac, detail }) => setProgress(text, frac, detail, true));
  bba.on('game-state', (g) => {
    state.running = !!g.running;
    if (g.running) {
      state.busy = false;
      setProgress(g.visible ? 'Игра запущена — удачи на сервере!' : 'Игра загружается…', g.visible ? 1 : null, '', !g.visible);
      if (g.removed && g.removed.length) toast(`Удалены лишние файлы: ${g.removed.length}`, { ok: true });
    } else {
      if (g.error) {
        setProgress('Игра завершилась с ошибкой');
        showError(new Error(g.error), { actions: [{ label: 'Открыть логи', run: () => bba.openFolder('logs') }] });
      }
      refreshPack();
    }
    renderPlay();
  });
}

async function init() {
  renderLogo();
  [state.info, state.settings, state.accounts] = await Promise.all([bba.info(), bba.settings.get(), bba.accounts.list()]);
  applyTheme();
  bind();
  renderAccounts();
  renderSettings();
  renderHome();
  renderNews();
  renderPlay();
  setProgress('Загружаем информацию о сборке…', null, '', true);
  state.running = await bba.game.running();
  await Promise.all([refreshPack(), refreshStatus(), refreshNews()]);
  renderSettings();
  setInterval(refreshStatus, 30000);
  setInterval(refreshNews, 10 * 60000);
  setInterval(() => !state.busy && !state.running && refreshPack(), 5 * 60000);
}

init().catch(showError);
