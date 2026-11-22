// src/server.mjs —— Portalk Server（P2 接线测试层·施工单 A）
//
// HTTP 面（node:http，零 npm 依赖——家规）：
//   GET  /api/health                → {ok:true}
//   GET  /api/threads               → listThreads（query: includeArchived/type）
//   POST /api/threads               → createThread（body: type/title/createdBy/memberIds/projectIds）
//   GET  /api/threads/:id           → getThread
//   GET  /api/threads/:id/messages  → listThreadMessages（query: since=<lastSeq> 断线补拉——蓝图判据 3）
//   POST /api/threads/:id/messages  → appendMessage + 广播（body: session_id/speaker_id/role/content）
//   POST /api/threads/:id/pin|unpin → 消息路由意图操作（pin 三态入口，见 src/router.mjs）
//   GET  /api/threads/:id/export    → {file, markdown}：markdown 正文 + 落盘路径
//                                     （消费 threads.mjs exportThread 渲染消息正文，本层只加
//                                      frontmatter 四字段信封：日期/参与者/主题/关联项目——判据 6）
//   GET  /api/search                → 消息全文搜索（query: q/from/to/thread_id；LIKE 实现，
//                                     搜索面吃消息全文不止标题——判据 6）
//   GET  /api/tree                   → 心跳树快照（opts.tree 注入 createHeartbeatTree 产物；
//                                     HTTP 轮询面——WS 推送面 opts.tree 自带 onChange 走 broadcastAll）
//
// WebSocket 面（RFC 6455 自实现，不引库——零 npm 依赖家规）：
//   ws://server/threads/:id?speakerId=…   前端窗口 ↔ thread 一一对应（蓝图判据 1）
//   客户端发 {type:'message', threadId, sessionId, speakerId, role, content[, pinState]}
//     → 路由器处理（进 thread 库 + 转发给该 thread 所有连接客户端）
//   服务端推 {type:'ready'|'message'|'presence'|'pin-state'|'approval'|'shell-fault'|'error'}
//   断线重连不丢（判据 3）：重连后 GET /api/threads/:id/messages?since=<lastSeq> 补拉
//
// 错误形状：426（/threads/:id 无 Upgrade 头——长连走 WS，HTTP 摸门先升级）/ 400（JSON 解析、
// 形状校验）/ 404（未知路由、thread 不存在）/ 500（兜底）。CORS 本单不做（桌面前端同源）。
//
// 【接缝】EP 转发注入点：epForward 缺省=router.mjs 的 epForwardStub（未接线 throw 不算错），
// 后续单换真身接 acp-adapter 的 prompt——本单 Server 对 adapter 只做接口预留，不改造。

import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  getThread,
  listThreads,
  createThread,
  listThreadMessages,
  listThreadMembers,
  appendMessage,
  exportThread,
} from './threads.mjs';
import { routeMessage, appendSystemMessage, epForwardStub } from './router.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BODY = 5 * 1024 * 1024; // HTTP body 上限 5MB（桌面消息面够用，防爆内存）
const MAX_FRAME = 16 * 1024 * 1024; // 单帧上限 16MB（分片累计同此限）

// ---------------------------------------------------------------------------
// RFC 6455 帧编解码（服务端实现：收帧必掩码校验，发帧不掩码；16/64 位长度；ping/pong/close）
// ---------------------------------------------------------------------------

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN=1（本层不主动分片）
  return Buffer.concat([header, payload]);
}

function encodeCloseFrame(code = 1000, reason = '') {
  return encodeFrame(0x8, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason, 'utf8')]));
}

/**
 * 从 buf 头部解析一个完整帧；不完整返回 null。协议违规 throw（带 wsClose 码）。
 * 返回 { fin, opcode, payload, rest }——rest 是剩余字节（可能含后续帧）。
 */
function tryParseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME)) {
      throw Object.assign(new Error(`帧超上限 ${MAX_FRAME}`), { wsClose: 1009 });
    }
    len = Number(big);
    off = 10;
  }
  if (len > MAX_FRAME) throw Object.assign(new Error(`帧超上限 ${MAX_FRAME}`), { wsClose: 1009 });
  if (!masked) throw Object.assign(new Error('客户端帧必须掩码（RFC 6455 §5.1）'), { wsClose: 1002 });
  if (buf.length < off + 4 + len) return null;
  const mask = buf.subarray(off, off + 4);
  const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, rest: buf.subarray(off + 4 + len) };
}

// ---------------------------------------------------------------------------
// HTTP 小件
// ---------------------------------------------------------------------------

function sendJson(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function rawHttp(socket, code, text, extraHeaders = {}) {
  const heads = Object.entries(extraHeaders)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  socket.write(`HTTP/1.1 ${code} ${http.STATUS_CODES[code] ?? 'Status'}\r\nContent-Type: application/json; charset=utf-8\r\n${heads}${heads ? '\r\n' : ''}Connection: close\r\n\r\n${text}`);
  socket.destroy();
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error(`body 超 ${MAX_BODY} 上限`), { statusCode: 400 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({}); // 空 body（pin/unpin 这类无载荷端点）按 {} 走
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('body 须是 JSON 对象'), { statusCode: 400 }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('body 不是合法 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', (e) => reject(Object.assign(e, { statusCode: 400 })));
  });
}

// 路由/校验错 → HTTP 码映射：thread 不存在族 404，其余形状错 400
function apiErrorToStatus(err) {
  return /不存在/.test(err?.message ?? '') ? 404 : 400;
}

// LIKE 转义：% _ \ 三件（搜索面吃全文，通配符当字面量）
function escapeLike(q) {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// 日期界归一：纯日期补头/尾（from→当日零点，to→当日末刻），完整 ISO 原样（字典序可比）
function normalizeBound(s, end) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return end ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`;
  return s;
}

// role 归一（蓝图判据 2 的三类 + HTTP/WS 面对 human 别名的收口）：human→user；非法 → null
function normalizeRole(raw) {
  if (raw === 'human' || raw === 'user') return 'user';
  if (raw === 'agent') return 'agent';
  if (raw === 'system') return 'system';
  return null;
}

// ---------------------------------------------------------------------------
// Server 本体
// ---------------------------------------------------------------------------

/**
 * 建 Portalk Server。
 *
 * @param {object} opts
 *   db                  DatabaseSync（openDb 产物）——必填（调用方持有 close 权）
 *   port = 0            监听端口（0=ephemeral，测试用）
 *   host = '127.0.0.1'  监听地址（桌面单机面，不出网）
 *   exportDir           导出落盘目录（缺省 data/exports，透传 threads.mjs exportThread）
 *   epForward           EP 转发注入点（缺省 router.mjs epForwardStub——本单未接线）
 * @returns {{ httpServer, pinStates, start, close, broadcast, connections }}
 */
export function createPortalkServer(opts = {}) {
  const { db, host = '127.0.0.1', port = 0, exportDir = 'data/exports' } = opts;
  if (!db) throw new Error('createPortalkServer 需 db（openDb 产物）');
  const epForward = opts.epForward ?? epForwardStub;

  const pinStates = opts.pinStates ?? new Map(); // threadId → 'pinned'|'unpinned'（消息路由意图）
  const conns = new Map(); // threadId → Set<conn>（前端窗口 ↔ thread 一一对应的连接账）
  const tree = opts.tree ?? null; // 心跳树数据面（判据 5；不注入则 /api/tree 出声 404）

  const lastSeqOf = (threadId) =>
    (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE thread_id = ?').get(threadId)?.m ?? 0);

  const broadcast = (threadId, obj) => {
    const set = conns.get(threadId);
    if (!set) return;
    for (const c of set) c.send(obj);
  };

  // 树是全局面（agent 活动跨窗口）：WS 推送面向所有活动连接，不挑 thread 门牌
  const broadcastAll = (obj) => {
    for (const set of conns.values()) for (const c of set) c.send(obj);
  };

  const broadcastPresence = (threadId) => {
    const set = conns.get(threadId);
    if (!set) return;
    const members = [...new Set([...set].map((c) => c.speakerId).filter(Boolean))].sort();
    broadcast(threadId, { type: 'presence', threadId, members, connections: set.size });
  };

  // —— 导出：消费 exportThread 的消息正文渲染（不重写），本层只加 frontmatter 四字段信封 ——
  function exportThreadMarkdown(threadId) {
    const t = getThread(db, threadId);
    if (!t) throw new Error(`thread 不存在：${threadId}`);
    const file = exportThread(db, threadId, exportDir); // 正文渲染 + 落盘（既有唯一口）
    const body = fs.readFileSync(file, 'utf8');
    const members = listThreadMembers(db, threadId).map((m) => m.member_id);
    const projects = db
      .prepare('SELECT project_id FROM thread_projects WHERE thread_id = ? ORDER BY project_id')
      .all(threadId)
      .map((r) => r.project_id);
    const msgs = listThreadMessages(db, threadId);
    // 日期=对话跨度（首末消息日期；空窗回落建窗日——没说过话的窗只有生辰可记）
    const times = (msgs.length ? msgs.map((m) => m.created_at) : [t.created_at]).sort();
    const dateSpan = msgs.length === 0 ? times[0].slice(0, 10) : `${times[0].slice(0, 10)} ~ ${times.at(-1).slice(0, 10)}`;
    // 主题回落规则（蓝图 11-18 甜心）：优先 title，空着回落首条消息摘要，允许一路空到底——规则级不花 LLM
    const subject = t.title ?? (msgs[0] ? msgs[0].content.slice(0, 30) : '');
    const fm = [
      '---',
      `日期: ${JSON.stringify(dateSpan)}`,
      `参与者: ${JSON.stringify(members.join(', '))}`,
      `主题: ${JSON.stringify(subject)}`,
      `关联项目: ${JSON.stringify(projects.join(', '))}`,
      '---',
      '',
    ].join('\n');
    const markdown = fm + body;
    fs.writeFileSync(file, markdown, 'utf8'); // 盘上同一份带 frontmatter（导出文件即最终件）
    return { file, markdown };
  }

  // —— 消息全文搜索（LIKE；日期界/thread 过滤；吃正文不止标题） ——
  function searchMessages({ q, from, to, threadId }) {
    let sql =
      "SELECT m.*, t.title AS thread_title FROM messages m LEFT JOIN threads t ON t.id = m.thread_id WHERE m.content LIKE ? ESCAPE '\\'";
    const params = [`%${escapeLike(q)}%`];
    if (from) {
      sql += ' AND m.created_at >= ?';
      params.push(normalizeBound(from, false));
    }
    if (to) {
      sql += ' AND m.created_at <= ?';
      params.push(normalizeBound(to, true));
    }
    if (threadId) {
      sql += ' AND m.thread_id = ?';
      params.push(threadId);
    }
    sql += ' ORDER BY m.created_at, m.rowid LIMIT 1000';
    return db.prepare(sql).all(...params);
  }

  // ---------------------------------------------------------------------------
  // WebSocket 面
  // ---------------------------------------------------------------------------

  function acceptWebSocket(req, socket, head, threadId, speakerId) {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n',
      'ascii',
    );

    const conn = {
      threadId,
      speakerId: speakerId || null,
      socket,
      alive: true,
      send: (obj) => {
        if (!conn.alive || socket.destroyed) return;
        socket.write(encodeFrame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')));
      },
    };
    if (!conns.has(threadId)) conns.set(threadId, new Set());
    conns.get(threadId).add(conn);

    // 首帧：窗口对上号（watermark + 当前路由态），重连方据此定补拉起点
    conn.send({ type: 'ready', threadId, lastSeq: lastSeqOf(threadId), pinState: pinStates.get(threadId) ?? 'unpinned' });
    broadcastPresence(threadId);

    const cleanup = () => {
      if (!conn.alive) return;
      conn.alive = false;
      const set = conns.get(threadId);
      if (set) {
        set.delete(conn);
        if (set.size === 0) conns.delete(threadId);
      }
      broadcastPresence(threadId);
    };

    const wsClose = (code, reason) => {
      if (!conn.alive || socket.destroyed) return;
      try {
        socket.write(encodeCloseFrame(code, reason));
      } catch {
        /* 对端已走：清账即可 */
      }
      socket.end();
      cleanup();
    };

    // 分片累计（本层不主动分片，但对端分片照收）
    let buf = Buffer.from(head ?? []);
    let frags = null;
    const deliver = ({ opcode, payload }) => {
      const text = payload.toString('utf8');
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        conn.send({ type: 'error', code: 'bad-json', message: '帧不是合法 JSON' });
        return;
      }
      handleWsFrame(conn, body);
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        let frame;
        try {
          frame = tryParseFrame(buf);
        } catch (e) {
          wsClose(e.wsClose ?? 1008, e.message);
          return;
        }
        if (!frame) break;
        buf = Buffer.from(frame.rest);
        if (frame.opcode === 0x8) {
          // 对端 close：回 echo（同码）后收线
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
          if (conn.alive && !socket.destroyed) socket.write(encodeCloseFrame(code));
          socket.end();
          cleanup();
          return;
        }
        if (frame.opcode === 0x9) {
          // ping → pong（同载荷）
          if (conn.alive && !socket.destroyed) socket.write(encodeFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode === 0xa) continue; // pong：本层不主动 ping，忽略
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          frags = { opcode: frame.opcode, payload: frame.payload };
          if (frame.fin) {
            deliver(frags);
            frags = null;
          }
        } else if (frame.opcode === 0x0) {
          if (!frags) return wsClose(1002, 'continuation 帧无起点');
          frags.payload = Buffer.concat([frags.payload, frame.payload]);
          if (frags.payload.length > MAX_FRAME) return wsClose(1009, '分片累计超上限');
          if (frame.fin) {
            deliver(frags);
            frags = null;
          }
        } else {
          return wsClose(1002, `不支持的 opcode：${frame.opcode}`);
        }
      }
    });
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  function handleWsFrame(conn, body) {
    if (!body || typeof body !== 'object' || body.type !== 'message') {
      conn.send({ type: 'error', code: 'unknown-frame', message: `只收 {type:'message', ...}，收到：${JSON.stringify(body)?.slice(0, 120)}` });
      return;
    }
    const { threadId, sessionId, speakerId, role: rawRole, content, pinState } = body;
    if (threadId !== conn.threadId) {
      conn.send({ type: 'error', code: 'thread-mismatch', message: `本连接只服务 ${conn.threadId}（窗口 ↔ thread 一一对应），拒发 ${threadId}` });
      return;
    }
    const role = normalizeRole(rawRole);
    if (!role) {
      conn.send({ type: 'error', code: 'bad-role', message: `role 须 human|user|agent|system，收到：${JSON.stringify(rawRole)}` });
      return;
    }
    try {
      if (role === 'system') {
        // 系统类消息：路由层直写 + 广播（不走路由三态——无壳可 pin）
        const msg = appendSystemMessage(db, { thread_id: threadId, session_id: sessionId, content });
        broadcast(threadId, { type: 'message', ...msg });
        return;
      }
      // 消息级 pinState（如 shell-fault 故障上报）优先，否则吃 thread 级路由意图（pin/unpin 端点落账）
      const state = pinState ?? pinStates.get(threadId) ?? 'unpinned';
      routeMessage(db, { threadId, speakerId, session_id: sessionId, role, content, pinState: state }, { emit: (ev) => broadcast(threadId, ev), epForward });
    } catch (e) {
      // 未接线 stub throw 'not wired in this slice' 落这里——消息已进库已广播，出声给发送端
      conn.send({ type: 'error', code: 'route-failed', message: e?.message ?? String(e) });
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP 面
  // ---------------------------------------------------------------------------

  const httpServer = http.createServer((req, res) => {
    handleHttpRequest(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, e?.statusCode ?? (/不存在/.test(e?.message ?? '') ? 404 : 500), { error: e?.message ?? String(e) });
    });
  });

  async function handleHttpRequest(req, res) {
    let u;
    try {
      u = new URL(req.url, 'http://portalk.local');
    } catch {
      return sendJson(res, 400, { error: 'URL 不合法' });
    }
    let parts;
    try {
      parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return sendJson(res, 400, { error: '路径段不合法（百分号编码坏件）' });
    }
    const method = req.method;

    // —— WS 门牌的 HTTP 摸门：不带 Upgrade 头 → 426（长连走 WS，先升级） ——
    if (parts[0] === 'threads' && parts.length === 2) {
      if (method !== 'GET') return sendJson(res, 400, { error: 'thread 长连门牌只收 GET（WebSocket 升级）' });
      return sendJson(
        res,
        426,
        { error: '此门牌是 WebSocket 长连（前端窗口 ↔ thread 一一对应），HTTP 请走 /api/*', upgrade: 'websocket' },
        { Upgrade: 'websocket' }, // RFC 9110：426 须携带 Upgrade 头指明要升的协议
      );
    }

    if (parts[0] !== 'api') return sendJson(res, 404, { error: `未知路由：${method} ${u.pathname}` });

    // —— /api/health ——
    if (parts.length === 2 && parts[1] === 'health' && method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }

    // —— /api/threads（列表/新建） ——
    if (parts.length === 2 && parts[1] === 'threads') {
      if (method === 'GET') {
        const qp = u.searchParams;
        const truthy = (v) => v === 'true' || v === '1';
        return sendJson(res, 200, { threads: listThreads(db, { includeArchived: truthy(qp.get('includeArchived')), type: qp.get('type') ?? undefined }) });
      }
      if (method === 'POST') {
        const body = await readBodyJson(req);
        try {
          return sendJson(res, 201, { thread: createThread(db, body) });
        } catch (e) {
          return sendJson(res, apiErrorToStatus(e), { error: e.message });
        }
      }
      return sendJson(res, 404, { error: `未知路由：${method} ${u.pathname}` });
    }

    // —— /api/threads/:id/... ——
    if (parts.length >= 3 && parts[1] === 'threads') {
      const id = parts[2];
      const sub = parts[3];

      if (parts.length === 3 && method === 'GET') {
        const t = getThread(db, id);
        if (!t) return sendJson(res, 404, { error: `thread 不存在：${id}` });
        return sendJson(res, 200, { thread: t });
      }

      if (sub === 'messages' && parts.length === 4) {
        if (method === 'GET') {
          const t = getThread(db, id);
          if (!t) return sendJson(res, 404, { error: `thread 不存在：${id}` });
          const sinceRaw = u.searchParams.get('since');
          let since = null;
          if (sinceRaw !== null) {
            since = Number(sinceRaw);
            if (!Number.isInteger(since) || since < 0) return sendJson(res, 400, { error: `since 须是非负整数，收到：${JSON.stringify(sinceRaw)}` });
          }
          const all = listThreadMessages(db, id);
          const messages = since === null ? all : all.filter((m) => (m.seq ?? 0) > since); // 旧消息无 seq 按 0（补拉闸兼容）
          return sendJson(res, 200, { threadId: id, since, lastSeq: all.length ? (all.at(-1).seq ?? 0) : 0, messages });
        }
        if (method === 'POST') {
          const body = await readBodyJson(req);
          const role = normalizeRole(body.role);
          if (!role) return sendJson(res, 400, { error: `role 须 human|user|agent|system，收到：${JSON.stringify(body.role)}` });
          try {
            let msg;
            if (role === 'system') {
              msg = appendSystemMessage(db, { thread_id: id, session_id: body.session_id, content: body.content });
            } else {
              msg = appendMessage(db, { thread_id: id, session_id: body.session_id, speaker_id: body.speaker_id, role, content: body.content });
            }
            broadcast(id, { type: 'message', ...msg }); // HTTP 发话也进长连广播面（两类进话口同一出话面）
            return sendJson(res, 201, { message: msg });
          } catch (e) {
            return sendJson(res, apiErrorToStatus(e), { error: e.message });
          }
        }
      }

      if ((sub === 'pin' || sub === 'unpin') && parts.length === 4 && method === 'POST') {
        await readBodyJson(req); // 无载荷端点；坏 JSON 也按 400 出声（与全局一致）
        const t = getThread(db, id);
        if (!t) return sendJson(res, 404, { error: `thread 不存在：${id}` });
        const state = sub === 'pin' ? 'pinned' : 'unpinned';
        pinStates.set(id, state);
        broadcast(id, { type: 'pin-state', threadId: id, pinState: state });
        return sendJson(res, 200, { ok: true, threadId: id, pinState: state });
      }

      if (sub === 'export' && parts.length === 4 && method === 'GET') {
        try {
          return sendJson(res, 200, { threadId: id, ...exportThreadMarkdown(id) });
        } catch (e) {
          return sendJson(res, apiErrorToStatus(e), { error: e.message });
        }
      }
      return sendJson(res, 404, { error: `未知路由：${method} ${u.pathname}` });
    }

    // —— /api/tree（心跳树快照：HTTP 轮询面；WS 推送面走 tree 的 onChange→broadcastAll） ——
    if (parts.length === 2 && parts[1] === 'tree' && method === 'GET') {
      if (!tree) return sendJson(res, 404, { error: '心跳树未注入（opts.tree）——本面不世' });
      return sendJson(res, 200, { tree: tree.snapshot() });
    }

    // —— /api/search ——
    if (parts.length === 2 && parts[1] === 'search' && method === 'GET') {
      const qp = u.searchParams;
      const q = qp.get('q');
      if (!q) return sendJson(res, 400, { error: 'q 必填（关键词全文搜索）' });
      const results = searchMessages({ q, from: qp.get('from'), to: qp.get('to'), threadId: qp.get('thread_id') });
      return sendJson(res, 200, { q, results, count: results.length });
    }

    return sendJson(res, 404, { error: `未知路由：${method} ${u.pathname}` });
  }

  // —— upgrade 事件：WS 握手门（非 thread 门牌 / 版本不对 / thread 不存在 → 原生 HTTP 错） ——
  httpServer.on('upgrade', (req, socket, head) => {
    let u;
    try {
      u = new URL(req.url, 'http://portalk.local');
    } catch {
      return rawHttp(socket, 400, JSON.stringify({ error: 'URL 不合法' }));
    }
    let parts;
    try {
      parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return rawHttp(socket, 400, JSON.stringify({ error: '路径段不合法' }));
    }
    const isThreadDoor = parts.length === 2 && parts[0] === 'threads';
    if (!isThreadDoor) return rawHttp(socket, 404, JSON.stringify({ error: `未知长连门牌：${u.pathname}` }));
    const version = req.headers['sec-websocket-version'];
    const key = req.headers['sec-websocket-key'];
    const wantsWs = req.headers.upgrade?.toLowerCase() === 'websocket';
    if (!wantsWs || version !== '13' || !key) {
      return rawHttp(socket, 426, JSON.stringify({ error: '长连门牌须 WebSocket（RFC 6455，版本 13）升级请求' }), { Upgrade: 'websocket' });
    }
    const threadId = parts[1];
    if (!getThread(db, threadId)) {
      return rawHttp(socket, 404, JSON.stringify({ error: `thread 不存在：${threadId}` }));
    }
    const speakerId = u.searchParams.get('speakerId') ?? null; // presence 身份（可匿名旁观）
    acceptWebSocket(req, socket, head, threadId, speakerId);
  });

  const sockets = new Set(); // 挂账活动 socket：close 时先拆，防 keep-alive 吊死进程
  httpServer.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return {
    httpServer,
    pinStates,
    connections: conns,
    broadcast,
    broadcastAll,
    start: () =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => resolve({ port: httpServer.address().port, host }));
      }),
    close: () => {
      for (const set of conns.values()) for (const c of set) c.socket.destroy(); // 先拆长连，close 才不吊死
      conns.clear();
      for (const s of sockets) s.destroy(); // 再拆 http 挂账 socket（keep-alive 空闲连接）
      httpServer.closeIdleConnections?.();
      return new Promise((resolve) => {
        if (!httpServer.listening) return resolve();
        httpServer.close(() => resolve());
      });
    },
  };
}
