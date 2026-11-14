'use strict';
// Установка Minecraft (ваниль + Fabric/Quilt/NeoForge/Forge + Java от Mojang) и сборка команды запуска.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const dl = require('./download');

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const JAVA_MANIFEST =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const LIBRARIES_URL = 'https://libraries.minecraft.net/';
const RESOURCES_URL = 'https://resources.download.minecraft.net/';

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const IS_WIN = process.platform === 'win32';

// ---------------- Правила (rules) из version.json ----------------
function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== OS_NAME) return false;
    if (rule.os.arch) {
      const a = rule.os.arch;
      if (a === 'x86' && process.arch !== 'ia32') return false;
      if (a === 'arm64' && process.arch !== 'arm64') return false;
      if ((a === 'x64' || a === 'x86_64') && process.arch !== 'x64') return false;
    }
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(os.release())) return false;
      } catch {
        /* игнорируем кривые регулярки */
      }
    }
  }
  if (rule.features) {
    for (const [k, v] of Object.entries(rule.features)) if (!!features[k] !== v) return false;
  }
  return true;
}

function allowed(rules, features = {}) {
  if (!rules || !rules.length) return true;
  let result = false;
  for (const r of rules) if (ruleMatches(r, features)) result = r.action === 'allow';
  return result;
}

// ---------------- Maven ----------------
function parseMaven(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coords.split(':');
  return { group, artifact, version, classifier, ext };
}

function mavenPath(name) {
  const m = parseMaven(name);
  return `${m.group.replace(/\./g, '/')}/${m.artifact}/${m.version}/${m.artifact}-${m.version}${
    m.classifier ? `-${m.classifier}` : ''
  }.${m.ext}`;
}

function libKey(name) {
  const m = parseMaven(name);
  return `${m.group}:${m.artifact}:${m.classifier || ''}`;
}

function libArtifact(lib) {
  if (lib.downloads && lib.downloads.artifact) {
    const a = lib.downloads.artifact;
    return { path: a.path || mavenPath(lib.name), url: a.url, sha1: a.sha1, size: a.size };
  }
  if (lib.downloads && !lib.downloads.artifact) return null; // только natives (старые версии)
  const p = mavenPath(lib.name);
  const base = (lib.url || LIBRARIES_URL).replace(/\/?$/, '/');
  return { path: p, url: base + p, sha1: lib.sha1, size: lib.size };
}

function legacyNative(lib) {
  if (!lib.natives || !lib.natives[OS_NAME]) return null;
  const cls = lib.natives[OS_NAME].replace('${arch}', process.arch === 'ia32' ? '32' : '64');
  const d = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[cls];
  if (!d) return null;
  return { path: d.path, url: d.url, sha1: d.sha1, size: d.size };
}

// ---------------- Пути ----------------
const versionDir = (root, id) => path.join(root, 'versions', id);
const versionJsonPath = (root, id) => path.join(versionDir(root, id), `${id}.json`);
const versionJarPath = (root, id) => path.join(versionDir(root, id), `${id}.jar`);

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  return JSON.parse(await fsp.readFile(p, 'utf8'));
}

async function writeJson(p, data) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(data, null, 2));
}

// ---------------- Ванильный Minecraft ----------------
async function installVanillaJson(root, mcVersion, { signal } = {}) {
  const target = versionJsonPath(root, mcVersion);
  let manifest;
  try {
    manifest = await dl.fetchJson(VERSION_MANIFEST, { signal, noCache: true });
  } catch (e) {
    if (await exists(target)) return; // офлайн — используем то, что есть
    throw new Error(`Не удалось получить список версий Mojang: ${e.message}`);
  }
  const entry = manifest.versions.find((v) => v.id === mcVersion);
  if (!entry) throw new Error(`Версия Minecraft «${mcVersion}» не найдена у Mojang`);
  if (!(await dl.fileMatches(target, { sha1: entry.sha1 }))) {
    await dl.downloadFile({ url: entry.url, dest: target, sha1: entry.sha1 }, { signal });
  }
}

/** Читает версию со всей цепочкой inheritsFrom и сливает в одну. */
async function resolveVersion(root, id) {
  const chain = [];
  let cur = id;
  while (cur) {
    const p = versionJsonPath(root, cur);
    if (!(await exists(p))) throw new Error(`Не найден профиль версии ${cur}`);
    const j = await readJson(p);
    chain.push(j);
    cur = j.inheritsFrom;
    if (chain.length > 8) throw new Error('Слишком длинная цепочка inheritsFrom');
  }
  const base = chain[chain.length - 1];
  const merged = { id, baseId: base.id, libraries: [], arguments: { game: [], jvm: [] } };

  // библиотеки: потомок важнее родителя (например, свой ASM у Fabric)
  const seen = new Set();
  for (const v of chain) {
    for (const lib of v.libraries || []) {
      const k = libKey(lib.name);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.libraries.push(lib);
    }
  }
  for (const v of [...chain].reverse()) {
    if (v.arguments && v.arguments.game) merged.arguments.game.push(...v.arguments.game);
    if (v.arguments && v.arguments.jvm) merged.arguments.jvm.push(...v.arguments.jvm);
    for (const k of ['mainClass', 'minecraftArguments', 'assetIndex', 'assets', 'downloads', 'javaVersion', 'logging', 'type']) {
      if (v[k] != null) merged[k] = v[k];
    }
  }
  return merged;
}

// ---------------- Java (рантайм от Mojang) ----------------
function javaPlatform() {
  if (IS_WIN) return process.arch === 'arm64' ? 'windows-arm64' : process.arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return process.arch === 'ia32' ? 'linux-i386' : 'linux';
}

function javaBin(dir, console = false) {
  if (IS_WIN) return path.join(dir, 'bin', console ? 'java.exe' : 'javaw.exe');
  if (process.platform === 'darwin') return path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return path.join(dir, 'bin', 'java');
}

/** Возвращает { javaw, java } — путь к Java для игры и консольная версия для установщиков. */
async function ensureJava(root, version, { customPath, repair, signal, onProgress } = {}) {
  if (customPath) {
    const consoleJava = customPath.replace(/javaw\.exe$/i, 'java.exe');
    return { javaw: customPath, java: (await exists(consoleJava)) ? consoleJava : customPath };
  }
  const component = (version.javaVersion && version.javaVersion.component) || 'jre-legacy';
  const major = (version.javaVersion && version.javaVersion.majorVersion) || 8;
  const dir = path.join(root, 'runtime', component);
  const stampPath = path.join(dir, '.bba-runtime.json');
  const result = { javaw: javaBin(dir), java: javaBin(dir, true) };

  let all;
  try {
    all = await dl.fetchJson(JAVA_MANIFEST, { signal });
  } catch (e) {
    if (await exists(result.javaw)) return result;
    throw new Error(`Не удалось получить Java ${major}: ${e.message}`);
  }
  const list = all[javaPlatform()] && all[javaPlatform()][component];
  if (!list || !list.length) {
    throw new Error(
      `Mojang не выкладывает Java ${major} (${component}) для ${javaPlatform()}. Укажите путь к Java ${major} в настройках.`
    );
  }
  const info = list[0];
  const stamp = (await exists(stampPath)) ? await readJson(stampPath).catch(() => null) : null;
  if (!repair && stamp && stamp.sha1 === info.manifest.sha1 && (await exists(result.javaw))) return result;

  const { files } = await dl.fetchJson(info.manifest.url, { signal });
  const tasks = [];
  const executables = [];
  for (const [rel, f] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    if (f.type === 'directory') await fsp.mkdir(dest, { recursive: true });
    else if (f.type === 'file' && f.downloads && f.downloads.raw) {
      const r = f.downloads.raw;
      tasks.push({ url: r.url, dest, sha1: r.sha1, size: r.size, verify: repair ? 'sha1' : 'size' });
      if (f.executable) executables.push(dest);
    }
  }
  const missing = await dl.filterMissing(tasks);
  if (missing.length) await dl.downloadMany(missing, { signal, onProgress });
  if (!IS_WIN) for (const f of executables) await fsp.chmod(f, 0o755).catch(() => {});
  await writeJson(stampPath, { sha1: info.manifest.sha1, version: info.version && info.version.name });
  return result;
}

// ---------------- Загрузчики модов ----------------
async function installFabricLike(root, mcVersion, loaderVersion, kind, { signal }) {
  const meta = kind === 'quilt' ? 'https://meta.quiltmc.org/v3' : 'https://meta.fabricmc.net/v2';
  let lv = loaderVersion;
  if (!lv || lv === 'latest') {
    const loaders = await dl.fetchJson(`${meta}/versions/loader/${encodeURIComponent(mcVersion)}`, { signal });
    if (!loaders.length) throw new Error(`${kind} пока не поддерживает Minecraft ${mcVersion}`);
    const pick = loaders.find((l) => l.loader && l.loader.stable !== false) || loaders[0];
    lv = pick.loader.version;
  }
  const id = `${kind === 'quilt' ? 'quilt-loader' : 'fabric-loader'}-${lv}-${mcVersion}`;
  const target = versionJsonPath(root, id);
  if (await exists(target)) return id;
  const profile = await dl.fetchJson(
    `${meta}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(lv)}/profile/json`,
    { signal }
  );
  profile.id = id;
  await writeJson(target, profile);
  return id;
}

async function runInstaller(javaExe, jar, argsVariants, cwd, onLog) {
  let lastCode = -1;
  let tail = '';
  for (const args of argsVariants) {
    lastCode = await new Promise((resolve) => {
      const p = spawn(javaExe, ['-jar', jar, ...args], { cwd, windowsHide: true });
      const onData = (d) => {
        const s = d.toString();
        tail = (tail + s).slice(-4000);
        if (onLog) onLog(s);
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      p.on('error', () => resolve(-1));
      p.on('close', resolve);
    });
    if (lastCode === 0) return;
  }
  throw new Error(`Установщик загрузчика завершился с ошибкой (код ${lastCode}).\n${tail.split('\n').slice(-8).join('\n')}`);
}

async function installForgeLike(root, mcVersion, loaderVersion, kind, javaExe, { signal, onLog }) {
  if (!loaderVersion) throw new Error(`Для ${kind} в pack.json нужно указать точную версию загрузчика`);
  let id;
  let url;
  let args;
  if (kind === 'neoforge') {
    id = `neoforge-${loaderVersion}`;
    url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
    args = [['--install-client', root], ['--installClient', root]];
  } else {
    const full = loaderVersion.startsWith(`${mcVersion}-`) ? loaderVersion : `${mcVersion}-${loaderVersion}`;
    id = `${mcVersion}-forge-${full.slice(mcVersion.length + 1)}`;
    url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
    args = [['--installClient', root]];
  }
  if (await exists(versionJsonPath(root, id))) return id;

  // установщикам нужен launcher_profiles.json как у официального лаунчера
  const profiles = path.join(root, 'launcher_profiles.json');
  if (!(await exists(profiles))) await writeJson(profiles, { profiles: {}, settings: {}, version: 3 });

  const jar = path.join(root, 'cache', path.basename(new URL(url).pathname));
  if (!(await exists(jar))) await dl.downloadFile({ url, dest: jar }, { signal });
  await runInstaller(javaExe, jar, args, root, onLog);
  if (!(await exists(versionJsonPath(root, id)))) {
    // имя профиля могло отличаться — ищем свежесозданный
    const dirs = await fsp.readdir(path.join(root, 'versions'));
    const found = dirs.find((d) => d.toLowerCase().includes(kind === 'neoforge' ? 'neoforge' : 'forge') && d.includes(loaderVersion));
    if (!found) throw new Error('Установщик отработал, но профиль версии не появился');
    return found;
  }
  return id;
}

/** Устанавливает загрузчик из pack.loader. Возвращает id версии для запуска. */
async function installLoader(root, pack, javaExe, opts) {
  const type = ((pack.loader && pack.loader.type) || 'vanilla').toLowerCase();
  const ver = pack.loader && pack.loader.version;
  if (type === 'vanilla') return pack.minecraft;
  if (type === 'fabric' || type === 'quilt') return installFabricLike(root, pack.minecraft, ver, type, opts);
  if (type === 'neoforge' || type === 'forge') return installForgeLike(root, pack.minecraft, ver, type, javaExe, opts);
  throw new Error(`Неизвестный загрузчик: ${type}`);
}

// ---------------- Файлы игры (jar, библиотеки, ассеты) ----------------
async function installGameFiles(root, version, { repair, signal, onProgress, onStage } = {}) {
  const tasks = [];
  const verifyLib = 'sha1';

  // клиентский jar
  const baseJar = versionJarPath(root, version.baseId);
  if (version.downloads && version.downloads.client) {
    const c = version.downloads.client;
    tasks.push({ url: c.url, dest: baseJar, sha1: c.sha1, size: c.size, verify: verifyLib });
  }

  // библиотеки
  for (const lib of version.libraries) {
    if (!allowed(lib.rules)) continue;
    const art = libArtifact(lib);
    if (art && art.url) {
      tasks.push({ url: art.url, dest: path.join(root, 'libraries', art.path), sha1: art.sha1, size: art.size, verify: art.sha1 ? verifyLib : 'exists' });
    }
    const nat = legacyNative(lib);
    if (nat) tasks.push({ url: nat.url, dest: path.join(root, 'libraries', nat.path), sha1: nat.sha1, size: nat.size, verify: verifyLib });
  }

  // индекс ассетов
  if (version.assetIndex) {
    const ai = version.assetIndex;
    const idxPath = path.join(root, 'assets', 'indexes', `${ai.id}.json`);
    if (!(await dl.fileMatches(idxPath, ai))) await dl.downloadFile({ url: ai.url, dest: idxPath, sha1: ai.sha1, size: ai.size }, { signal });
    const index = await readJson(idxPath);
    for (const { hash, size } of Object.values(index.objects || {})) {
      const rel = `${hash.slice(0, 2)}/${hash}`;
      tasks.push({ url: RESOURCES_URL + rel, dest: path.join(root, 'assets', 'objects', rel), sha1: hash, size, verify: repair ? 'sha1' : 'size' });
    }
  }

  // logging-конфиг Mojang не используем: он выводит XML для их лаунчера, а нам нужен обычный текстовый лог

  if (onStage) onStage('Проверяем файлы игры…');
  const missing = await dl.filterMissing(tasks);
  if (missing.length) {
    if (onStage) onStage(`Загружаем файлы игры (${missing.length})…`);
    await dl.downloadMany(missing, { signal, onProgress, concurrency: 12 });
  }

  // jar для модифицированной версии — копия ванильного, как делает официальный лаунчер
  if (version.id !== version.baseId) {
    const jar = versionJarPath(root, version.id);
    const [a, b] = await Promise.all([fsp.stat(baseJar).catch(() => null), fsp.stat(jar).catch(() => null)]);
    if (a && (!b || a.size !== b.size)) await fsp.copyFile(baseJar, jar);
  }
}

async function extractNatives(root, version) {
  const dir = path.join(root, 'natives', version.id);
  await fsp.mkdir(dir, { recursive: true });
  const jars = [];
  for (const lib of version.libraries) {
    if (!allowed(lib.rules)) continue;
    const nat = legacyNative(lib);
    if (nat) jars.push(path.join(root, 'libraries', nat.path));
    const m = parseMaven(lib.name);
    if (m.classifier && m.classifier.startsWith('natives-')) {
      const art = libArtifact(lib);
      if (art) jars.push(path.join(root, 'libraries', art.path));
    }
  }
  for (const jar of jars) {
    let buf;
    try {
      buf = await fsp.readFile(jar);
    } catch {
      continue;
    }
    for (const e of dl.readZipEntries(buf)) {
      if (e.name.endsWith('/') || e.name.startsWith('META-INF/')) continue;
      if (!/\.(dll|so|dylib|jnilib)$/i.test(e.name)) continue;
      const out = path.join(dir, path.basename(e.name));
      const st = await fsp.stat(out).catch(() => null);
      if (st && st.size === e.usize) continue;
      await fsp.writeFile(out, dl.readZipEntry(buf, e));
    }
  }
  return dir;
}

// ---------------- Запуск ----------------
function buildLaunchArgs(root, version, o) {
  const sep = IS_WIN ? ';' : ':';
  const nativesDir = path.join(root, 'natives', version.id);
  const cp = [];
  const seen = new Set();
  for (const lib of version.libraries) {
    if (!allowed(lib.rules)) continue;
    const art = libArtifact(lib);
    if (!art) continue;
    const p = path.join(root, 'libraries', art.path);
    if (seen.has(p)) continue;
    seen.add(p);
    cp.push(p);
  }
  cp.push(versionJarPath(root, version.id));

  // при стандартном порте передаём адрес без порта: так игра сама найдёт SRV-запись (например, у туннеля playit)
  const server = o.server && o.server.host ? (o.server.port && o.server.port !== 25565 ? `${o.server.host}:${o.server.port}` : o.server.host) : null;
  const vars = {
    auth_player_name: o.account.name,
    version_name: version.id,
    game_directory: o.gameDir,
    assets_root: path.join(root, 'assets'),
    game_assets: path.join(root, 'assets'),
    assets_index_name: version.assetIndex ? version.assetIndex.id : version.assets,
    auth_uuid: o.account.id,
    auth_access_token: o.account.accessToken,
    auth_session: o.account.accessToken,
    clientid: o.clientId || '',
    auth_xuid: o.account.xuid || '0',
    user_type: o.injector ? 'mojang' : 'msa',
    user_properties: '{}',
    version_type: o.versionType || 'BBA SMP',
    natives_directory: nativesDir,
    launcher_name: 'bba-launcher',
    launcher_version: o.launcherVersion || '1.0.0',
    classpath: cp.join(sep),
    classpath_separator: sep,
    library_directory: path.join(root, 'libraries'),
    resolution_width: String(o.width || 1280),
    resolution_height: String(o.height || 720),
    quickPlayMultiplayer: server || '',
  };
  const features = {
    is_demo_user: false,
    has_custom_resolution: !o.fullscreen && !!(o.width && o.height),
    is_quick_play_multiplayer: !!server,
  };
  const sub = (s) => s.replace(/\$\{([^}]+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  const expand = (list) => {
    const out = [];
    for (const a of list) {
      if (typeof a === 'string') out.push(sub(a));
      else if (allowed(a.rules, features)) for (const v of [].concat(a.value)) out.push(sub(v));
    }
    return out;
  };

  const jvm = [`-Xmx${o.memoryMb}M`, `-Xms${Math.min(o.memoryMb, 1024)}M`];
  // свой сервер авторизации: authlib-injector подменяет адреса Mojang на наш API
  if (o.injector) {
    jvm.push(`-javaagent:${o.injector.jar}=${o.injector.apiRoot}`);
    if (o.injector.metadata) jvm.push(`-Dauthlibinjector.yggdrasil.prefetched=${Buffer.from(o.injector.metadata).toString('base64')}`);
  }
  // Только IPv4: у некоторых адресов (например, туннеля playit) есть IPv6, и без поддержки IPv6
  // у провайдера Windows отвечает «Cannot assign requested address: getsockopt».
  // Кто прописал своё -Djava.net.prefer..., тому не мешаем.
  const userArgs = o.jvmArgs || [];
  if (!userArgs.some((a) => /^-Djava\.net\.prefer(IPv4Stack|IPv6Addresses)=/.test(a))) jvm.push('-Djava.net.preferIPv4Stack=true');
  jvm.push(...userArgs);
  if (version.arguments.jvm.length) jvm.push(...expand(version.arguments.jvm));
  else jvm.push(`-Djava.library.path=${nativesDir}`, '-cp', vars.classpath);

  const game = version.arguments.game.length
    ? expand(version.arguments.game)
    : sub(version.minecraftArguments || '').split(' ').filter(Boolean);
  if (o.fullscreen) game.push('--fullscreen');
  // старые версии без quickPlay — подключение через --server/--port
  if (server && !JSON.stringify(version.arguments.game).includes('quickPlayMultiplayer')) {
    game.push('--server', o.server.host, '--port', String(o.server.port || 25565));
  }
  return [...jvm, version.mainClass, ...game];
}

function launch(javaExe, args, { gameDir, logFile, onLog }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile);
  const child = spawn(javaExe, args, { cwd: gameDir, detached: true, windowsHide: false });
  const onData = (d) => {
    log.write(d);
    if (onLog) onLog(d.toString());
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', () => log.end());
  return child;
}

module.exports = {
  allowed,
  mavenPath,
  installVanillaJson,
  resolveVersion,
  ensureJava,
  installLoader,
  installGameFiles,
  extractNatives,
  buildLaunchArgs,
  launch,
};
