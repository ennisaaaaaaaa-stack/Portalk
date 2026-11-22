// test/ws-client.mjs —— 测试端零依赖 WS 客户端（RFC 6455 自实现帧）
//
// 独立于 src/server.mjs 的实现（不 import 服务端编解码函数）——两套独立实现对账，
// 服务端帧格式的错不会被同源实现互相掩盖。收发形状：
//   const ws = await wsConnect(port, '/threads/th:xxx', { speakerId });
//   ws.send({ type:'message', ... });      // JSON 帧自动掩码
//   const ev = await ws.next(2000);        // 下一帧（超时 reject）
//   ws.events                              // 已收全部事件（断言用）
//   ws.close()                             // close 握手 + 兜底 destroy

import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// 客户端发帧（→服务端）：必掩码（RFC 6455 §5.1）
function encodeClientTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN | text
  return Buffer.concat([header, mask, masked]);
}

// 解析服务端帧（→客户端：不掩码）；不完整返回 null
function tryParseServerFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  if (buf.length < off + len) return null;
  return { fin, opcode, payload: buf.subarray(off, off + len), rest: buf.subarray(off + len) };
}

/**
 * 连一个 WS 门牌。resolve 后 client 即可收发。
 * @param {number} port
 * @param {string} pathname 如 '/threads/th:uuid'
 * @param {object} opts { speakerId, timeoutMs = 3000 }
 */
export function wsConnect(port, pathname, { speakerId, timeoutMs = 3000 } = {}) {
  const host = '127.0.0.1';
  const key = randomBytes(16).toString('base64');
  const query = speakerId ? `?speakerId=${encodeURIComponent(speakerId)}` : '';
  const request = `GET ${pathname}${query} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;

  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      reject(new Error(`ws 握手超时（${timeoutMs}ms）：${pathname}`));
      socket.destroy();
    }, timeoutMs);

    const client = {
      socket,
      events: [], // 待取队列（next() 从此出）
      log: [],    // 已收全量（append-only，断言只数不丢——collectEvents 消费面）
      closed: false,
      send: (obj) => socket.write(encodeClientTextFrame(typeof obj === 'string' ? obj : JSON.stringify(obj))),
      next: (ms = 2000) => {
        if (client.events.length > 0) return Promise.resolve(client.events.shift());
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`ws 收帧超时（${ms}ms）——队列空且无新帧`)), ms);
          waiters.push({ res, rej, t });
        });
      },
      close: () => {
        if (client.closed) return;
        client.closed = true;
        socket.write(Buffer.from([0x88, 0x00])); // close 帧（无码）
        setTimeout(() => socket.destroy(), 300).unref?.();
        socket.end();
      },
      destroy: () => {
        client.closed = true;
        socket.destroy();
      },
    };
    const waiters = [];

    const failWaiters = (err) => {
      for (const w of waiters) {
        clearTimeout(w.t);
        w.rej(err);
      }
      waiters.length = 0;
    };

    let stage = 'header';
    let buf = Buffer.alloc(0);
    let frags = null;

    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
      failWaiters(new Error(`ws socket 错误：${e.message}`));
    });
    socket.on('connect', () => socket.write(request, 'ascii'));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'header') {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString('latin1');
        buf = buf.subarray(idx + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) {
          clearTimeout(timer);
          reject(new Error(`ws 握手失败：${head.split('\r\n')[0]}`));
          socket.destroy();
          return;
        }
        // 对账 Sec-WebSocket-Accept（自算期值——服务端握手算错当场抓；base64 含 +/= 正则元字符，用等值比较不用正则）
        const expect = createHash('sha1').update(key + GUID).digest('base64');
        const got = /^sec-websocket-accept:\s*(\S+)/im.exec(head)?.[1];
        if (got !== expect) {
          clearTimeout(timer);
      reject(new Error(`Sec-WebSocket-Accept 不对（期值 ${expect}，实收 ${got}）`));
          socket.destroy();
          return;
        }
        stage = 'open';
        clearTimeout(timer);
        resolve(client);
      }
      // 帧循环（服务端不掩码；close 帧按协议收线）
      for (;;) {
        const frame = tryParseServerFrame(buf);
        if (!frame) break;
        buf = Buffer.from(frame.rest);
        if (frame.opcode === 0x8) {
          if (!client.closed) socket.write(Buffer.from([0x88, 0x00])); // echo close
          socket.end();
          failWaiters(new Error('ws 已被服务端关闭'));
          continue;
        }
        if (frame.opcode === 0x9) {
          socket.write(Buffer.concat([Buffer.from([0x8a]), Buffer.from([frame.payload.length & 0x7f]), frame.payload]));
          continue;
        }
        if (frame.opcode === 0xa) continue;
        frags = frame.fin || frags === null ? { payload: frame.payload } : { payload: Buffer.concat([frags.payload, frame.payload]) };
        if (!frame.fin) continue;
        let obj;
        try {
          obj = JSON.parse(frags.payload.toString('utf8'));
        } catch {
          obj = { type: '__raw__', text: frags.payload.toString('utf8').slice(0, 200) };
        }
        frags = null;
        client.events.push(obj);
        client.log.push(obj);
        const w = waiters.shift();
        if (w) {
          clearTimeout(w.t);
          w.res(client.events.shift());
        }
      }
    });
    socket.on('close', () => failWaiters(new Error('ws socket 已关闭')));
  });
}

/** 取下一个指定 type 的事件（跳过 presence/ready 等噪声；跳过即丢弃——严格序场景用）；超时 reject */
export async function nextOfType(ws, type, ms = 2500) {
  const deadline = Date.now() + ms;
  for (;;) {
    const ev = await ws.next(Math.max(1, deadline - Date.now()));
    if (ev.type === type) return ev;
  }
}

/**
 * 等到 log 里指定 type 的事件攒齐 n 个（只数不丢——广播类断言用：事件先到后判不丢账）。
 * 返回攒齐的那 n 个（按到达序）。
 */
export async function collectEvents(ws, type, n, ms = 2500) {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = ws.log.filter((e) => e.type === type);
    if (got.length >= n) return got.slice(0, n);
    if (Date.now() >= deadline) {
      throw new Error(`collectEvents 超时：等 ${n} 个 ${type}，实得 ${got.length}（log 尾部：${JSON.stringify(ws.log.slice(-3).map((e) => e.type))}）`);
    }
    await ws.next(Math.max(1, deadline - Date.now()));
  }
}
