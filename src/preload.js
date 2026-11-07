'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) {
    const e = new Error(r.error);
    e.code = r.code;
    throw e;
  }
  return r.data;
}

const EVENTS = ['progress', 'game-state'];

contextBridge.exposeInMainWorld('bba', {
  info: () => call('app:info'),
  win: { minimize: () => call('win:minimize'), close: () => call('win:close') },
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
  pack: { info: () => call('pack:info') },
  news: { list: () => call('news:list') },
  server: { status: () => call('server:status') },
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
