'use strict';
// Вход через Microsoft → Xbox Live → XSTS → Minecraft Services.
// Нужен собственный Client ID приложения Azure, одобренный Mojang (см. README).
const crypto = require('crypto');
const { BrowserWindow } = require('electron');

const AUTHORIZE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
const TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const REDIRECT = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const SCOPE = 'XboxLive.signin offline_access';

class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function checkClientId(clientId) {
  if (!clientId || !/^[0-9a-f-]{36}$/i.test(clientId)) {
    throw new AuthError(
      'В launcher.config.json не указан msClientId. Зарегистрируйте приложение в Azure и вставьте его Client ID (инструкция в README).',
      'no_client_id'
    );
  }
}

function interactiveLogin(clientId, parent) {
  return new Promise((resolve, reject) => {
    const state = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const url = `${AUTHORIZE}?${new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT,
      scope: SCOPE,
      prompt: 'select_account',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })}`;

    const win = new BrowserWindow({
      parent,
      modal: !!parent,
      width: 520,
      height: 700,
      title: 'Вход через Microsoft',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { partition: 'bba-msauth', contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.removeMenu();
    let done = false;

    const handle = (u) => {
      if (!u || !u.startsWith(REDIRECT)) return false;
      done = true;
      const q = new URL(u).searchParams;
      setImmediate(() => !win.isDestroyed() && win.close());
      if (q.get('error')) {
        const cancelled = q.get('error') === 'access_denied';
        reject(new AuthError(cancelled ? 'Вход отменён' : q.get('error_description') || q.get('error'), cancelled ? 'cancelled' : q.get('error')));
      } else if (q.get('state') !== state) reject(new AuthError('Ответ Microsoft не прошёл проверку (state)'));
      else resolve({ code: q.get('code'), verifier });
      return true;
    };
    const intercept = (e, u) => {
      if (handle((e && e.url) || u)) e.preventDefault();
    };
    win.webContents.on('will-redirect', intercept);
    win.webContents.on('will-navigate', intercept);
    win.webContents.on('did-navigate', (e, u) => handle(u));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      if (!done) reject(new AuthError('Вход отменён', 'cancelled'));
    });
    // начинаем с чистой сессии, чтобы можно было выбрать другой аккаунт
    win.webContents.session.clearStorageData().finally(() => win.loadURL(url));
  });
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new AuthError('Сессия Microsoft истекла — войдите снова', 'invalid_grant');
    throw new AuthError(`Microsoft: ${data.error_description || data.error || res.status}`, data.error);
  }
  return data;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const e = new AuthError(`HTTP ${res.status}`, 'http');
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

const XERR = {
  2148916227: 'Этот аккаунт заблокирован в Xbox.',
  2148916233: 'У аккаунта Microsoft нет профиля Xbox. Зайдите один раз на minecraft.net или xbox.com и создайте профиль.',
  2148916235: 'Xbox Live недоступен в стране, указанной в аккаунте Microsoft.',
  2148916236: 'Аккаунт требует подтверждения возраста (Южная Корея).',
  2148916237: 'Аккаунт требует подтверждения возраста (Южная Корея).',
  2148916238: 'Это детский аккаунт — его нужно добавить в семью Microsoft взрослым.',
};

async function minecraftFromMsToken(msAccessToken, clientId) {
  // 1. Xbox Live
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  }).catch((e) => {
    throw new AuthError(`Не удалось войти в Xbox Live (${e.status || e.message})`);
  });
  const uhs = xbl.DisplayClaims.xui[0].uhs;

  // 2. XSTS
  let xsts;
  try {
    xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    });
  } catch (e) {
    const xerr = e.data && e.data.XErr;
    throw new AuthError(XERR[xerr] || `Ошибка Xbox (XSTS ${xerr || e.status})`, 'xsts');
  }

  // 3. Minecraft
  let mc;
  try {
    mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
      identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
    });
  } catch (e) {
    if (e.status === 403) {
      throw new AuthError(
        `Mojang отклонил вход: Client ID ${clientId} ещё не одобрен для Minecraft API. Подайте заявку: https://aka.ms/mce-reviewappid`,
        'app_not_approved'
      );
    }
    throw new AuthError(`Minecraft Services: ошибка ${e.status || e.message}`);
  }

  // 4. Профиль
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.access_token}` },
  });
  if (res.status === 404) throw new AuthError('На этом аккаунте не куплен Minecraft: Java Edition.', 'no_game');
  if (!res.ok) throw new AuthError(`Не удалось получить профиль Minecraft (${res.status})`);
  const profile = await res.json();

  let skin = null;
  const active = (profile.skins || []).find((s) => s.state === 'ACTIVE') || (profile.skins || [])[0];
  if (active && active.url) {
    try {
      const r = await fetch(active.url.replace(/^http:/, 'https:'));
      if (r.ok) skin = `data:image/png;base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
    } catch {
      /* без скина — не страшно */
    }
  }

  return {
    id: profile.id,
    name: profile.name,
    accessToken: mc.access_token,
    expiresAt: Date.now() + (mc.expires_in || 86400) * 1000,
    skin,
  };
}

/** Полный интерактивный вход. Возвращает объект аккаунта для хранения. */
async function login(clientId, parent) {
  checkClientId(clientId);
  const { code, verifier } = await interactiveLogin(clientId, parent);
  const ms = await postForm(TOKEN, {
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    scope: SCOPE,
    code_verifier: verifier,
  });
  const mc = await minecraftFromMsToken(ms.access_token, clientId);
  return { ...mc, msRefreshToken: ms.refresh_token, addedAt: Date.now() };
}

/** Обновляет токены, если до истечения меньше 10 минут. */
async function refresh(account, clientId, { force = false } = {}) {
  if (!force && account.accessToken && account.expiresAt - Date.now() > 10 * 60 * 1000) return account;
  checkClientId(clientId);
  if (!account.msRefreshToken) throw new AuthError('Сессия истекла — войдите снова', 'invalid_grant');
  const ms = await postForm(TOKEN, {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: account.msRefreshToken,
    scope: SCOPE,
  });
  const mc = await minecraftFromMsToken(ms.access_token, clientId);
  return { ...account, ...mc, skin: mc.skin || account.skin, msRefreshToken: ms.refresh_token || account.msRefreshToken };
}

module.exports = { login, refresh, AuthError };
