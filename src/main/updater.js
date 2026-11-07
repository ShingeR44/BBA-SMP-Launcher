'use strict';
// Автообновление лаунчера по релизам GitHub.
// - Установленная версия (NSIS): electron-updater сам скачивает новую версию в фоне
//   и ставит её при перезапуске (тихо, с проверкой sha512 из latest.yml).
// - Portable и режим разработки: только проверяем GitHub и предлагаем скачать.
const { app } = require('electron');
const dl = require('./download');

const CHECK_EVERY = 2 * 60 * 60 * 1000; // каждые 2 часа

function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/);
  const pb = String(b).replace(/^v/, '').split(/[.-]/);
  for (let i = 0; i < 3; i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d;
  }
  return 0;
}

class Updater {
  constructor({ repo, allowPrerelease = false, send, canInstall }) {
    this.repo = repo; // "owner/name"
    this.allowPrerelease = allowPrerelease;
    this.send = send;
    this.canInstall = canInstall || (() => true);
    this.portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
    this.mode = !app.isPackaged ? 'dev' : this.portable ? 'portable' : 'installer';
    this.state = { status: 'idle', current: app.getVersion(), mode: this.mode };
    this.au = null;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.send('update-state', this.state);
  }

  start() {
    if (!this.repo) return;
    if (this.mode === 'installer') this.#initAutoUpdater();
    setTimeout(() => this.check().catch(() => {}), 8000);
    setInterval(() => this.check().catch(() => {}), CHECK_EVERY);
  }

  #initAutoUpdater() {
    const { autoUpdater } = require('electron-updater');
    this.au = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = this.allowPrerelease;
    autoUpdater.logger = null;
    // для проверки обновлений на тестовом сервере
    if (process.env.BBA_UPDATE_FEED) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.BBA_UPDATE_FEED });
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) =>
      this.set({ status: 'downloading', version: info.version, notes: info.releaseNotes || null, percent: 0 })
    );
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version, percent: 100 }));
    autoUpdater.on('error', (e) => this.set({ status: 'error', error: friendly(e) }));
  }

  async check() {
    if (this.state.status === 'downloading' || this.state.status === 'ready') return this.state;
    if (this.au) {
      await this.au.checkForUpdates().catch((e) => this.set({ status: 'error', error: friendly(e) }));
      return this.state;
    }
    // portable / разработка — смотрим последний релиз через API GitHub
    this.set({ status: 'checking', error: null });
    try {
      const rel = this.allowPrerelease
        ? (await dl.fetchJson(`https://api.github.com/repos/${this.repo}/releases?per_page=5`, { timeoutMs: 10000 })).find((r) => !r.draft)
        : await dl.fetchJson(`https://api.github.com/repos/${this.repo}/releases/latest`, { timeoutMs: 10000 });
      if (!rel) return this.set({ status: 'latest', checkedAt: Date.now() }), this.state;
      const version = rel.tag_name.replace(/^v/, '');
      if (cmpVersions(version, app.getVersion()) > 0) {
        const asset = (rel.assets || []).find((a) => (this.portable ? /portable/i : /setup/i).test(a.name) && a.name.endsWith('.exe'));
        this.set({ status: 'available', version, url: (asset && asset.browser_download_url) || rel.html_url, page: rel.html_url });
      } else {
        this.set({ status: 'latest', checkedAt: Date.now() });
      }
    } catch (e) {
      // нет релизов (404) — считаем, что версия актуальная
      if (/HTTP 404/.test(e.message)) this.set({ status: 'latest', checkedAt: Date.now() });
      else this.set({ status: 'error', error: friendly(e) });
    }
    return this.state;
  }

  install() {
    if (!this.au || this.state.status !== 'ready') throw new Error('Обновление ещё не скачано');
    if (!this.canInstall()) throw new Error('Закройте игру, чтобы установить обновление');
    // тихая установка и автоматический запуск новой версии
    setImmediate(() => this.au.quitAndInstall(true, true));
  }
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|не отвечает|нет соединения/i.test(m)) return 'Нет связи с GitHub';
  if (/latest\.yml/i.test(m) && /404/.test(m)) return 'В последнем релизе нет latest.yml — его нужно загрузить вместе с установщиком';
  if (/404/.test(m)) return 'Релизы не найдены';
  if (/sha512|checksum/i.test(m)) return 'Файл обновления повреждён, попробуем ещё раз позже';
  return m.split('\n')[0].slice(0, 200);
}

module.exports = { Updater, cmpVersions };
