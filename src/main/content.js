'use strict';
// Свои файлы игрока: клиентские моды, шейдеры, ресурспаки.
// Файлы сборки защищены: их нельзя выключить или удалить из лаунчера,
// а если удалить или подменить вручную — лаунчер вернёт их при запуске.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const dl = require('./download');

const KINDS = {
  mods: { dir: 'mods', ext: '.jar', title: 'мод' },
  shaderpacks: { dir: 'shaderpacks', ext: '.zip', title: 'шейдер' },
  resourcepacks: { dir: 'resourcepacks', ext: '.zip', title: 'ресурспак' },
};
const OFF = '.disabled';

// какие загрузчики совместимы с модом какого типа
const LOADER_OK = {
  fabric: ['fabric'],
  quilt: ['quilt', 'fabric'],
  neoforge: ['neoforge'],
  forge: ['forge'],
  vanilla: [],
};
const LOADER_NAME = { fabric: 'Fabric', quilt: 'Quilt', neoforge: 'NeoForge', forge: 'Forge', vanilla: 'ванилла' };

// ---------- Чтение метаданных ----------
const metaCache = new Map(); // путь -> { key, meta }

function readZip(file) {
  const buf = fs.readFileSync(file);
  const entries = dl.readZipEntries(buf);
  const get = (name) => {
    const e = entries.find((x) => x.name === name);
    return e ? dl.readZipEntry(buf, e).toString('utf8') : null;
  };
  return { entries, get };
}

/** Метаданные мода: id, название, версия, загрузчик. null — если это не мод. */
function readModMeta(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${st.size}:${st.mtimeMs}`;
  const cached = metaCache.get(file);
  if (cached && cached.key === key) return cached.meta;
  let meta = null;
  try {
    const z = readZip(file);
    const fabric = z.get('fabric.mod.json');
    const quilt = z.get('quilt.mod.json');
    const neo = z.get('META-INF/neoforge.mods.toml');
    const forge = z.get('META-INF/mods.toml');
    const clean = (s) => s.replace(/[\u0000-\u001f]+/g, ' ');
    if (quilt) {
      const j = JSON.parse(clean(quilt)).quilt_loader || {};
      meta = { id: j.id, name: (j.metadata && j.metadata.name) || j.id, version: j.version, loader: 'quilt' };
    } else if (fabric) {
      const j = JSON.parse(clean(fabric));
      meta = { id: j.id, name: j.name || j.id, version: j.version, loader: 'fabric' };
    } else if (neo || forge) {
      const t = neo || forge;
      const id = (/modId\s*=\s*"([^"]+)"/.exec(t) || [])[1];
      const name = (/displayName\s*=\s*"([^"]+)"/.exec(t) || [])[1];
      const version = (/version\s*=\s*"([^"]+)"/.exec(t) || [])[1];
      meta = { id, name: name || id, version, loader: neo ? 'neoforge' : 'forge' };
    }
  } catch {
    meta = null;
  }
  metaCache.set(file, { key, meta });
  return meta;
}

/** Что лежит в zip: шейдер (папка shaders/) или ресурспак (pack.mcmeta). */
function detectZipKind(file) {
  try {
    const { entries } = readZip(file);
    if (entries.some((e) => e.name.startsWith('shaders/'))) return 'shaderpacks';
    if (entries.some((e) => e.name === 'pack.mcmeta')) return 'resourcepacks';
  } catch {
    /* не zip */
  }
  return null;
}

const prettyName = (file) =>
  file
    .replace(/\.(jar|zip)(\.disabled)?$/i, '')
    .replace(/[-_+](mc|fabric|neoforge|forge|quilt)?[-_]?\d[\w.+-]*$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

// ---------- Менеджер ----------
class Content {
  constructor({ gameDir, getPack, trash }) {
    this.gameDir = gameDir;
    this.getPack = getPack; // () => pack | null
    this.trash = trash || ((p) => fsp.rm(p, { force: true }));
  }

  dir(kind) {
    return path.join(this.gameDir, KINDS[kind].dir);
  }

  allowed(kind) {
    const pack = this.getPack();
    const uc = (pack && pack.userContent) || {};
    return uc[kind] !== false;
  }

  loader() {
    const pack = this.getPack();
    return ((pack && pack.loader && pack.loader.type) || 'vanilla').toLowerCase();
  }

  /** Файлы сборки в папке этого типа: имя файла (в нижнем регистре) -> запись из pack.json */
  packFiles(kind) {
    const pack = this.getPack();
    const prefix = `${KINDS[kind].dir}/`;
    const map = new Map();
    for (const f of (pack && pack.files) || []) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      if (!rest.includes('/')) map.set(rest.toLowerCase(), f);
    }
    return map;
  }

  /** id модов сборки (по скачанным файлам) */
  packModIds() {
    const ids = new Map();
    for (const [, f] of this.packFiles('mods')) {
      const meta = readModMeta(path.join(this.gameDir, ...f.path.split('/')));
      if (meta && meta.id) ids.set(meta.id, meta.name || f.name || meta.id);
    }
    return ids;
  }

  async list(kind) {
    if (!KINDS[kind]) throw new Error('Неизвестный тип файлов');
    const { ext } = KINDS[kind];
    const dir = this.dir(kind);
    const packMap = this.packFiles(kind);
    let names = [];
    try {
      names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      /* папки ещё нет */
    }
    const pack = [...packMap.values()].map((f) => {
      const file = path.posix.basename(f.path);
      return { file, name: f.name || prettyName(file), size: f.size || 0, locked: true, present: names.some((n) => n.toLowerCase() === file.toLowerCase()) };
    });

    const packIds = kind === 'mods' ? this.packModIds() : new Map();
    const loader = this.loader();
    const user = [];
    for (const n of names) {
      const lower = n.toLowerCase();
      const enabled = lower.endsWith(ext);
      if (!enabled && !lower.endsWith(ext + OFF)) continue;
      const base = enabled ? n : n.slice(0, -OFF.length);
      if (packMap.has(base.toLowerCase())) continue; // это файл сборки (или его выключенная копия)
      const full = path.join(dir, n);
      const st = await fsp.stat(full).catch(() => null);
      const item = { file: base, name: prettyName(base), size: st ? st.size : 0, enabled, locked: false };
      if (kind === 'mods') {
        const meta = readModMeta(full);
        if (meta) {
          item.name = meta.name || item.name;
          item.version = meta.version || null;
          item.modId = meta.id || null;
          if (meta.id && packIds.has(meta.id)) item.problem = `Уже есть в сборке (${packIds.get(meta.id)})`;
          else if (!(LOADER_OK[loader] || []).includes(meta.loader)) item.problem = `Мод для ${LOADER_NAME[meta.loader]}, а сборка на ${LOADER_NAME[loader]}`;
        } else item.problem = 'Не похоже на мод Minecraft';
      }
      user.push(item);
    }
    user.sort((a, b) => a.name.localeCompare(b.name));
    pack.sort((a, b) => a.name.localeCompare(b.name));
    return { kind, allowed: this.allowed(kind), loader, pack, user, hint: this.hint(kind) };
  }

  hint(kind) {
    if (kind !== 'shaderpacks') return null;
    const pack = this.getPack();
    const hasShaderMod = ((pack && pack.files) || []).some((f) => f.path.startsWith('mods/') && /iris|oculus/i.test(`${f.name || ''} ${f.path}`));
    return hasShaderMod ? null : 'Для шейдеров нужен мод Iris (Fabric) или Oculus (NeoForge) — в сборке его нет. Попросите админа добавить.';
  }

  /** Добавляет файлы. Тип определяется по содержимому, а не только по вкладке. */
  async add(paths, preferKind) {
    const added = [];
    const rejected = [];
    const loader = this.loader();
    let packIds = null;
    for (const src of paths) {
      const file = path.basename(src);
      const lower = file.toLowerCase();
      const reject = (reason) => rejected.push({ file, reason });
      let kind = null;
      if (lower.endsWith('.jar')) kind = 'mods';
      else if (lower.endsWith('.zip')) kind = detectZipKind(src) || (preferKind !== 'mods' ? preferKind : null);
      if (!kind) {
        reject('Неизвестный тип файла: нужны .jar (моды) или .zip (шейдеры и ресурспаки)');
        continue;
      }
      if (!this.allowed(kind)) {
        reject(`Админ запретил добавлять свои ${kind === 'mods' ? 'моды' : kind === 'shaderpacks' ? 'шейдеры' : 'ресурспаки'}`);
        continue;
      }
      if (this.packFiles(kind).has(lower)) {
        reject('Файл с таким именем уже есть в сборке');
        continue;
      }
      if (kind === 'mods') {
        const meta = readModMeta(src);
        if (!meta) {
          reject('Не похоже на мод Minecraft');
          continue;
        }
        if (!(LOADER_OK[loader] || []).includes(meta.loader)) {
          reject(`Мод для ${LOADER_NAME[meta.loader]}, а сборка на ${LOADER_NAME[loader]}`);
          continue;
        }
        packIds = packIds || this.packModIds();
        if (meta.id && packIds.has(meta.id)) {
          reject(`Этот мод уже есть в сборке (${packIds.get(meta.id)})`);
          continue;
        }
      }
      const dir = this.dir(kind);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.rm(path.join(dir, file + OFF), { force: true });
      await fsp.copyFile(src, path.join(dir, file));
      added.push({ file, kind });
    }
    return { added, rejected };
  }

  #userPath(kind, file) {
    if (!KINDS[kind] || !file || file.includes('/') || file.includes('\\') || file.startsWith('.')) throw new Error('Недопустимое имя файла');
    if (this.packFiles(kind).has(file.toLowerCase())) throw new Error('Файлы сборки нельзя выключить или удалить');
    return path.join(this.dir(kind), file);
  }

  async toggle(kind, file, enabled) {
    const p = this.#userPath(kind, file);
    const [from, to] = enabled ? [p + OFF, p] : [p, p + OFF];
    await fsp.rename(from, to);
  }

  async remove(kind, file) {
    const p = this.#userPath(kind, file);
    for (const candidate of [p, p + OFF]) {
      if (fs.existsSync(candidate)) await this.trash(candidate);
    }
  }

  /** Перед запуском: выключает свои моды, которые конфликтуют со сборкой. */
  async enforce() {
    if (!this.allowed('mods')) return [];
    const { user } = await this.list('mods');
    const disabled = [];
    for (const m of user) {
      if (m.enabled && m.problem) {
        await this.toggle('mods', m.file, false).catch(() => {});
        disabled.push({ file: m.file, name: m.name, reason: m.problem });
      }
    }
    return disabled;
  }
}

module.exports = { Content, readModMeta, detectZipKind, KINDS };
