'use strict';
// Настройки игры, которые лаунчер выставляет перед каждым запуском:
// - ресурспаки сборки всегда включены (options.txt → resourcePacks);
// - ресурспаки с серверов BBA принимаются без вопроса (servers.dat → acceptTextures).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---------- Ресурспаки сборки ----------

/** Ресурспаки сборки, которые уже лежат в папке игры: ['file/x.zip', 'file/папка', …] */
function packResourcePacks(pack, gameDir) {
  const out = [];
  const seen = new Set();
  for (const f of (pack && pack.files) || []) {
    const parts = String(f.path).split('/');
    if (parts[0] !== 'resourcepacks' || parts.length < 2) continue;
    const name = parts[1];
    // zip-файл прямо в resourcepacks/ или папка-ресурспак (resourcepacks/<папка>/pack.mcmeta)
    if (parts.length === 2 ? !/\.zip$/i.test(name) : parts.length !== 3 || parts[2] !== 'pack.mcmeta') continue;
    if (seen.has(name.toLowerCase())) continue;
    if (!fs.existsSync(path.join(gameDir, 'resourcepacks', name))) continue;
    seen.add(name.toLowerCase());
    out.push(`file/${name}`);
  }
  return out;
}

// Gson в Minecraft экранирует эти символы — пишем так же, чтобы не менять чужие строки
const gsonJson = (arr) => JSON.stringify(arr).replace(/[<>&=']/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function parseList(line) {
  try {
    const v = JSON.parse(line);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * Включает ресурспаки сборки в options.txt. Уже включённые остаются на своём месте,
 * недостающие добавляются наверх (последними в списке — у них выше приоритет).
 * Пак записывается и в incompatibleResourcePacks: тогда игра не выключит его,
 * даже если в pack.mcmeta указана другая версия игры.
 */
async function enforceResourcePacks(gameDir, required) {
  if (!required.length) return { added: [] };
  const file = path.join(gameDir, 'options.txt');
  let text = null;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    /* первый запуск — options.txt ещё нет */
  }
  const lines = text == null ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const idx = (key) => lines.findIndex((l) => l.startsWith(`${key}:`));

  const iSel = idx('resourcePacks');
  const selected = (iSel >= 0 && parseList(lines[iSel].slice('resourcePacks:'.length))) || (iSel >= 0 ? null : ['vanilla']);
  if (!selected) return { added: [], error: 'не удалось прочитать resourcePacks в options.txt' };
  const has = (list, id) => list.some((x) => x.toLowerCase() === id.toLowerCase());
  const added = required.filter((id) => !has(selected, id));
  selected.push(...added);

  const iInc = idx('incompatibleResourcePacks');
  const incompatible = (iInc >= 0 && parseList(lines[iInc].slice('incompatibleResourcePacks:'.length))) || [];
  const incAdded = required.filter((id) => !has(incompatible, id));
  incompatible.push(...incAdded);

  if (!added.length && !incAdded.length && iSel >= 0 && iInc >= 0) return { added: [] };
  const set = (i, key, list) => {
    const line = `${key}:${gsonJson(list)}`;
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  };
  set(iSel, 'resourcePacks', selected);
  set(idx('incompatibleResourcePacks'), 'incompatibleResourcePacks', incompatible);

  await fsp.mkdir(gameDir, { recursive: true });
  const tmp = `${file}.bba-tmp`;
  await fsp.writeFile(tmp, lines.join('\n') + '\n');
  await fsp.rename(tmp, file);
  return { added };
}

// ---------- servers.dat (NBT без сжатия) ----------
// Строки в NBT — «modified UTF-8» Java: \0 пишется двумя байтами, символы вне BMP — суррогатными парами.

function mutf8Decode(buf) {
  let s = '';
  for (let i = 0; i < buf.length; ) {
    const a = buf[i++];
    if (a < 0x80) s += String.fromCharCode(a);
    else if ((a & 0xe0) === 0xc0) s += String.fromCharCode(((a & 0x1f) << 6) | (buf[i++] & 0x3f));
    else {
      const b = buf[i++];
      const c = buf[i++];
      s += String.fromCharCode(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f));
    }
  }
  return s;
}

function mutf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 1 && c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(out);
}

const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

// Значения храним как { t: тип, v: значение }; у списка ещё et — тип элементов; у compound v — массив [имя, значение]
function readNbt(buf) {
  let o = 0;
  const str = () => {
    const n = buf.readUInt16BE(o);
    o += 2;
    const s = mutf8Decode(buf.subarray(o, o + n));
    o += n;
    return s;
  };
  const payload = (t) => {
    switch (t) {
      case T.BYTE: return { t, v: buf.readInt8(o++) };
      case T.SHORT: { const v = buf.readInt16BE(o); o += 2; return { t, v }; }
      case T.INT: { const v = buf.readInt32BE(o); o += 4; return { t, v }; }
      case T.LONG: { const v = buf.readBigInt64BE(o); o += 8; return { t, v }; }
      case T.FLOAT: { const v = buf.readFloatBE(o); o += 4; return { t, v }; }
      case T.DOUBLE: { const v = buf.readDoubleBE(o); o += 8; return { t, v }; }
      case T.BYTE_ARRAY: { const n = buf.readInt32BE(o); o += 4; const v = Buffer.from(buf.subarray(o, o + n)); o += n; return { t, v }; }
      case T.STRING: return { t, v: str() };
      case T.LIST: {
        const et = buf.readUInt8(o++);
        const n = buf.readInt32BE(o);
        o += 4;
        const v = [];
        for (let i = 0; i < n; i++) v.push(payload(et));
        return { t, et, v };
      }
      case T.COMPOUND: {
        const v = [];
        for (;;) {
          const ct = buf.readUInt8(o++);
          if (ct === T.END) break;
          const name = str();
          v.push([name, payload(ct)]);
        }
        return { t, v };
      }
      case T.INT_ARRAY: case T.LONG_ARRAY: {
        const n = buf.readInt32BE(o);
        o += 4;
        const w = t === T.INT_ARRAY ? 4 : 8;
        const v = Buffer.from(buf.subarray(o, o + n * w));
        o += n * w;
        return { t, v, n };
      }
      default: throw new Error(`неизвестный тег NBT ${t}`);
    }
  };
  const t = buf.readUInt8(o++);
  if (t !== T.COMPOUND) throw new Error('servers.dat: корень не compound');
  const name = str();
  return { name, root: payload(t) };
}

function writeNbt({ name, root }) {
  const parts = [];
  const u8 = (n) => parts.push(Buffer.from([n]));
  const str = (s) => {
    const b = mutf8Encode(s);
    const h = Buffer.alloc(2);
    h.writeUInt16BE(b.length);
    parts.push(h, b);
  };
  const num = (fn, size, v) => {
    const b = Buffer.alloc(size);
    b[fn](v);
    parts.push(b);
  };
  const payload = (x) => {
    switch (x.t) {
      case T.BYTE: return num('writeInt8', 1, x.v);
      case T.SHORT: return num('writeInt16BE', 2, x.v);
      case T.INT: return num('writeInt32BE', 4, x.v);
      case T.LONG: return num('writeBigInt64BE', 8, x.v);
      case T.FLOAT: return num('writeFloatBE', 4, x.v);
      case T.DOUBLE: return num('writeDoubleBE', 8, x.v);
      case T.BYTE_ARRAY: num('writeInt32BE', 4, x.v.length); return parts.push(x.v);
      case T.STRING: return str(x.v);
      case T.LIST: u8(x.v.length ? x.et : T.END); num('writeInt32BE', 4, x.v.length); return x.v.forEach(payload);
      case T.COMPOUND:
        for (const [n, c] of x.v) {
          u8(c.t);
          str(n);
          payload(c);
        }
        return u8(T.END);
      case T.INT_ARRAY: case T.LONG_ARRAY: num('writeInt32BE', 4, x.n); return parts.push(x.v);
      default: throw new Error(`неизвестный тег NBT ${x.t}`);
    }
  };
  u8(T.COMPOUND);
  str(name);
  payload(root);
  return Buffer.concat(parts);
}

const field = (c, key) => {
  const e = c.v.find(([n]) => n === key);
  return e ? e[1] : null;
};
const setField = (c, key, val) => {
  const e = c.v.find(([n]) => n === key);
  if (e) e[1] = val;
  else c.v.push([key, val]);
};

/** Адрес так, как его передаёт quickPlay (и как игра ищет сервер в servers.dat) */
const serverIp = (s) => (s.port && Number(s.port) !== 25565 ? `${s.host}:${s.port}` : s.host);

/**
 * Для всех адресов BBA ставит «Ресурспаки сервера: Включены», чтобы игра не спрашивала.
 * Адресов, которых нет в списке игрока, добавляет скрытыми — так же делает сама игра при quickPlay.
 */
async function acceptServerPacks(gameDir, servers, serverName = 'BBA SMP') {
  const file = path.join(gameDir, 'servers.dat');
  let nbt;
  try {
    nbt = readNbt(await fsp.readFile(file));
  } catch (e) {
    if (e.code !== 'ENOENT') return { changed: 0, error: `servers.dat: ${e.message}` }; // чужой формат — не трогаем
    nbt = { name: '', root: { t: T.COMPOUND, v: [] } };
  }
  let list = field(nbt.root, 'servers');
  if (!list || list.t !== T.LIST) {
    list = { t: T.LIST, et: T.COMPOUND, v: [] };
    setField(nbt.root, 'servers', list);
  }
  if (list.v.length && list.et !== T.COMPOUND) return { changed: 0, error: 'servers.dat: неожиданный формат списка' };
  list.et = T.COMPOUND;

  let changed = 0;
  for (const s of servers) {
    const ip = serverIp(s).toLowerCase();
    const found = list.v.filter((c) => {
      const f = field(c, 'ip');
      return f && f.t === T.STRING && f.v.trim().toLowerCase() === ip;
    });
    if (!found.length) {
      list.v.push({
        t: T.COMPOUND,
        v: [
          ['hidden', { t: T.BYTE, v: 1 }],
          ['ip', { t: T.STRING, v: serverIp(s) }],
          ['name', { t: T.STRING, v: s.name ? `${serverName} — ${s.name}` : serverName }],
          ['acceptTextures', { t: T.BYTE, v: 1 }],
        ],
      });
      changed++;
      continue;
    }
    for (const c of found) {
      const a = field(c, 'acceptTextures');
      if (a && a.t === T.BYTE && a.v === 1) continue;
      setField(c, 'acceptTextures', { t: T.BYTE, v: 1 });
      changed++;
    }
  }
  if (!changed) return { changed };
  await fsp.mkdir(gameDir, { recursive: true });
  const tmp = `${file}.bba-tmp`;
  await fsp.writeFile(tmp, writeNbt(nbt));
  await fsp.rename(tmp, file);
  return { changed };
}

module.exports = { packResourcePacks, enforceResourcePacks, acceptServerPacks, readNbt, writeNbt };
