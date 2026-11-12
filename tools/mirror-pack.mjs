#!/usr/bin/env node
// Выкладывает сборку в зеркало на GitHub — релиз с постоянным тегом «modpack» (pre-release,
// чтобы не мешать обновлениям лаунчера). Лаунчер берёт сборку оттуда, если сайт не отвечает.
//
// Источник сборки (одно из):
//   node tools/mirror-pack.mjs ./modpack              папка с pack.json и файлами (как после build-pack)
//   node tools/mirror-pack.mjs --from-launcher        pack.json и файлы из %APPDATA%\.bba-smp (то, что скачал лаунчер)
//   node tools/mirror-pack.mjs --from-site            скачать pack.json и файлы с сайта (packUrl из launcher.config.json)
//
// Нужен GitHub CLI (gh), вошедший в аккаунт с правом записи в репозиторий.
// Моды, которые есть на Modrinth (ищутся по sha1), в зеркало не перезаливаются — в pack.json пишется
// официальная ссылка cdn.modrinth.com. Остальные файлы загружаются в релиз как <sha1>.<расширение>
// (проверьте, что их лицензия разрешает распространение). Загружаются только новые, ненужные удаляются.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'launcher.config.json'), 'utf8'));
const mirror = config.packMirror || {};
const REPO = mirror.github;
const TAG = mirror.tag || 'modpack';
if (!REPO) {
  console.error('В launcher.config.json нет packMirror.github');
  process.exit(1);
}

const args = process.argv.slice(2);
const GH = process.env.GH || (process.platform === 'win32' && fs.existsSync('C:/Program Files/GitHub CLI/gh.exe') ? 'C:/Program Files/GitHub CLI/gh.exe' : 'gh');
const gh = (...a) => execFileSync(GH, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
const mirrorName = (f) => `${f.sha1}${path.posix.extname(f.path).toLowerCase()}`;

// ---------- откуда берём сборку ----------
let pack;
let fileOf; // путь к файлу сборки на диске
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bba-mirror-'));

if (args.includes('--from-launcher')) {
  const dir = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), config.dataFolder || '.bba-smp');
  pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  fileOf = (f) => path.join(dir, 'game', ...f.path.split('/'));
} else if (args.includes('--from-site')) {
  const res = await fetch(config.packUrl, { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`pack.json с сайта: HTTP ${res.status}`);
  pack = await res.json();
  for (const f of pack.files) {
    const dest = path.join(tmp, 'src', ...f.path.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const r = await fetch(new URL(f.url, config.packUrl));
    if (!r.ok) throw new Error(`${f.path}: HTTP ${r.status}`);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  }
  fileOf = (f) => path.join(tmp, 'src', ...f.path.split('/'));
} else {
  const dir = path.resolve(args.find((a) => !a.startsWith('--')) || '.');
  pack = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  fileOf = (f) => path.join(dir, ...f.path.split('/'));
}

// служебные поля лаунчера (_baseUrl, _offline и т. п.) и абсолютные адреса в зеркало не попадают
for (const k of Object.keys(pack)) if (k.startsWith('_') && k !== '_keep') delete pack[k];
for (const f of pack.files) {
  delete f.headers;
  if (/^https?:/.test(f.url)) f.url = f.path.split('/').map(encodeURIComponent).join('/');
}

// ---------- проверяем файлы ----------
for (const f of pack.files) {
  const p = fileOf(f);
  if (!fs.existsSync(p)) throw new Error(`Нет файла ${f.path} (${p})`);
  if (sha1(p) !== f.sha1) throw new Error(`sha1 не совпадает: ${f.path}`);
}
console.log(`Сборка ${pack.version}: ${pack.files.length} файлов, проверены.`);

// ---------- что есть на Modrinth ----------
const mr = await fetch('https://api.modrinth.com/v2/version_files', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': `${REPO} (pack mirror)` },
  body: JSON.stringify({ hashes: pack.files.map((f) => f.sha1), algorithm: 'sha1' }),
});
const onModrinth = mr.ok ? await mr.json() : {};
if (!mr.ok) console.warn(`Modrinth не ответил (HTTP ${mr.status}) — все файлы пойдут в релиз.`);
const hosted = [];
for (const f of pack.files) {
  const v = onModrinth[f.sha1];
  const file = v && v.files.find((x) => x.hashes.sha1 === f.sha1);
  if (file) f.url = file.url;
  else hosted.push(f);
}
console.log(`С Modrinth (ссылкой): ${pack.files.length - hosted.length}, в релиз GitHub: ${hosted.length}`);
for (const f of hosted) console.log(`  в релиз: ${f.path} — проверьте, что лицензия разрешает распространение`);

// ---------- релиз-зеркало ----------
let assets = [];
try {
  assets = JSON.parse(gh('release', 'view', TAG, '-R', REPO, '--json', 'assets')).assets.map((a) => a.name);
} catch {
  gh('release', 'create', TAG, '-R', REPO, '--prerelease', '--target', 'main', '--title', 'Зеркало сборки BBA SMP',
    '--notes', 'Служебный релиз: копия сборки модов для лаунчера. Лаунчер берёт её отсюда, если сайт не отвечает. Скачивать вручную не нужно.');
  console.log(`Создан релиз ${TAG}.`);
}

const wanted = new Set(hosted.map(mirrorName));
const toUpload = hosted.filter((f) => !assets.includes(mirrorName(f)));
const upDir = path.join(tmp, 'upload');
fs.mkdirSync(upDir);
const batch = [];
for (const f of toUpload) {
  const dest = path.join(upDir, mirrorName(f));
  if (!fs.existsSync(dest)) fs.copyFileSync(fileOf(f), dest);
  if (!batch.includes(dest)) batch.push(dest);
}
for (let i = 0; i < batch.length; i += 10) {
  gh('release', 'upload', TAG, '-R', REPO, ...batch.slice(i, i + 10));
  console.log(`Загружено ${Math.min(i + 10, batch.length)} / ${batch.length}`);
}

const packFile = path.join(tmp, 'pack.json');
fs.writeFileSync(packFile, JSON.stringify(pack, null, 2));
gh('release', 'upload', TAG, '-R', REPO, packFile, '--clobber');

const extra = assets.filter((n) => n !== 'pack.json' && !wanted.has(n));
for (const n of extra) gh('release', 'delete-asset', TAG, n, '-R', REPO, '-y');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Готово: зеркало = сборка ${pack.version}. Новых файлов: ${batch.length}, удалено старых: ${extra.length}.`);
