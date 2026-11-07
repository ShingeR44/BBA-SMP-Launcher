'use strict';
// Загрузка файлов: проверка sha1/размера, повторы, параллельность, прогресс.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const UA = 'BBA-Launcher/1.0 (+https://bba.dimon20k.ru)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Проверяет, что файл на месте и совпадает.
 * mode: 'sha1' — полная проверка, 'size' — только размер (быстро), 'exists' — только наличие.
 */
async function fileMatches(file, { sha1, size } = {}, mode = 'sha1') {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (mode === 'exists') return true;
  if (size != null && st.size !== size) return false;
  if (mode === 'size' && size != null) return true;
  if (!sha1) return true;
  return (await sha1File(file)) === String(sha1).toLowerCase();
}

async function fetchJson(url, { signal, noCache = false, timeoutMs = 15000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(noCache ? { 'Cache-Control': 'no-cache' } : {}) },
      cache: noCache ? 'no-store' : 'default',
    });
  } catch (e) {
    if (signal && signal.aborted) throw abortError();
    if (timeout.aborted) throw new Error(`${new URL(url).host} не отвечает`);
    throw new Error(`нет соединения с ${new URL(url).host}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} при запросе ${url}`);
  return res.json();
}

const IDLE_TIMEOUT = 30000; // если данные не идут 30 секунд — переподключаемся

async function downloadFile(task, { signal, onBytes } = {}) {
  const { url, dest, sha1, sha256, size } = task;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let received = 0;
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
    let idle = setTimeout(() => ac.abort(), IDLE_TIMEOUT);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ac.abort(), IDLE_TIMEOUT);
    };
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': UA } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} — ${url}`);
      const hash = crypto.createHash('sha1');
      const hash256 = sha256 ? crypto.createHash('sha256') : null;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          bump();
          hash.update(chunk);
          if (hash256) hash256.update(chunk);
          received += chunk.length;
          if (onBytes) onBytes(chunk.length);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
      if (size != null && received !== size) {
        throw new Error(`Размер файла не совпал: ${path.basename(dest)} (${received} вместо ${size})`);
      }
      if (sha256 && hash256.digest('hex') !== String(sha256).toLowerCase()) {
        throw new Error(`Контрольная сумма не совпала: ${path.basename(dest)}`);
      }
      if (sha1 && hash.digest('hex') !== String(sha1).toLowerCase()) {
        throw new Error(`Контрольная сумма не совпала: ${path.basename(dest)}`);
      }
      await fsp.rename(tmp, dest);
      return;
    } catch (e) {
      if (onBytes && received) onBytes(-received);
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (signal && signal.aborted) throw abortError();
      lastErr = ac.signal.aborted ? new Error(`Загрузка зависла: ${path.basename(dest)}`) : e;
      if (attempt < 3) await sleep(600 * attempt);
    } finally {
      clearTimeout(idle);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }
  throw lastErr;
}

function abortError() {
  const e = new Error('Отменено');
  e.code = 'ABORTED';
  return e;
}

/** Скачивает список задач параллельно. onProgress({bytes,total,done,count}) */
async function downloadMany(tasks, { concurrency = 8, signal, onProgress } = {}) {
  const total = tasks.reduce((s, t) => s + (t.size || 0), 0);
  let bytes = 0;
  let done = 0;
  let next = 0;
  let failed = null;
  let last = 0;
  const report = (force) => {
    const now = Date.now();
    if (!onProgress || (!force && now - last < 120)) return;
    last = now;
    onProgress({ bytes, total, done, count: tasks.length });
  };
  const onBytes = (n) => {
    bytes += n;
    report(false);
  };
  async function worker() {
    while (next < tasks.length && !failed) {
      if (signal && signal.aborted) throw abortError();
      const t = tasks[next++];
      try {
        await downloadFile(t, { signal, onBytes });
      } catch (e) {
        failed = failed || e;
        throw e;
      }
      done++;
      report(false);
    }
  }
  const n = Math.max(1, Math.min(concurrency, tasks.length));
  const results = await Promise.allSettled(Array.from({ length: n }, worker));
  if (failed) throw failed;
  const rejected = results.find((r) => r.status === 'rejected');
  if (rejected) throw rejected.reason;
  report(true);
}

/** Оставляет только задачи, файлы которых отсутствуют или не совпадают. */
async function filterMissing(tasks, { concurrency = 16, onCheck } = {}) {
  const out = [];
  let i = 0;
  let checked = 0;
  async function worker() {
    while (i < tasks.length) {
      const t = tasks[i++];
      const ok = await fileMatches(t.dest, t, t.verify || 'sha1');
      if (!ok) out.push(t);
      checked++;
      if (onCheck && checked % 50 === 0) onCheck(checked, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  return out;
}

// ---------- Минимальное чтение zip (для распаковки нативных библиотек) ----------
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Повреждённый архив');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, csize, usize, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, e) {
  const lnl = buf.readUInt16LE(e.local + 26);
  const lel = buf.readUInt16LE(e.local + 28);
  const start = e.local + 30 + lnl + lel;
  const data = buf.subarray(start, start + e.csize);
  return e.method === 0 ? data : zlib.inflateRawSync(data);
}

module.exports = {
  UA,
  sha1File,
  fileMatches,
  fetchJson,
  downloadFile,
  downloadMany,
  filterMissing,
  readZipEntries,
  readZipEntry,
  abortError,
};
