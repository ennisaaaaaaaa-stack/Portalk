// test/server.test.mjs —— P2 接线层（施工单 A）
//
//   HTTP 面：health/threads/messages CRUD 全链（真实起服 ephemeral 端口，测完关）
//   WS 面：握手+收发（自实现客户端帧，零依赖）/ 两 thread 不串台（判据 1）
//          三类消息 human/agent/system（判据 2）/ presence / 走错门拒绝
//   pin 三态（判据 4）：unit 直测 routeMessage + WS 端到端（EP stub 被调/不被调、双通知）
//   断线重连（判据 3）：since=<lastSeq> 补拉不丢
//   搜索/导出（判据 6）：全文命中正文、日期范围/thread 过滤；frontmatter 四字段
//   错误形状：426 / 400（坏 JSON、坏形状）/ 404（未知路由、thread 不存在）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { createThread, archiveThread, appendMessage, listThreadMessages } from '../src/threads.mjs';
import { createPortalkServer } from '../src/server.mjs';
import { routeMessage, appendSystemMessage, epForwardStub } from '../src/router.mjs';
import { wsConnect, nextOfType, collectEvents } from './ws-client.mjs';

const U = 'p:u-0001';
const A = 'a:alpha-0001';
const CT = { 'content-type': 'application/json' };

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-server-'));
  return { db: openDb(path.join(dir, 't.db')), dir };
}

// 起一间真实 Server（ephemeral 端口），t.after 收摊
async function startSrv(t, opts = {}) {
  const { db, dir } = freshDb();
  const srv = createPortalkServer({
    db,
    exportDir: path.join(dir, 'exports'),
    ...(opts.epForward ? { epForward: opts.epForward } : {}),
  });
  const { port } = await srv.start();
  t.after(() => srv.close());
  t.after(() => db.close());
  const base = `http://127.0.0.1:${port}`;
  return { db, dir, srv, port, base, wsUrl: (threadId, speakerId) => `/threads/${threadId}${speakerId ? `?speakerId=${encodeURIComponent(speakerId)}` : ''}` };
}

const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: CT, body: body === undefined ? undefined : JSON.stringify(body) });

// ---------------------------------------------------------------------------
// HTTP 面
// ---------------------------------------------------------------------------

test('HTTP 面：health / threads CRUD（dm upsert·归档滤除·type 筛）/ 400 / 404', async (t) => {
  const s = await startSrv(t);

  const h = await fetch(s.base + '/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true });

  // 新建 topic
  let r = await post(s.base, '/api/threads', { type: 'topic', title: '听海', createdBy: U, memberIds: [U, A], projectIds: ['prj:ocean'] });
  assert.equal(r.status, 201);
  const { thread } = await r.json();
  assert.match(thread.id, /^th:/);
  assert.equal(thread.type, 'topic');

  // dm upsert-复用（成员序倒过来也是同一条）
  r = await post(s.base, '/api/threads', { type: 'dm', createdBy: U, memberIds: [U, A] });
  const dm1 = (await r.json()).thread;
  r = await post(s.base, '/api/threads', { type: 'dm', createdBy: A, memberIds: [A, U] });
  const dm2 = (await r.json()).thread;
  assert.equal(dm1.id, dm2.id, 'API 面吃到 P1a dm 复用语义');

  // 列表：type 筛 + 归档滤除
  archiveThread(s.db, thread.id);
  r = await fetch(s.base + '/api/threads');
  let list = (await r.json()).threads.map((x) => x.id);
  assert.ok(!list.includes(thread.id), '归档默认不可见');
  assert.ok(list.includes(dm1.id));
  r = await fetch(s.base + '/api/threads?includeArchived=true');
  list = (await r.json()).threads.map((x) => x.id);
  assert.ok(list.includes(thread.id), 'includeArchived 调出');
  r = await fetch(s.base + '/api/threads?type=topic&includeArchived=1');
  assert.deepEqual((await r.json()).threads.map((x) => x.id), [thread.id]);

  // 单查 + 错误形状
  r = await fetch(s.base + `/api/threads/${dm1.id}`);
  assert.equal((await r.json()).thread.id, dm1.id);
  r = await fetch(s.base + '/api/threads/th:none');
  assert.equal(r.status, 404);
  r = await fetch(s.base + '/api/none');
  assert.equal(r.status, 404);
  r = await post(s.base, '/api/threads', undefined); // 空 body → createThread 形状错 → 400
  assert.equal(r.status, 400);
  r = await fetch(s.base + '/api/threads', { method: 'POST', headers: CT, body: '{oops' });
  assert.equal(r.status, 400, '坏 JSON → 400');
  r = await post(s.base, '/api/threads', { type: 'dm', createdBy: U, memberIds: [U, A, A] });
  assert.equal(r.status, 400, 'dm 形状铁则 → 400');
});

test('messages：三类 role（human/agent/system）落库可取 + since 补拉形状（判据 2 HTTP 面）', async (t) => {
  const s = await startSrv(t);
  const th = createThread(s.db, { type: 'topic', title: '三类', createdBy: U, memberIds: [U, A] });

  let r = await post(s.base, `/api/threads/${th.id}/messages`, { session_id: 's:1', speaker_id: U, role: 'human', content: '人话' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).message.role, 'user', 'human 归一为 user（P1a 枚举）');

  r = await post(s.base, `/api/threads/${th.id}/messages`, { session_id: 's:1', speaker_id: A, role: 'agent', content: 'agent 回话' });
  assert.equal((await r.json()).message.role, 'agent');

  r = await post(s.base, `/api/threads/${th.id}/messages`, { session_id: 'sys:1', role: 'system', content: '系统通知' });
  assert.equal((await r.json()).message.role, 'system');

  r = await fetch(s.base + `/api/threads/${th.id}/messages`);
  const body = await r.json();
  assert.equal(body.messages.length, 3, '三类各一条都在库里');
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ['user', 'agent', 'system'],
  );
  assert.deepEqual(
    body.messages.map((m) => m.seq),
    [1, 2, 3],
    'seq thread 内单调递增',
  );
  assert.equal(body.lastSeq, 3);

  r = await fetch(s.base + `/api/threads/${th.id}/messages?since=1`);
  assert.deepEqual((await r.json()).messages.map((m) => m.seq), [2, 3], 'since 只补增量');

  r = await fetch(s.base + `/api/threads/${th.id}/messages?since=x`);
  assert.equal(r.status, 400);
  r = await fetch(s.base + `/api/threads/th:none/messages`);
  assert.equal(r.status, 404);
  r = await post(s.base, `/api/threads/${th.id}/messages`, { session_id: 's:1', speaker_id: U, role: '旁白', content: '?' });
  assert.equal(r.status, 400, '未知 role → 400');
});

// ---------------------------------------------------------------------------
// WebSocket 面
// ---------------------------------------------------------------------------

test('WS：握手 / 双客户端收发 / 两 thread 不串台（判据 1）/ 三类消息连接上收到（判据 2）', async (t) => {
  const s = await startSrv(t, { epForward: () => {} }); // 本测关管线不关路由：EP 注 no-op，unpinned 默认路由不噪声
  const tA = createThread(s.db, { type: 'topic', title: '窗甲', createdBy: U, memberIds: [U, A] });
  const tB = createThread(s.db, { type: 'topic', title: '窗乙', createdBy: U, memberIds: [U, A] });

  const a1 = await wsConnect(s.port, s.wsUrl(tA.id, U));
  const a2 = await wsConnect(s.port, s.wsUrl(tA.id, A));
  const b1 = await wsConnect(s.port, s.wsUrl(tB.id, U));
  t.after(() => [a1, a2, b1].forEach((c) => c.destroy()));

  const ready = await nextOfType(a1, 'ready');
  assert.equal(ready.threadId, tA.id);
  assert.equal(ready.pinState, 'unpinned');

  // human（→user）：窗甲两个客户端都收到，窗乙收不到
  a1.send({ type: 'message', threadId: tA.id, sessionId: 's:1', speakerId: U, role: 'human', content: '你好' });
  const m1 = await nextOfType(a1, 'message');
  assert.equal(m1.content, '你好');
  assert.equal(m1.role, 'user');
  assert.equal(m1.speaker_id, U);
  assert.ok(m1.seq >= 1);
  await collectEvents(a2, 'message', 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(b1.log.filter((e) => e.type === 'message').length, 0, '窗乙不串台');

  // agent + system 类也照收（广播含发送方自己）
  a2.send({ type: 'message', threadId: tA.id, sessionId: 's:1', speakerId: A, role: 'agent', content: 'agent 到场' });
  const two = await collectEvents(a2, 'message', 2);
  assert.equal(two.at(-1).role, 'agent');
  await collectEvents(a1, 'message', 2);
  a1.send({ type: 'message', threadId: tA.id, sessionId: 'sys:1', role: 'system', content: '系统通知' });
  const three = await collectEvents(a2, 'message', 3);
  assert.equal(three.at(-1).role, 'system');
  assert.equal(three.at(-1).speaker_id, 'system');
  await collectEvents(a1, 'message', 3);
  assert.equal(listThreadMessages(s.db, tA.id).length, 3, '三类消息全落库');

  // 走错门：a1 的连接发 tB 的消息 → 拒（窗口 ↔ thread 一一对应）
  a1.send({ type: 'message', threadId: tB.id, sessionId: 's:1', speakerId: U, role: 'user', content: '走错门' });
  const errs = await collectEvents(a1, 'error', 1);
  assert.equal(errs[0].code, 'thread-mismatch');

  // 非法帧形状
  a1.send({ type: 'dance', threadId: tA.id });
  const errs2 = await collectEvents(a1, 'error', 2);
  assert.equal(errs2[1].code, 'unknown-frame');
});

test('WS 门牌错误形状：未知 thread 握手拒（404）；HTTP 摸 WS 门牌 → 426', async (t) => {
  const s = await startSrv(t);
  const th = createThread(s.db, { type: 'topic', title: '门牌', createdBy: U, memberIds: [U, A] });

  await assert.rejects(() => wsConnect(s.port, s.wsUrl('th:none')), /握手失败/);

  const r = await fetch(s.base + `/threads/${th.id}`);
  assert.equal(r.status, 426);
  assert.equal(r.headers.get('upgrade'), 'websocket');
});

test('presence：连接与断开广播成员变化', async (t) => {
  const s = await startSrv(t);
  const th = createThread(s.db, { type: 'topic', title: '在场', createdBy: U, memberIds: [U, A] });

  const a1 = await wsConnect(s.port, s.wsUrl(th.id, U));
  await nextOfType(a1, 'ready');
  const a2 = await wsConnect(s.port, s.wsUrl(th.id, A));
  await nextOfType(a2, 'ready');

  const p2 = await collectEvents(a1, 'presence', 2); // 第 1 跳=自接入照会，第 2 跳=a2 接入
  assert.deepEqual(p2[1].members.sort(), [A, U].sort(), '第二位接入 → 双成员在场');
  assert.equal(p2[1].connections, 2);

  a2.close();
  const p3 = await collectEvents(a1, 'presence', 3);
  assert.deepEqual(p3[2].members, [U], '断开后成员面收缩');
  assert.equal(p3[2].connections, 1);
  a1.destroy();
});

// ---------------------------------------------------------------------------
// pin 三态（判据 4）
// ---------------------------------------------------------------------------

test('pin 三态（unit）：pinned 不越壳 / unpinned 落 EP / shell-fault 自动路由+双通知 / stub 形状锁', () => {
  const { db } = freshDb();
  const th = createThread(db, { type: 'topic', title: '三态', createdBy: U, memberIds: [U, A] });
  const events = [];
  const spy = { calls: [] };
  const deps = { emit: (ev) => events.push(ev), epForward: (p) => spy.calls.push(p) };

  // pinned：只进库不外发 + 换壳推审批
  routeMessage(db, { threadId: th.id, speakerId: U, session_id: 's:1', role: 'user', content: 'pin 住', pinState: 'pinned' }, deps);
  assert.equal(spy.calls.length, 0, 'pin 后消息不越壳：EP 转发不被调');
  assert.ok(events.some((e) => e.type === 'message' && e.content === 'pin 住'), '消息照广播');
  assert.ok(events.some((e) => e.type === 'approval' && e.target === 'agent' && e.reason === 'pinned-shell'), '换壳推审批事件');
  assert.equal(listThreadMessages(db, th.id).length, 1, '消息照进库');

  // unpinned：EP 第一顺位
  routeMessage(db, { threadId: th.id, speakerId: U, session_id: 's:1', role: 'user', content: '常规', pinState: 'unpinned' }, deps);
  assert.equal(spy.calls.length, 1, '未 pin 默认落 EP');

  // shell-fault：唯一自动路由 + agent/user 双通知
  routeMessage(db, { threadId: th.id, speakerId: U, session_id: 's:1', role: 'user', content: '壳炸了', pinState: 'shell-fault' }, deps);
  assert.equal(spy.calls.length, 2, '壳故障自动路由');
  const targets = events.filter((e) => e.type === 'shell-fault').map((e) => e.target).sort();
  assert.deepEqual(targets, ['agent', 'user'], '双通知两侧齐');

  // 非法态
  assert.throws(() => routeMessage(db, { threadId: th.id, speakerId: U, session_id: 's:1', role: 'user', content: 'x', pinState: '魔法' }, deps), /pinState/);

  // 缺省 deps=stub：EP 未接线 throw 不算错（注入点形状锁）
  assert.throws(() => routeMessage(db, { threadId: th.id, speakerId: U, session_id: 's:1', role: 'user', content: 'x', pinState: 'unpinned' }), /not wired in this slice/);
  assert.throws(() => epForwardStub({}), /not wired in this slice/);
  db.close();
});

test('pin 三态（WS 端到端）：POST pin → 不越壳；unpin → 落 EP；shell-fault → 两侧双通知', async (t) => {
  const spy = { calls: [] };
  const s = await startSrv(t, { epForward: (p) => spy.calls.push(p) });
  const th = createThread(s.db, { type: 'topic', title: '端到端', createdBy: U, memberIds: [U, A] });

  const cu = await wsConnect(s.port, s.wsUrl(th.id, U));
  const ca = await wsConnect(s.port, s.wsUrl(th.id, A));
  t.after(() => [cu, ca].forEach((c) => c.destroy()));
  await nextOfType(cu, 'ready');
  await nextOfType(ca, 'ready');

  // —— pin：消息进库广播，但 EP 不被调；审批事件推给 agent ——
  let r = await post(s.base, `/api/threads/${th.id}/pin`);
  assert.equal(r.status, 200);
  const pinStates = await collectEvents(cu, 'pin-state', 1);
  assert.equal(pinStates[0].pinState, 'pinned');
  cu.send({ type: 'message', threadId: th.id, sessionId: 's:1', speakerId: U, role: 'user', content: '给指定壳' });
  await collectEvents(cu, 'message', 1);
  const appr = await collectEvents(cu, 'approval', 1);
  assert.equal(appr[0].target, 'agent');
  await collectEvents(ca, 'message', 1);
  await collectEvents(ca, 'approval', 1);
  assert.equal(spy.calls.length, 0, 'pin 后消息不越壳（EP stub 不被调）');
  r = await fetch(s.base + '/api/threads/th:none/pin', { method: 'POST' });
  assert.equal(r.status, 404);

  // —— unpin：EP 第一顺位 ——
  r = await post(s.base, `/api/threads/${th.id}/unpin`);
  assert.equal((await r.json()).pinState, 'unpinned');
  await collectEvents(cu, 'pin-state', 2);
  cu.send({ type: 'message', threadId: th.id, sessionId: 's:1', speakerId: U, role: 'user', content: '常规' });
  await collectEvents(cu, 'message', 2);
  await collectEvents(ca, 'message', 2);
  assert.equal(spy.calls.length, 1, '未 pin 默认落 EP');

  // —— shell-fault（消息级 pinState 模拟壳故障）：双通知送达 agent 与 user 两侧 ——
  cu.send({ type: 'message', threadId: th.id, sessionId: 's:1', speakerId: U, role: 'user', content: '壳炸了', pinState: 'shell-fault' });
  await collectEvents(cu, 'message', 3);
  await collectEvents(ca, 'message', 3);
  const cuFaults = await collectEvents(cu, 'shell-fault', 2);
  const caFaults = await collectEvents(ca, 'shell-fault', 2);
  assert.deepEqual(
    [...cuFaults, ...caFaults].map((e) => e.target).sort(),
    ['agent', 'agent', 'user', 'user'],
    '两侧各收到 target=agent 与 target=user 的 shell-fault',
  );
  assert.equal(spy.calls.length, 2, '壳故障=唯一自动路由');
  assert.equal(spy.calls[1].auto, true);
});

// ---------------------------------------------------------------------------
// 断线重连（判据 3）
// ---------------------------------------------------------------------------

test('断线重连不丢：since=<lastSeq> 补拉断线期间的消息', async (t) => {
  const s = await startSrv(t);
  const th = createThread(s.db, { type: 'topic', title: '重连', createdBy: U, memberIds: [U, A] });

  const c1 = await wsConnect(s.port, s.wsUrl(th.id, U));
  await nextOfType(c1, 'ready');
  c1.send({ type: 'message', threadId: th.id, sessionId: 's:1', speakerId: U, role: 'user', content: '第一条' });
  c1.send({ type: 'message', threadId: th.id, sessionId: 's:1', speakerId: U, role: 'user', content: '第二条' });
  const two = await collectEvents(c1, 'message', 2);
  const lastSeq = Math.max(...two.map((m) => m.seq));
  assert.equal(lastSeq, 2);

  c1.close();
  await new Promise((r) => setTimeout(r, 100)); // 等服务端清完账

  // 断线期间：HTTP 面继续进话（广播无人收，库照记）
  const r = await post(s.base, `/api/threads/${th.id}/messages`, { session_id: 's:2', speaker_id: A, role: 'agent', content: '断线期间的消息' });
  assert.equal(r.status, 201);

  // 重连：先补拉再续听
  const c2 = await wsConnect(s.port, s.wsUrl(th.id, U));
  t.after(() => c2.destroy());
  const ready = await nextOfType(c2, 'ready');
  assert.equal(ready.lastSeq, 3, 'ready 带 watermark');
  const back = await fetch(s.base + `/api/threads/${th.id}/messages?since=${lastSeq}`);
  const body = await back.json();
  assert.equal(body.messages.length, 1, '恰补上断线期间那一条');
  assert.equal(body.messages[0].content, '断线期间的消息');

  c2.send({ type: 'message', threadId: th.id, sessionId: 's:1', speakerId: U, role: 'user', content: '重连后继续' });
  const m4 = await nextOfType(c2, 'message');
  assert.equal(m4.content, '重连后继续');
  assert.equal(listThreadMessages(s.db, th.id).length, 4, '全程零丢');
});

// ---------------------------------------------------------------------------
// 搜索 / 导出（判据 6）
// ---------------------------------------------------------------------------

test('搜索：关键词命中消息全文（不止标题）+ 日期范围 + thread 过滤 + LIKE 转义', async (t) => {
  const s = await startSrv(t);
  const t1 = createThread(s.db, { type: 'topic', title: '窗口甲', createdBy: U, memberIds: [U, A] });
  const t2 = createThread(s.db, { type: 'topic', title: '窗口乙', createdBy: U, memberIds: [U, A] });
  appendMessage(s.db, { thread_id: t1.id, session_id: 's:1', speaker_id: U, role: 'user', content: '深潜器的维护笔记', created_at: '2026-11-18T10:00:00.000Z' });
  appendMessage(s.db, { thread_id: t2.id, session_id: 's:2', speaker_id: A, role: 'agent', content: '深潜器批发市况', created_at: '2026-11-19T09:00:00.000Z' });
  appendMessage(s.db, { thread_id: t1.id, session_id: 's:1', speaker_id: A, role: 'agent', content: '再谈深潜器（续昨）', created_at: '2026-11-19T12:00:00.000Z' });
  appendMessage(s.db, { thread_id: t1.id, session_id: 's:1', speaker_id: U, role: 'user', content: '无关内容', created_at: '2026-11-20T08:00:00.000Z' });

  let r = await fetch(s.base + '/api/search?q=' + encodeURIComponent('深潜器'));
  let body = await r.json();
  assert.equal(body.count, 3, '命中正文三处（标题都不含关键词）');
  assert.ok(body.results.every((m) => m.content.includes('深潜器')));

  r = await fetch(s.base + '/api/search?q=' + encodeURIComponent('深潜器') + '&thread_id=' + encodeURIComponent(t1.id));
  assert.equal((await r.json()).count, 2, 'thread 过滤');

  r = await fetch(s.base + '/api/search?q=' + encodeURIComponent('深潜器') + '&from=2026-11-19');
  assert.equal((await r.json()).count, 2, 'from=纯日期 补零点');

  r = await fetch(s.base + '/api/search?q=' + encodeURIComponent('深潜器') + '&from=2026-11-19&to=2026-11-19');
  assert.equal((await r.json()).count, 2, 'to=纯日期 补末刻');

  r = await fetch(s.base + '/api/search?q=' + encodeURIComponent('深潜器') + '&to=2026-11-18');
  assert.equal((await r.json()).count, 1, 'to 截断');

  r = await fetch(s.base + '/api/search?q=' + encodeURIComponent('100%'));
  assert.equal((await r.json()).count, 0, '% 当字面量（转义生效）');

  r = await fetch(s.base + '/api/search');
  assert.equal(r.status, 400, 'q 必填');
});

test('导出（判据 6）：markdown frontmatter 四字段（日期/参与者/主题/关联项目）+ 盘上一致', async (t) => {
  const s = await startSrv(t);
  const th = createThread(s.db, { type: 'topic', title: '夜航计划', createdBy: U, memberIds: [U, A], projectIds: ['prj:ocean', 'prj:portalk'] });
  appendMessage(s.db, { thread_id: th.id, session_id: 's:1', speaker_id: U, role: 'user', content: '夜航第一天', created_at: '2026-11-18T10:00:00.000Z' });
  appendMessage(s.db, { thread_id: th.id, session_id: 's:1', speaker_id: A, role: 'agent', content: '收到，编队就位', created_at: '2026-11-19T12:00:00.000Z' });

  const r = await fetch(s.base + `/api/threads/${th.id}/export`);
  assert.equal(r.status, 200);
  const body = await r.json();
  const { markdown, file } = body;

  assert.ok(markdown.startsWith('---\n'), 'frontmatter 开头');
  assert.ok(markdown.includes('日期: "2026-11-18 ~ 2026-11-19"'), '日期=时间跨度');
  assert.ok(markdown.includes('参与者: "p:u-0001, a:alpha-0001"'), '参与者四字段之一');
  assert.ok(markdown.includes('主题: "夜航计划"'), '主题优先取 title');
  assert.ok(markdown.includes('关联项目: "prj:ocean, prj:portalk"'), '关联项目');
  assert.ok(markdown.includes('\n---\n'), 'frontmatter 收口');
  assert.ok(markdown.includes('夜航第一天') && markdown.includes('收到，编队就位'), '消息正文在内（消费 exportThread 渲染）');

  assert.ok(fs.existsSync(file), '导出文件落盘');
  assert.equal(fs.readFileSync(file, 'utf8'), markdown, '盘上同一份（带 frontmatter）');

  // dm：主题回落首条消息摘要（蓝图 11-18 甜心：允许一路空到底，规则级不花 LLM）
  const dm = createThread(s.db, { type: 'dm', createdBy: U, memberIds: [U, A] });
  appendMessage(s.db, { thread_id: dm.id, session_id: 's:2', speaker_id: U, role: 'user', content: 'dm 首条：今天风大不出海', created_at: '2026-11-18T09:00:00.000Z' });
  const r2 = await fetch(s.base + `/api/threads/${dm.id}/export`);
  const md2 = (await r2.json()).markdown;
  assert.ok(md2.includes('主题: "dm 首条：今天风大不出海"'), 'title 空回落首条消息摘要');
  assert.ok(md2.includes('关联项目: ""'), 'dm 不挂项目（空到底）');

  const r3 = await fetch(s.base + '/api/threads/th:none/export');
  assert.equal(r3.status, 404);
});

test('system 类直写（router 层）：不进成员表也能落账', () => {
  const { db } = freshDb();
  const th = createThread(db, { type: 'topic', title: '系统面', createdBy: U, memberIds: [U, A] });
  const m = appendSystemMessage(db, { thread_id: th.id, content: '定时备份完成' });
  assert.equal(m.role, 'system');
  assert.equal(m.speaker_id, 'system');
  assert.ok(m.seq >= 1, 'system 消息也吃 seq 闸');
  assert.throws(() => appendSystemMessage(db, { thread_id: 'th:none', content: 'x' }), /不存在/);
  db.close();
});
