'use strict';
// Вход через свой сервер авторизации (Drasl, Blessing Skin и др.) по протоколу Yggdrasil / authlib-injector.
// Спецификация: https://github.com/yushijinhun/authlib-injector/wiki
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const dl = require('./download');
const { AuthError } = require('./auth');

const TIMEOUT = 10000;

// ---------- HTTP ----------
async function request(url, { method = 'GET', body, timeout = TIMEOUT } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'User-Agent': dl.UA, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new AuthError(`Сервер авторизации недоступен (${new URL(url).host})`, 'network');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data, text, headers: res.headers, url: res.url };
}

function yggError(r, fallback) {
  const d = r.data || {};
  if (r.status === 403 || d.error === 'ForbiddenOperationException') {
    if (/credential|password|пароль/i.test(d.errorMessage || '')) return new AuthError('Неверный ник или пароль', 'bad_credentials');
    if (/token/i.test(d.errorMessage || '')) return new AuthError('Сессия истекла — войдите снова', 'invalid_grant');
    return new AuthError(d.errorMessage ? `Отказано: ${d.errorMessage}` : 'Неверный ник или пароль', 'bad_credentials');
  }
  if (r.status === 429) return new AuthError('Слишком много попыток входа. Подождите минуту.', 'rate_limit');
  return new AuthError(`${fallback} (${d.errorMessage || `HTTP ${r.status}`})`, 'http');
}

// ---------- Адрес API ----------
/**
 * Находит корень API authlib-injector и загружает его метаданные.
 * Понимает и прямой адрес (https://auth.example.ru/authlib-injector),
 * и адрес сайта с заголовком X-Authlib-Injector-API-Location.
 */
async function resolveApi(url) {
  let u = String(url || '').trim();
  if (!u) throw new AuthError('Сервер авторизации ещё не настроен (auth.yggdrasil.url в launcher.config.json)', 'not_configured');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '');
  for (let hop = 0; hop < 3; hop++) {
    const r = await request(u);
    const loc = r.headers.get('x-authlib-injector-api-location');
    if (loc) {
      const next = new URL(loc, r.url || u).href.replace(/\/+$/, '');
      if (next !== u) {
        u = next;
        continue;
      }
    }
    if (r.ok && r.data && (r.data.meta || r.data.skinDomains || r.data.signaturePublickey)) {
      return { root: u, metadata: r.text, meta: r.data.meta || {} };
    }
    throw new AuthError(`По адресу ${u} нет API authlib-injector. Для Drasl адрес обычно оканчивается на /authlib-injector`, 'bad_api');
  }
  throw new AuthError('Слишком много перенаправлений API', 'bad_api');
}

// ---------- Скин ----------
async function fetchSkin(root, uuid) {
  try {
    const r = await request(`${root}/sessionserver/session/minecraft/profile/${uuid}?unsigned=true`, { timeout: 6000 });
    const prop = r.data && (r.data.properties || []).find((p) => p.name === 'textures');
    if (!prop) return null;
    const tex = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
    const skinUrl = tex.textures && tex.textures.SKIN && tex.textures.SKIN.url;
    if (!skinUrl) return null;
    const img = await fetch(skinUrl, { signal: AbortSignal.timeout(6000) });
    if (!img.ok) return null;
    return `data:image/png;base64,${Buffer.from(await img.arrayBuffer()).toString('base64')}`;
  } catch {
    return null;
  }
}

// ---------- Вход / обновление / выход ----------
async function login(cfg, username, password) {
  if (!username || !password) throw new AuthError('Введите ник и пароль', 'bad_credentials');
  const api = await resolveApi(cfg.url);
  const clientToken = crypto.randomUUID().replace(/-/g, '');
  const r = await request(`${api.root}/authserver/authenticate`, {
    method: 'POST',
    body: { agent: { name: 'Minecraft', version: 1 }, username: username.trim(), password, clientToken, requestUser: true },
  });
  if (!r.ok) throw yggError(r, 'Не удалось войти');
  let { accessToken, selectedProfile } = r.data;
  const profiles = r.data.availableProfiles || [];
  if (!selectedProfile) {
    if (!profiles.length) throw new AuthError('У этого аккаунта нет ни одного игрового профиля. Создайте его на сайте.', 'no_profile');
    // несколько профилей — берём совпадающий с введённым ником или первый
    const pick = profiles.find((p) => p.name.toLowerCase() === username.trim().toLowerCase()) || profiles[0];
    const rr = await request(`${api.root}/authserver/refresh`, {
      method: 'POST',
      body: { accessToken, clientToken, selectedProfile: pick, requestUser: true },
    });
    if (!rr.ok) throw yggError(rr, 'Не удалось выбрать профиль');
    accessToken = rr.data.accessToken;
    selectedProfile = rr.data.selectedProfile || pick;
  }
  return {
    type: 'ygg',
    id: selectedProfile.id,
    name: selectedProfile.name,
    accessToken,
    clientToken: r.data.clientToken || clientToken,
    apiRoot: api.root,
    apiMetadata: api.metadata,
    serverName: api.meta.serverName || null,
    skin: await fetchSkin(api.root, selectedProfile.id),
    addedAt: Date.now(),
  };
}

/** Проверяет токен и обновляет его при необходимости. Пароль не хранится. */
async function refresh(account) {
  const root = account.apiRoot;
  const v = await request(`${root}/authserver/validate`, {
    method: 'POST',
    body: { accessToken: account.accessToken, clientToken: account.clientToken },
  });
  let next = account;
  if (v.status !== 204 && !v.ok) {
    const r = await request(`${root}/authserver/refresh`, {
      method: 'POST',
      body: { accessToken: account.accessToken, clientToken: account.clientToken, requestUser: true },
    });
    if (!r.ok) {
      const e = yggError(r, 'Не удалось обновить вход');
      if (e.code === 'bad_credentials') {
        e.message = 'Сессия истекла — войдите снова';
        e.code = 'invalid_grant';
      }
      throw e;
    }
    next = {
      ...account,
      accessToken: r.data.accessToken,
      clientToken: r.data.clientToken || account.clientToken,
      ...(r.data.selectedProfile ? { id: r.data.selectedProfile.id, name: r.data.selectedProfile.name } : {}),
    };
  }
  // свежие метаданные (ключ подписи, домены скинов) и скин — без них тоже можно играть
  try {
    const api = await resolveApi(root);
    next = { ...next, apiMetadata: api.metadata };
  } catch {
    /* оставляем сохранённые */
  }
  const skin = await fetchSkin(root, next.id);
  return skin ? { ...next, skin } : next;
}

async function logout(account) {
  try {
    await request(`${account.apiRoot}/authserver/invalidate`, {
      method: 'POST',
      body: { accessToken: account.accessToken, clientToken: account.clientToken },
      timeout: 4000,
    });
  } catch {
    /* выходим локально в любом случае */
  }
}

// ---------- authlib-injector ----------
const INJECTOR_SOURCES = [
  'https://authlib-injector.yushi.moe/artifact/latest.json',
  'https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json',
];

/** Скачивает authlib-injector (javaagent, который перенаправляет вход игры на наш сервер). */
async function ensureInjector(root, { signal, customUrl } = {}) {
  const dir = path.join(root, 'authlib-injector');
  await fsp.mkdir(dir, { recursive: true });
  const sources = customUrl ? [customUrl, ...INJECTOR_SOURCES] : INJECTOR_SOURCES;
  for (const src of sources) {
    try {
      const info = await dl.fetchJson(src, { signal, timeoutMs: 8000 });
      const jar = path.join(dir, `authlib-injector-${info.version}.jar`);
      const sha256 = info.checksums && info.checksums.sha256;
      if (!(await exists(jar)) || (sha256 && (await sha256File(jar)) !== sha256)) {
        await dl.downloadFile({ url: info.download_url, dest: jar, sha256 }, { signal });
      }
      return jar;
    } catch (e) {
      if (e.code === 'ABORTED') throw e;
    }
  }
  // офлайн — берём любую ранее скачанную версию
  const cached = (await fsp.readdir(dir)).filter((f) => /^authlib-injector-.*\.jar$/.test(f)).sort();
  if (cached.length) return path.join(dir, cached[cached.length - 1]);
  throw new Error('Не удалось скачать authlib-injector — проверьте интернет');
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')));
  });
}

module.exports = { login, refresh, logout, resolveApi, ensureInjector };
