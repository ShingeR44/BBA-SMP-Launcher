'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) {
    const e = new Error(r.error);
    e.code = r.code;
    throw e;
  }
  return r.data;
}

const EVENTS = ['progress', 'game-state', 'update-state', 'win-state'];

contextBridge.exposeInMainWorld('bba', {
  info: () => call('app:info'),
  win: {
    minimize: () => call('win:minimize'),
    maximize: () => call('win:maximize'),
    isMaximized: () => call('win:isMaximized'),
    close: () => call('win:close'),
  },
  openExternal: (url) => call('shell:external', url),
  openFolder: (which) => call('shell:folder', which),
  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
    pickJava: () => call('settings:pickJava'),
  },
  accounts: {
    list: () => call('accounts:list'),
    loginMicrosoft: () => call('accounts:loginMicrosoft'),
    loginYggdrasil: (username, password) => call('accounts:loginYggdrasil', username, password),
    select: (id) => call('accounts:select', id),
    remove: (id) => call('accounts:remove', id),
  },
  pack: { info: () => call('pack:info'), setVariant: (id) => call('pack:setVariant', id) },
  news: { list: () => call('news:list') },
  content: {
    list: (kind) => call('content:list', kind),
    add: (kind, paths) => call('content:add', kind, paths || null),
    toggle: (kind, file, enabled) => call('content:toggle', kind, file, enabled),
    remove: (kind, file) => call('content:remove', kind, file),
    folder: (kind) => call('content:folder', kind),
    // путь к перетащенному файлу (в Electron 32+ File.path больше нет)
    // FileList целиком через contextBridge не проходит — передаём файлы по одному
    pathFor: (file) => webUtils.getPathForFile(file),
  },
  update: {
    state: () => call('update:state'),
    check: () => call('update:check'),
    install: () => call('update:install'),
  },
  server: {
    status: () => call('server:status'),
    list: () => call('server:list'),
    select: (id) => call('server:select', id),
    pingAll: () => call('server:pingAll'),
  },
  game: {
    play: (opts) => call('game:play', opts),
    cancel: () => call('game:cancel'),
    running: () => call('game:running'),
  },
  on: (channel, fn) => {
    if (!EVENTS.includes(channel)) return () => {};
    const h = (_e, data) => fn(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
