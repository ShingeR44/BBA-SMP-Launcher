'use strict';
// Автообновление лаунчера по релизам GitHub — только через API (api.github.com).
// Веб-адреса github.com/.../releases/... бывают недоступны (504), а API и файлы релизов
// через него отдаются стабильно.
// - Установленная версия: качаем новый установщик в фоне, сверяем sha512 из latest.yml,
//   ставим тихо при перезапуске (или сами при выходе из лаунчера).
// - Portable и режим разработки: только сообщаем о новой версии и даём ссылку.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dl = require('./download');

const CHECK_EVERY = 2 * 60 * 60 * 1000; // плановая проверка раз в 2 часа
const RETRY_AFTER = 10 * 60 * 1000; // после ошибки — повтор через 10 минут
const API = 'https://api.github.com';

function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/);
  const pb = String(b).replace(/^v/, '').split(/[.-]/);
  for (let i = 0; i < 3; i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d;
  }
  return 0;
}

async function apiJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': dl.UA, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const e = new Error(`GitHub API: HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/** Текст файла релиза (latest.yml) через API: /releases/assets/{id} с Accept: octet-stream */
async function assetText(asset) {
  const res = await fetch(asset.url, {
    headers: { 'User-Agent': dl.UA, Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Не удалось скачать ${asset.name} (HTTP ${res.status})`);
  return res.text();
}

/** Из latest.yml: имя установщика, sha512 (base64) и размер */
function parseLatestYml(text) {
  const file = (/^path:\s*(.+?)\s*$/m.exec(text) || [])[1];
  const sha512 = (/^sha512:\s*(\S+)\s*$/m.exec(text) || [])[1];
  const size = Number((/^\s+size:\s*(\d+)\s*$/m.exec(text) || [])[1]) || null;
  return { file, sha512, size };
}

class Updater {
  constructor({ repo, allowPrerelease = false, send, canInstall }) {
    this.repo = repo; // "owner/name"
    this.allowPrerelease = allowPrerelease;
    this.send = send;
    this.canInstall = canInstall || (() => true);
    this.portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
    this.mode = process.env.BBA_UPDATER_MODE || (!app.isPackaged ? 'dev' : this.portable ? 'portable' : 'installer');
    this.current = process.env.BBA_FAKE_VERSION || app.getVersion(); // переменные — только для проверки
    this.state = { status: 'idle', current: this.current, mode: this.mode };
    this.file = null;
    this.installing = false;
    this.retryTimer = null;
    this.dir = path.join(app.getPath('temp'), 'bba-launcher-update');
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.send('update-state', this.state);
  }

  start() {
    if (!this.repo) return;
    setTimeout(() => this.check().catch(() => {}), 8000);
    setInterval(() => this.check().catch(() => {}), CHECK_EVERY);
    // скачанное обновление ставится и просто при выходе из лаунчера
    app.on('will-quit', () => {
      if (this.state.status === 'ready' && this.file && !this.installing && this.canInstall()) this.#spawnInstaller(false);
    });
  }

  async #latestRelease() {
    if (this.allowPrerelease) {
      const list = await apiJson(`${API}/repos/${this.repo}/releases?per_page=10`);
      return list.find((r) => !r.draft) || null;
    }
    try {
      return await apiJson(`${API}/repos/${this.repo}/releases/latest`);
    } catch (e) {
      if (e.status === 404) return null; // релизов ещё нет
      throw e;
    }
  }

  async check() {
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    clearTimeout(this.retryTimer);
    this.set({ status: 'checking', error: null });
    try {
      // основной путь — API GitHub; если он отказал (лимит запросов, 5xx, нет связи) — прямые ссылки github.com
      let info;
      try {
        info = await this.#fromApi();
      } catch (apiErr) {
        if (this.allowPrerelease) throw apiErr; // для pre-release прямой ссылки «latest» нет
        try {
          info = await this.#fromWeb();
        } catch {
          throw apiErr;
        }
      }
      if (!info || cmpVersions(info.version, this.current) <= 0) {
        this.set({ status: 'latest', checkedAt: Date.now() });
        return this.state;
      }
      if (this.mode !== 'installer') {
        this.set({ status: 'available', version: info.version, url: (this.portable ? info.portableUrl : info.setupUrl) || info.page, page: info.page });
        return this.state;
      }
      await this.#fetchInstaller(info);
    } catch (e) {
      this.set({ status: 'error', error: friendly(e) });
      this.retryTimer = setTimeout(() => this.check().catch(() => {}), RETRY_AFTER);
    }
    return this.state;
  }

  /** Через API: версия, ссылки и (для установленной версии) данные установщика из latest.yml. */
  async #fromApi() {
    const rel = await this.#latestRelease();
    if (!rel) return null;
    const version = rel.tag_name.replace(/^v/, '');
    const assets = rel.assets || [];
    const exe = (re) => assets.find((x) => re.test(x.name) && x.name.endsWith('.exe'));
    const info = {
      version,
      page: rel.html_url,
      setupUrl: (exe(/setup/i) || {}).browser_download_url,
      portableUrl: (exe(/portable/i) || {}).browser_download_url,
    };
    if (this.mode !== 'installer' || cmpVersions(version, this.current) <= 0) return info;
    const yml = assets.find((x) => x.name === 'latest.yml');
    if (!yml) throw new Error('В релизе нет latest.yml — его нужно загрузить вместе с установщиком');
    const y = parseLatestYml(await assetText(yml));
    const asset = assets.find((x) => x.name === y.file) || exe(/setup/i);
    if (!asset || !y.sha512) throw new Error('В релизе нет установщика или его контрольной суммы');
    return { ...info, file: asset.name, sha512: y.sha512, size: y.size || asset.size, url: asset.url, headers: { Accept: 'application/octet-stream' } };
  }

  /** Запасной путь без API: github.com/<repo>/releases/latest/download/... (в лимит API не входит). */
  async #fromWeb() {
    const base = `https://github.com/${this.repo}/releases/latest/download`;
    const res = await fetch(`${base}/latest.yml`, { headers: { 'User-Agent': dl.UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`github.com: HTTP ${res.status}`);
    const text = await res.text();
    const version = (/^version:\s*['"]?([^'"\s]+)/m.exec(text) || [])[1];
    const y = parseLatestYml(text);
    if (!version || !y.file || !y.sha512) throw new Error('latest.yml без версии или контрольной суммы');
    const page = `https://github.com/${this.repo}/releases/latest`;
    return {
      version,
      page,
      setupUrl: `${base}/${encodeURIComponent(y.file)}`,
      portableUrl: page,
      file: y.file,
      sha512: y.sha512,
      size: y.size,
      url: `${base}/${encodeURIComponent(y.file)}`,
      headers: {},
    };
  }

  async #fetchInstaller(info) {
    fs.mkdirSync(this.dir, { recursive: true });
    // старые скачанные установщики больше не нужны
    for (const f of fs.readdirSync(this.dir)) if (f !== info.file) fs.rmSync(path.join(this.dir, f), { force: true });
    const dest = path.join(this.dir, info.file);
    const size = info.size;
    let bytes = 0;
    let last = 0;
    this.set({ status: 'downloading', version: info.version, percent: 0 });
    const cached = fs.existsSync(dest) && (!size || fs.statSync(dest).size === size);
    if (!cached || !(await this.#sha512ok(dest, info.sha512))) {
      await dl.downloadFile(
        { url: info.url, dest, size, sha512: info.sha512, headers: info.headers },
        {
          onBytes: (n) => {
            bytes += n;
            const now = Date.now();
            if (size && now - last > 400) {
              last = now;
              this.set({ status: 'downloading', percent: Math.min(99, Math.round((bytes / size) * 100)) });
            }
          },
        }
      );
    }
    this.file = dest;
    this.set({ status: 'ready', version: info.version, percent: 100 });
  }

  async #sha512ok(file, expected) {
    const crypto = require('crypto');
    return new Promise((resolve) => {
      const h = crypto.createHash('sha512');
      fs.createReadStream(file)
        .on('error', () => resolve(false))
        .on('data', (d) => h.update(d))
        .on('end', () => resolve(h.digest('base64') === expected));
    });
  }

  #spawnInstaller(runAfter) {
    if (this.installing || !this.file) return;
    this.installing = true;
    // те же ключи, что у electron-updater: тихая установка поверх, затем (по желанию) запуск новой версии
    const args = ['--updated', '/S'];
    if (runAfter) args.push('--force-run');
    spawn(this.file, args, { detached: true, stdio: 'ignore' }).unref();
  }

  install() {
    if (this.state.status !== 'ready' || !this.file) throw new Error('Обновление ещё не скачано');
    if (!this.canInstall()) throw new Error('Закройте игру, чтобы установить обновление');
    this.#spawnInstaller(true);
    setImmediate(() => app.quit());
  }
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|aborted|timeout|не отвечает|нет соединения/i.test(m)) return 'Нет связи с GitHub, попробуем ещё раз через 10 минут';
  if (/HTTP 403|rate limit/i.test(m)) return 'GitHub временно ограничил запросы, попробуем позже';
  if (/HTTP 5\d\d/.test(m)) return 'GitHub временно не отвечает, попробуем ещё раз через 10 минут';
  return m.split('\n')[0].slice(0, 200);
}

module.exports = { Updater, cmpVersions, parseLatestYml };
