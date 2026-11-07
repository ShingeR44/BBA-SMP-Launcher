'use strict';
// Модпак: загрузка pack.json с сайта и синхронизация папки игры (mods, config и т.д.).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const dl = require('./download');

const LOADERS = ['vanilla', 'fabric', 'quilt', 'neoforge', 'forge'];

function validate(pack) {
  if (!pack || typeof pack !== 'object') throw new Error('pack.json пустой или повреждён');
  if (!pack.minecraft) throw new Error('В pack.json не указана версия minecraft');
  const type = ((pack.loader && pack.loader.type) || 'vanilla').toLowerCase();
  if (!LOADERS.includes(type)) throw new Error(`Неизвестный загрузчик в pack.json: ${type}`);
  if (!Array.isArray(pack.files)) pack.files = [];
  for (const f of pack.files) {
    if (!f.path || !f.url) throw new Error('В pack.json у файла нет path или url');
    const norm = path.posix.normalize(f.path.replace(/\\/g, '/'));
    if (norm.startsWith('../') || norm.startsWith('/') || /^[a-z]:/i.test(norm) || norm.includes('/../')) {
      throw new Error(`Недопустимый путь в pack.json: ${f.path}`);
    }
    f.path = norm;
  }
  pack.managedDirs = Array.isArray(pack.managedDirs) ? pack.managedDirs : ['mods', 'shaderpacks', 'resourcepacks'];
  return pack;
}

/** Получает pack.json с сайта; без интернета берёт последний сохранённый. */
async function loadPack(url, root, { signal } = {}) {
  const cache = path.join(root, 'pack.json');
  try {
    const pack = validate(await dl.fetchJson(url, { signal, noCache: true, timeoutMs: 8000 }));
    pack._baseUrl = url;
    pack._offline = false;
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(cache, JSON.stringify(pack, null, 2));
    return pack;
  } catch (e) {
    if (e.code === 'ABORTED') throw e;
    try {
      const pack = validate(JSON.parse(await fsp.readFile(cache, 'utf8')));
      pack._offline = true;
      pack._error = e.message;
      return pack;
    } catch {
      throw new Error(`Не удалось загрузить сборку: ${e.message}`);
    }
  }
}

async function readState(root) {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, 'pack-state.json'), 'utf8'));
  } catch {
    return { files: {} };
  }
}

async function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Приводит папку игры в соответствие со сборкой.
 * - качает недостающие/изменённые файлы;
 * - файлы с "keep": true (настройки) скачиваются, только если их нет;
 * - в managedDirs удаляет файлы, которых нет в сборке. В mods/shaderpacks/resourcepacks, если админ
 *   разрешил свои файлы (userContent), удаляются только убранные из сборки файлы, а файлы игрока остаются.
 */
async function syncPack(pack, root, gameDir, { repair, signal, onProgress, onStage } = {}) {
  const state = await readState(root);
  const newState = { version: pack.version, files: {} };
  const base = pack._baseUrl || '';
  const tasks = [];
  const wanted = new Set();

  if (onStage) onStage('Проверяем файлы сборки…');
  for (const f of pack.files) {
    const dest = path.join(gameDir, ...f.path.split('/'));
    const key = f.path.toLowerCase();
    wanted.add(key);
    const st = await fsp.stat(dest).catch(() => null);
    if (f.keep && st) continue;

    const cached = state.files[f.path];
    let ok = false;
    if (st && (f.size == null || st.size === f.size)) {
      if (!repair && cached && cached.sha1 === f.sha1 && cached.size === st.size && cached.mtimeMs === st.mtimeMs) ok = true;
      else ok = await dl.fileMatches(dest, f, 'sha1');
    }
    if (ok) {
      newState.files[f.path] = { sha1: f.sha1, size: st.size, mtimeMs: st.mtimeMs };
    } else {
      tasks.push({ url: new URL(f.url, base || undefined).href, dest, sha1: f.sha1, size: f.size, path: f.path });
    }
  }

  if (tasks.length) {
    if (onStage) onStage(`Загружаем сборку (${tasks.length} файл.)…`);
    await dl.downloadMany(tasks, { signal, onProgress, concurrency: 6 });
    for (const t of tasks) {
      const st = await fsp.stat(t.dest);
      newState.files[t.path] = { sha1: t.sha1, size: st.size, mtimeMs: st.mtimeMs };
    }
  }

  // чистим управляемые папки
  const removed = [];
  const uc = pack.userContent || {};
  for (const dir of pack.managedDirs) {
    const clean = dir.replace(/\/$/, '');
    const abs = path.join(gameDir, dir);
    if (uc[clean] !== false && ['mods', 'shaderpacks', 'resourcepacks'].includes(clean)) {
      // игрокам можно класть сюда свои файлы: удаляем только то, что раньше было в сборке и из неё убрано
      for (const old of Object.keys(state.files || {})) {
        if (old.toLowerCase().startsWith(`${clean.toLowerCase()}/`) && !wanted.has(old.toLowerCase())) {
          await fsp.rm(path.join(gameDir, ...old.split('/')), { force: true });
          removed.push(old);
        }
      }
      continue;
    }
    for (const rel of await walk(abs)) {
      const full = `${dir.replace(/\/$/, '')}/${rel}`;
      if (!wanted.has(full.toLowerCase())) {
        await fsp.rm(path.join(abs, ...rel.split('/')), { force: true });
        removed.push(full);
      }
    }
  }

  await fsp.writeFile(path.join(root, 'pack-state.json'), JSON.stringify(newState));
  return { downloaded: tasks.length, removed };
}

async function installedVersion(root) {
  return (await readState(root)).version || null;
}

module.exports = { loadPack, syncPack, installedVersion };
