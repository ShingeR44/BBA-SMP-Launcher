'use strict';
// Пинг сервера по протоколу Server List Ping (как в списке серверов в игре).
const net = require('net');
const dns = require('dns').promises;

function varint(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: result, size: pos - offset };
    shift += 7;
    if (shift > 35) throw new Error('VarInt слишком длинный');
  }
}

const packet = (id, payload) => {
  const body = Buffer.concat([varint(id), payload]);
  return Buffer.concat([varint(body.length), body]);
};

async function resolveSrv(host, port) {
  if (net.isIP(host) || port !== 25565) return { host, port };
  try {
    const [srv] = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (srv) return { host: srv.name, port: srv.port };
  } catch {
    /* SRV нет — подключаемся напрямую */
  }
  return { host, port };
}

function flattenMotd(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.replace(/§./g, '');
  let s = d.text || '';
  for (const e of d.extra || []) s += flattenMotd(e);
  return s.replace(/§./g, '');
}

async function ping(hostIn, portIn = 25565, timeoutMs = 5000) {
  const { host, port } = await resolveSrv(hostIn, portIn);
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let finished = false;
    const finish = (res) => {
      if (finished) return;
      finished = true;
      sock.destroy();
      resolve(res);
    };
    sock.setTimeout(timeoutMs, () => finish({ online: false, error: 'timeout' }));
    sock.on('error', (e) => finish({ online: false, error: e.code || e.message }));
    sock.on('connect', () => {
      const hostBuf = Buffer.from(hostIn, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(portIn);
      sock.write(packet(0x00, Buffer.concat([varint(767), varint(hostBuf.length), hostBuf, portBuf, varint(1)])));
      sock.write(packet(0x00, Buffer.alloc(0)));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        let off = len.size;
        const id = readVarint(buf, off);
        off += id.size;
        const strLen = readVarint(buf, off);
        off += strLen.size;
        const json = JSON.parse(buf.toString('utf8', off, off + strLen.value));
        finish({
          online: true,
          latency: Date.now() - started,
          players: { online: (json.players && json.players.online) || 0, max: (json.players && json.players.max) || 0 },
          version: json.version && json.version.name,
          motd: flattenMotd(json.description),
        });
      } catch (e) {
        finish({ online: false, error: e.message });
      }
    });
  });
}

module.exports = { ping };
