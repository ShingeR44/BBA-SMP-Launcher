'use strict';
// Настройки и аккаунты. Токены шифруются через safeStorage (DPAPI в Windows).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, safeStorage } = require('electron');

const DEFAULT_SETTINGS = {
  memoryMb: 0, // 0 = взять рекомендованное значение из сборки
  javaPath: '',
  width: 1280,
  height: 720,
  fullscreen: false,
  afterLaunch: 'hide', // hide | keep | close
  autoConnect: true,
  theme: 'dark',
  jvmArgs: '',
  selectedAccount: null,
  lastNewsSeen: null,
  serverAddress: null, // выбранный адрес сервера (host:port)
  windowBounds: null, // размер и положение окна
  windowMaximized: false,
  packVariant: 'standard', // standard | plus
};

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    this.settingsFile = path.join(this.dir, 'settings.json');
    this.accountsFile = path.join(this.dir, 'accounts.dat');
    fs.mkdirSync(this.dir, { recursive: true });
    this.settings = { ...DEFAULT_SETTINGS, ...this.#readJson(this.settingsFile, {}) };
    this.accounts = [];
    this.writing = Promise.resolve();
  }

  /** Вызывать после app.whenReady(). */
  async init() {
    this.accounts = await this.#readAccounts();
    return this;
  }

  #readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  async #readAccounts() {
    try {
      const raw = await fs.promises.readFile(this.accountsFile);
      const tag = raw.subarray(0, 4).toString();
      if (tag === 'ENC1') {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(raw.subarray(4));
        const list = JSON.parse(result);
        if (shouldReEncrypt) {
          this.accounts = list;
          await this.#writeAccounts();
        }
        return list;
      }
      return JSON.parse(raw.subarray(4).toString('utf8'));
    } catch {
      return [];
    }
  }

  // записи идут по очереди, чтобы не перетереть файл параллельными вызовами
  #writeAccounts() {
    this.writing = this.writing.then(async () => {
      const json = JSON.stringify(this.accounts);
      const data = (await safeStorage.isAsyncEncryptionAvailable())
        ? Buffer.concat([Buffer.from('ENC1'), await safeStorage.encryptStringAsync(json)])
        : Buffer.concat([Buffer.from('RAW1'), Buffer.from(json, 'utf8')]);
      await fs.promises.writeFile(this.accountsFile, data);
    });
    return this.writing;
  }

  setSettings(patch) {
    const allowedKeys = Object.keys(DEFAULT_SETTINGS);
    for (const [k, v] of Object.entries(patch || {})) if (allowedKeys.includes(k)) this.settings[k] = v;
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    return this.settings;
  }

  /** Публичная информация об аккаунтах (без токенов) для интерфейса. */
  publicAccounts() {
    const sel = this.getSelected();
    return this.accounts.map((a) => ({
      key: Store.key(a),
      id: a.id,
      name: a.name,
      type: a.type === 'ygg' ? 'ygg' : 'msa',
      skin: a.skin || null,
      selected: sel === a,
    }));
  }

  getSelected() {
    const sel = this.settings.selectedAccount;
    return this.accounts.find((a) => Store.key(a) === sel || a.id === sel) || this.accounts[0] || null;
  }

  async upsertAccount(acc) {
    const i = this.accounts.findIndex((a) => Store.key(a) === Store.key(acc));
    if (i >= 0) this.accounts[i] = acc;
    else this.accounts.push(acc);
    await this.#writeAccounts();
  }

  async removeAccount(key) {
    this.accounts = this.accounts.filter((a) => Store.key(a) !== key);
    if (this.settings.selectedAccount === key) this.setSettings({ selectedAccount: this.accounts[0] ? Store.key(this.accounts[0]) : null });
    await this.#writeAccounts();
  }

  /** Уникальный ключ: один и тот же UUID может быть и у Microsoft, и у аккаунта сервера. */
  static key(a) {
    return `${a.type === 'ygg' ? 'ygg' : 'msa'}:${a.id}`;
  }

  static totalMemoryMb() {
    return Math.floor(os.totalmem() / 1024 / 1024);
  }
}

module.exports = { Store };
