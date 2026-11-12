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
  contentKind: 'pack',
  content: {},
  update: null,
  servers: [],
  pings: {},
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
function setMaxIcon(maximized) {
  const btn = $('#maxBtn');
  btn.title = maximized ? 'Вернуть размер' : 'Развернуть';
  btn.setAttribute('aria-label', btn.title);
  $('#maxIcon').innerHTML = maximized
    ? '<rect x="3.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="3.5" width="7" height="7" fill="var(--header)" stroke="currentColor" stroke-width="1.3"/>'
    : '<rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4"/>';
}

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
  renderServers();
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
  renderContent();
}

const KIND_WORDS = {
  mods: { many: 'моды', add: 'клиентские моды (.jar)', none: 'Своих модов пока нет' },
  shaderpacks: { many: 'шейдеры', add: 'шейдеры (.zip)', none: 'Шейдеров пока нет' },
  resourcepacks: { many: 'ресурспаки', add: 'ресурспаки и текстуры (.zip)', none: 'Ресурспаков пока нет' },
};

async function refreshContent(kinds = ['mods', 'shaderpacks', 'resourcepacks']) {
  await Promise.all(
    kinds.map(async (k) => {
      try {
        state.content[k] = await bba.content.list(k);
      } catch {
        /* сборка ещё не загружена */
      }
    })
  );
  renderContent();
}

function renderContent() {
  const kind = state.contentKind;
  const p = state.pack;
  $$('#contentTabs .segment').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  $('#countPack').textContent = p && p.mods.length ? p.mods.length : '';
  for (const k of ['mods', 'shaderpacks', 'resourcepacks']) {
    const c = state.content[k];
    $(`#count${k[0].toUpperCase()}${k.slice(1)}`).textContent = c && c.user.length ? c.user.length : '';
  }
  const list = $('#modList');
  const note = $('#contentNote');
  note.hidden = true;
  $('#contentAdd').hidden = kind === 'pack';

  if (kind === 'pack') {
    list.classList.remove('single');
    if (!p) return list.replaceChildren(el('div', { class: 'empty' }, 'Не удалось получить сборку. Проверьте интернет.'));
    const mods = [...p.mods].sort((a, b) => (a.name || a.file).localeCompare(b.name || b.file));
    note.hidden = false;
    note.textContent = 'Эти моды нужны для игры на сервере. Лаунчер сам ставит и обновляет их, а если удалить или подменить файл вручную — вернёт при следующем запуске.';
    return list.replaceChildren(
      ...(mods.length
        ? mods.map((m) => el('div', { class: 'mod', title: m.file }, el('span', { class: 'name' }, el('span', { class: 'lock', title: 'Мод сборки' }, '🔒'), m.name || prettyMod(m.file)), el('span', { class: 'size' }, m.size ? fmtSize(m.size) : '')))
        : [el('div', { class: 'empty' }, 'В сборке пока нет модов.')])
    );
  }

  list.classList.add('single');
  const c = state.content[kind];
  const words = KIND_WORDS[kind];
  if (!c) return list.replaceChildren(el('div', { class: 'empty' }, 'Загружаем…'));
  if (!c.allowed) {
    $('#contentAdd').hidden = true;
    note.hidden = false;
    note.textContent = `Админ сервера запретил добавлять свои ${words.many}.`;
  } else if (c.hint) {
    note.hidden = false;
    note.textContent = c.hint;
  } else if (kind === 'mods') {
    note.hidden = false;
    note.textContent = 'Только клиентские моды (миникарта, интерфейс, оптимизация). Если мод дублирует мод сборки или сделан под другой загрузчик, лаунчер его не добавит или выключит перед запуском.';
  }

  const items = [];
  // файлы из сборки в этой папке (например, шейдер от админа) — тоже защищены
  for (const it of c.pack) {
    items.push(
      el('div', { class: 'user-item' },
        el('span', { class: 'lock', title: 'Файл сборки' }, '🔒'),
        el('div', { class: 'meta' }, el('b', {}, it.name), el('span', {}, 'из сборки — убрать нельзя')),
        el('span', { class: 'size' }, it.size ? fmtSize(it.size) : '')
      )
    );
  }
  for (const it of c.user) {
    const sw = el('label', { class: 'switch', title: it.enabled ? 'Выключить' : 'Включить' }, el('input', { type: 'checkbox' }), el('span'));
    sw.querySelector('input').checked = it.enabled;
    sw.querySelector('input').addEventListener('change', (e) => toggleContent(kind, it, e.target.checked));
    const sub = [it.version ? `v${it.version}` : null, it.file].filter(Boolean).join(' · ');
    items.push(
      el('div', { class: `user-item${it.enabled ? '' : ' off'}` },
        sw,
        el('div', { class: 'meta' }, el('b', { title: it.file }, it.name), it.problem ? el('span', { class: 'problem' }, it.problem) : el('span', {}, sub)),
        el('span', { class: 'size' }, it.size ? fmtSize(it.size) : ''),
        el('button', { class: 'del', title: 'Удалить в корзину', onclick: () => removeContent(kind, it) }, 'Удалить')
      )
    );
  }
  if (c.allowed) {
    items.push(
      el('div', { class: 'dropzone', onclick: () => addContent(kind) },
        el('b', {}, c.user.length ? 'Добавить ещё' : words.none),
        `Перетащите сюда ${words.add} или нажмите, чтобы выбрать файлы`
      )
    );
  }
  list.replaceChildren(...items);
}

async function addContent(kind, paths) {
  try {
    const r = await bba.content.add(kind, paths);
    const label = { mods: 'Мои моды', shaderpacks: 'Шейдеры', resourcepacks: 'Ресурспаки' };
    if (r.added.length) {
      const where = [...new Set(r.added.map((a) => label[a.kind]))].join(', ');
      toast(`Добавлено: ${r.added.length} → ${where}`, { ok: true, timeout: 3500 });
      // если файл оказался другого типа — переключаемся на его раздел
      if (r.added.every((a) => a.kind !== kind)) state.contentKind = r.added[0].kind;
    }
    for (const x of r.rejected) toast(`${x.file}: ${x.reason}`, { timeout: 9000 });
    await refreshContent();
  } catch (e) {
    showError(e);
  }
}

async function toggleContent(kind, it, enabled) {
  try {
    await bba.content.toggle(kind, it.file, enabled);
  } catch (e) {
    showError(e);
  }
  refreshContent([kind]);
}

async function removeContent(kind, it) {
  if (!confirm(`Удалить «${it.name}»? Файл попадёт в корзину.`)) return;
  try {
    await bba.content.remove(kind, it.file);
  } catch (e) {
    showError(e);
  }
  refreshContent([kind]);
}

function bindDrop() {
  const page = $('#page-pack');
  const overlay = $('#dropOverlay');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer && e.dataTransfer.types) || []].includes('Files');
  page.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  page.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  page.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  page.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    let paths = [];
    try {
      paths = [...e.dataTransfer.files].map((f) => bba.content.pathFor(f)).filter(Boolean);
    } catch (err) {
      showError(new Error(`Не удалось прочитать перетащенные файлы: ${err.message}`));
      return;
    }
    if (!paths.length) {
      toast('Перетащите файлы .jar или .zip из папки на компьютере (не из браузера и не из открытого архива)', { timeout: 6000 });
      return;
    }
    addContent(state.contentKind === 'pack' ? 'mods' : state.contentKind, paths);
  });
  // файлы, брошенные мимо вкладки, не должны открываться в окне
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

// ---------- Обновление лаунчера ----------
function renderUpdate() {
  const u = state.update;
  const pill = $('#updatePill');
  const text = $('#updateText');
  const install = $('#updateInstall');
  const check = $('#updateCheck');
  pill.hidden = true;
  pill.className = 'update-pill';
  install.hidden = true;
  check.disabled = false;
  const ver = `v${(state.info && state.info.version) || ''}`;
  if (!u) return (text.textContent = ver);
  switch (u.status) {
    case 'checking':
      text.textContent = `${ver} · проверяем обновления…`;
      check.disabled = true;
      break;
    case 'latest':
      text.textContent = `${ver} · установлена последняя версия`;
      break;
    case 'downloading':
      text.textContent = `${ver} · загружаем v${u.version}: ${u.percent || 0}%`;
      pill.hidden = false;
      pill.textContent = `Обновление ${u.percent || 0}%`;
      check.disabled = true;
      break;
    case 'ready':
      text.textContent = `${ver} · v${u.version} скачана и будет установлена при перезапуске`;
      pill.hidden = false;
      pill.classList.add('ready');
      pill.textContent = `Обновить до v${u.version}`;
      install.hidden = false;
      check.hidden = true;
      break;
    case 'available':
      text.textContent = `${ver} · доступна v${u.version}${u.mode === 'portable' ? ' (portable-версию нужно скачать заново)' : ''}`;
      pill.hidden = false;
      pill.classList.add('available');
      pill.textContent = `Новая версия v${u.version}`;
      break;
    case 'error':
      text.textContent = `${ver} · не удалось проверить обновления: ${u.error}`;
      break;
    default:
      text.textContent = u.mode === 'dev' ? `${ver} · режим разработки` : ver;
  }
}

function onUpdateState(u) {
  const prev = state.update;
  state.update = u;
  renderUpdate();
  if (u.status === 'ready' && (!prev || prev.status !== 'ready')) {
    toast(`Обновление лаунчера v${u.version} готово`, { ok: true, timeout: 0, actions: [{ label: 'Перезапустить', run: installUpdate }, { label: 'Позже', run: () => {} }] });
  }
}

async function installUpdate() {
  try {
    await bba.update.install();
  } catch (e) {
    showError(e);
  }
}

function updatePillClick() {
  const u = state.update;
  if (!u) return;
  if (u.status === 'ready') installUpdate();
  else if (u.status === 'available' && u.url) bba.openExternal(u.url).catch(showError);
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
  else if (p.offline) setProgress('Сайт сборки не отвечает — используется сохранённая сборка', null, p.version);
  else if (p.mirror && !p.installed) setProgress(`Сборка ${p.version} будет загружена с зеркала GitHub`, null, fmtSize(p.totalSize));
  else if (p.mirror && !p.upToDate) setProgress(`Обновление сборки ${p.version} — с зеркала GitHub`, null, `сейчас ${p.installed}`);
  else if (p.mirror) setProgress('Готово к запуску · сборка с зеркала GitHub', 1, `сборка ${p.version}`);
  else if (!p.installed) setProgress(`Сборка ${p.version} ещё не установлена`, null, fmtSize(p.totalSize));
  else if (!p.upToDate) setProgress(`Доступно обновление сборки: ${p.version}`, null, `сейчас ${p.installed}`);
  else setProgress('Готово к запуску', 1, `сборка ${p.version}`);
}

// ---------- Адреса сервера ----------
const addrText = (x) => (x.port && x.port !== 25565 ? `${x.host}:${x.port}` : x.host);

function renderServers() {
  const box = $('#serverList');
  if (!state.servers.length) return box.replaceChildren(el('div', { class: 'empty' }, '—'));
  box.replaceChildren(
    ...state.servers.map((x) => {
      const p = state.pings[x.id];
      const ping = !p ? el('span', { class: 'ping' }, '…') : p.online ? el('span', { class: 'ping ok' }, `${p.latency} мс`) : el('span', { class: 'ping off' }, 'нет связи');
      const copy = el('button', { class: 'btn ghost small', title: 'Скопировать адрес' }, 'Скопировать');
      copy.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(addrText(x)).then(() => toast(`Скопировано: ${addrText(x)}`, { ok: true, timeout: 2500 }), () => {});
      });
      const row = el(
        'div',
        { class: `server-row${x.selected ? ' selected' : ''}`, role: 'radio', 'aria-checked': String(!!x.selected), tabindex: '0', title: 'Подключаться к этому адресу' },
        el('span', { class: 'radio' }),
        el('div', { class: 'meta' }, el('code', {}, addrText(x)), el('span', {}, [x.name, x.description].filter(Boolean).join(' — '))),
        ping,
        copy
      );
      const choose = () => selectServer(x.id);
      row.addEventListener('click', choose);
      row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), choose()));
      return row;
    })
  );
}

async function refreshServers() {
  try {
    state.servers = await bba.server.list();
  } catch {
    /* оставляем прошлый список */
  }
  renderServers();
}

async function pingServers() {
  try {
    for (const r of await bba.server.pingAll()) state.pings[r.id] = r;
  } catch {
    /* нет сети */
  }
  renderServers();
}

async function selectServer(id) {
  const cur = state.servers.find((x) => x.selected);
  if (cur && cur.id === id) return;
  try {
    state.servers = await bba.server.select(id);
    const x = state.servers.find((s) => s.id === id);
    toast(`Лаунчер будет подключаться к ${addrText(x)}`, { ok: true, timeout: 3000 });
  } catch (e) {
    showError(e);
  }
  renderServers();
  refreshStatus();
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
  if ((!state.pack || state.pack.offline) && !state.offlineHintShown) {
    state.offlineHintShown = true;
    toast('Сайт bba.dimon20k.ru не отвечает, поэтому сборка не обновляется и вход может не работать. Если включён VPN — добавьте dimon20k.ru в исключения VPN или выключите его.', { timeout: 15000 });
  } else if (state.pack && !state.pack.offline) state.offlineHintShown = false;
  refreshContent();
  refreshServers().then(pingServers);
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
  $('#maxBtn').addEventListener('click', () => bba.win.maximize().then(setMaxIcon));
  // двойной щелчок по шапке — развернуть/вернуть, как у обычных окон
  $('.topbar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('button, a')) bba.win.maximize().then(setMaxIcon);
  });
  bba.on('win-state', (w) => setMaxIcon(w.maximized));
  bba.win.isMaximized().then(setMaxIcon).catch(() => {});
  $('#closeBtn').addEventListener('click', () => bba.win.close());
  $('#themeBtn').addEventListener('click', async () => {
    await saveSetting({ theme: state.settings.theme === 'light' ? 'dark' : 'light' });
    applyTheme();
  });
  $('#playBtn').addEventListener('click', () => play());
  $('#repairBtn').addEventListener('click', () => play({ repair: true }));
  $$('#contentTabs .segment').forEach((b) =>
    b.addEventListener('click', () => {
      state.contentKind = b.dataset.kind;
      renderContent();
      if (b.dataset.kind !== 'pack') refreshContent([b.dataset.kind]);
    })
  );
  $('#contentAdd').addEventListener('click', () => addContent(state.contentKind));
  $('#contentFolder').addEventListener('click', () =>
    (state.contentKind === 'pack' ? bba.openFolder('mods') : bba.content.folder(state.contentKind)).catch(showError)
  );
  bindDrop();
  $('#updatePill').addEventListener('click', updatePillClick);
  $('#updateCheck').addEventListener('click', () => bba.update.check().then(onUpdateState).catch(showError));
  $('#updateInstall').addEventListener('click', installUpdate);
  bba.on('update-state', onUpdateState);
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
      if (g.removed && g.removed.length) toast(`Убраны моды, которых больше нет в сборке: ${g.removed.length}`, { ok: true });
      if (g.disabled && g.disabled.length) toast(`Выключены свои моды, мешающие сборке:\n${g.disabled.map((d) => `• ${d.name} — ${d.reason}`).join('\n')}`, { timeout: 15000 });
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
  bba.update.state().then(onUpdateState).catch(() => {});
  await Promise.all([refreshPack(), refreshStatus(), refreshNews()]);
  renderSettings();
  setInterval(refreshStatus, 30000);
  setInterval(pingServers, 60000);
  setInterval(refreshNews, 10 * 60000);
  setInterval(() => !state.busy && !state.running && refreshPack(), 5 * 60000);
}

init().catch(showError);
