#!/usr/bin/env node
// Генерирует pack.json из папки сборки. Запуск:
//   node tools/build-pack.mjs ./modpack --mc 26.3 --loader fabric@0.17.3 --server play.example.ru:25565
// Потом загрузите папку ./modpack вместе с pack.json на сайт, например в /launcher/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readZipEntries, readZipEntry } = require('../src/main/download.js');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const BOOL_FLAGS = ['--help', '--no-user-mods', '--no-user-shaders', '--no-user-resourcepacks', '--user-content'];
const dir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !BOOL_FLAGS.includes(args[i - 1])));
if (!dir || args.includes('--help')) {
  console.log(`Использование: node tools/build-pack.mjs <папка> [параметры]

  --mc 26.3                   версия Minecraft
  --loader fabric@0.17.3      загрузчик: vanilla | fabric[@версия] | quilt[@версия] | neoforge@версия | forge@версия
  --version 1.2.0             версия сборки (по умолчанию — дата и время)
  --server host[:port]        адрес сервера для автоподключения
  --name "BBA SMP"            название
  --memory 4096               рекомендуемая память, МБ
  --keep options.txt,servers.dat   файлы/папки, которые не перезаписываются у игроков
  --managed mods              папки, из которых удаляются лишние файлы (через запятую)
  --no-user-mods              запретить игрокам свои моды (также --no-user-shaders, --no-user-resourcepacks;
                              --user-content снова всё разрешает)

Параметры, которые не указаны, берутся из существующего <папка>/pack.json.`);
  process.exit(dir ? 0 : 1);
}

const root = path.resolve(dir);
const outFile = path.resolve(opt('out', path.join(root, 'pack.json')));
let prev = {};
try {
  prev = JSON.parse(fs.readFileSync(outFile, 'utf8'));
} catch {
  /* первый запуск */
}

const mc = opt('mc', prev.minecraft);
if (!mc) {
  console.error('Укажите версию Minecraft: --mc 26.3');
  process.exit(1);
}
let loader = prev.loader || { type: 'vanilla' };
if (opt('loader')) {
  const [type, version] = opt('loader').split('@');
  loader = { type: type.toLowerCase(), ...(version ? { version } : {}) };
}
let server = prev.server;
if (opt('server')) {
  const [host, port] = opt('server').split(':');
  server = { host, port: port ? Number(port) : 25565 };
}
const keep = (opt('keep') || (prev._keep || ['options.txt', 'servers.dat']).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const managed = (opt('managed') || (prev.managedDirs || ['mods', 'shaderpacks', 'resourcepacks']).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
// свои моды/шейдеры/ресурспаки игроков: --no-user-mods, --no-user-shaders, --no-user-resourcepacks
const userContent = { mods: true, shaderpacks: true, resourcepacks: true, ...(prev.userContent || {}) };
if (args.includes('--no-user-mods')) userContent.mods = false;
if (args.includes('--no-user-shaders')) userContent.shaderpacks = false;
if (args.includes('--no-user-resourcepacks')) userContent.resourcepacks = false;
if (args.includes('--user-content')) Object.assign(userContent, { mods: true, shaderpacks: true, resourcepacks: true });
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const version = opt('version', `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function modName(file) {
  try {
    const buf = fs.readFileSync(file);
    const entries = readZipEntries(buf);
    const get = (n) => {
      const e = entries.find((x) => x.name === n);
      return e ? readZipEntry(buf, e).toString('utf8') : null;
    };
    const fabric = get('fabric.mod.json') || get('quilt.mod.json');
    if (fabric) {
      const j = JSON.parse(fabric.replace(/[\u0000-\u001f]+/g, ' '));
      return j.name || (j.quilt_loader && j.quilt_loader.metadata && j.quilt_loader.metadata.name) || null;
    }
    const toml = get('META-INF/neoforge.mods.toml') || get('META-INF/mods.toml');
    if (toml) {
      const m = toml.match(/displayName\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
  } catch {
    /* не jar или без метаданных */
  }
  return null;
}

const files = [];
for (const abs of walk(root)) {
  if (path.resolve(abs) === outFile) continue;
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('.') || rel.endsWith('.part')) continue;
  const data = fs.readFileSync(abs);
  const entry = {
    path: rel,
    url: rel.split('/').map(encodeURIComponent).join('/'),
    sha1: crypto.createHash('sha1').update(data).digest('hex'),
    size: data.length,
  };
  if (keep.some((k) => rel === k || rel.startsWith(`${k.replace(/\/$/, '')}/`))) entry.keep = true;
  if (rel.startsWith('mods/') && rel.endsWith('.jar')) {
    const name = modName(abs);
    if (name) entry.name = name;
  }
  files.push(entry);
}
files.sort((a, b) => a.path.localeCompare(b.path));

const pack = {
  formatVersion: 1,
  name: opt('name', prev.name || 'BBA SMP'),
  version,
  minecraft: mc,
  loader,
  ...(server ? { server } : {}),
  memory: { recommended: Number(opt('memory', (prev.memory && prev.memory.recommended) || 4096)) },
  jvmArgs: prev.jvmArgs || [],
  managedDirs: managed,
  userContent,
  _keep: keep,
  files,
};
fs.writeFileSync(outFile, JSON.stringify(pack, null, 2));
const total = files.reduce((s, f) => s + f.size, 0);
console.log(`Готово: ${outFile}
  Minecraft ${mc}, ${loader.type}${loader.version ? ` ${loader.version}` : ''}, сборка ${version}
  Файлов: ${files.length} (модов: ${files.filter((f) => f.path.startsWith('mods/')).length}), ${(total / 1048576).toFixed(1)} МБ`);
