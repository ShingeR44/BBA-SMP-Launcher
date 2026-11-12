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
// ---------- Зеркало на GitHub ----------
// Релиз с постоянным тегом (по умолчанию «modpack»): pack.json, в котором моды с Modrinth указаны
// официальными ссылками cdn.modrinth.com, а остальные файлы лежат в самом релизе под именем <sha1>.<расширение>
// (GitHub портит имена с пробелами и скобками). Релиз и его файлы берутся через api.github.com.
const mirrorName = (f) => `${f.sha1}${path.posix.extname(f.path).toLowerCase()}`;

async function ghJson(url, signal) {
  const res = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    headers: { 'User-Agent': dl.UA, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
  return res.json();
}

async function loadFromMirror(mirror, signal) {
  const rel = await ghJson(`https://api.github.com/repos/${mirror.github}/releases/tags/${encodeURIComponent(mirror.tag || 'modpack')}`, signal);
  const assets = new Map((rel.assets || []).map((a) => [a.name, a]));
  const packAsset = assets.get('pack.json');
  if (!packAsset) throw new Error('на зеркале нет pack.json');
  const res = await fetch(packAsset.url, {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': dl.UA, Accept: 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`pack.json с зеркала: HTTP ${res.status}`);
  const pack = validate(JSON.parse(await res.text()));
  for (const f of pack.files) {
    if (/^https:\/\//.test(f.url)) continue; // официальная ссылка (Modrinth) — качаем как есть
    const a = assets.get(mirrorName(f));
    if (!a) throw new Error(`на зеркале нет файла ${f.path}`);
    f.url = a.url;
    f.headers = { Accept: 'application/octet-stream' };
  }
  pack._baseUrl = null;
  pack._mirror = true;
  pack._offline = false;
  return pack;
}

/**
 * Получает pack.json: сайт -> зеркало на GitHub -> последний сохранённый.
 * mirror: { github: 'owner/repo', tag: 'modpack' }
 */
async function loadPack(url, root, { signal, mirror, cacheName = 'pack.json' } = {}) {
  const cache = path.join(root, cacheName);
  const save = async (pack) => {
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(cache, JSON.stringify(pack, null, 2));
    return pack;
  };
  try {
    const pack = validate(await dl.fetchJson(url, { signal, noCache: true, timeoutMs: 8000 }));
    pack._baseUrl = url;
    pack._offline = false;
    return await save(pack);
  } catch (e) {
    if (e.code === 'ABORTED') throw e;
    if (mirror && mirror.github) {
      try {
        const pack = await loadFromMirror(mirror, signal);
        pack._siteError = e.message;
        return await save(pack);
      } catch (me) {
        e.message = `${e.message}; зеркало: ${me.message}`;
      }
    }
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
async function syncPack(pack, root, gameDir, { repair, signal, onProgress, onStage, protect } = {}) {
  const isProtected = (rel) => (typeof protect === 'function' ? protect(rel) : false);
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
      tasks.push({ url: new URL(f.url, base || undefined).href, headers: f.headers, dest, sha1: f.sha1, size: f.size, path: f.path });
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
        // файлы, которые игрок ставил сам, не трогаем, даже если раньше такой же файл был в сборке
        if (old.toLowerCase().startsWith(`${clean.toLowerCase()}/`) && !wanted.has(old.toLowerCase()) && !isProtected(old)) {
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

// ---------- Несколько сборок ----------
/** packs.json: { packs: [{ id, name, version, url, required }] }. Без сети — последний сохранённый. */
async function loadIndex(url, root, { signal } = {}) {
  const cache = path.join(root, 'packs-index.json');
  if (!url) return null;
  try {
    const j = await dl.fetchJson(url, { signal, noCache: true, timeoutMs: 8000 });
    if (!j || !Array.isArray(j.packs)) throw new Error('packs.json без списка сборок');
    const packs = j.packs
      .filter((p) => p && p.url)
      .map((p) => ({ id: String(p.id || p.url), name: p.name || null, version: p.version || null, required: p.required !== false, url: new URL(p.url, url).href }));
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(cache, JSON.stringify(packs, null, 2));
    return packs;
  } catch (e) {
    if (e.code === 'ABORTED') throw e;
    try {
      return JSON.parse(await fsp.readFile(cache, 'utf8'));
    } catch {
      return null;
    }
  }
}

/**
 * Plus = основная сборка + дополнительная. Файлы основной важнее (при совпадении пути).
 * Адреса файлов делаем абсолютными, чтобы у каждой сборки была своя база.
 */
function combinePacks(main, extra) {
  const abs = (f, base) => ({ ...f, url: /^https?:\/\//.test(f.url) ? f.url : new URL(f.url, base || undefined).href });
  const files = main.files.map((f) => ({ ...abs(f, main._baseUrl), from: 'main' }));
  const seen = new Set(files.map((f) => f.path.toLowerCase()));
  for (const f of extra.files) {
    if (seen.has(f.path.toLowerCase())) continue;
    seen.add(f.path.toLowerCase());
    files.push({ ...abs(f, extra._baseUrl), from: 'extra' });
  }
  return {
    ...main,
    files,
    version: `${main.version}+${extra.version}`,
    _baseUrl: null,
    _offline: !!(main._offline || extra._offline),
    _mirror: !!(main._mirror || extra._mirror),
    _extra: { name: extra.name || null, version: extra.version || null, files: extra.files.length },
  };
}

module.exports = { loadPack, syncPack, installedVersion, mirrorName, loadIndex, combinePacks };
