// test/ep-connector.test.mjs —— P2B EP 转发真接线（G3）：三态行为 + 端到端消息闭环
// 突变锚点：epForward 换回 epForwardStub（拆接线）→ 转发断言红（stub throw）；
//           拆 newSession 的 taskPreStored 防双写 → user 消息恰一条断言红。记录见 self-review.md §突变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { createThread, listThreadMessages } from '../src/threads.mjs';
import { routeMessage } from '../src/router.mjs';
import { createAcpAdapter } from '../src/acp-adapter.mjs';
import { createEpForward } from '../src/ep-connector.mjs';
import { createPortalkServer } from '../src/server.mjs';
import { wsConnect, nextOfType, collectEvents } from './ws-client.mjs';

const MOCK_PI = fileURLToPath(new URL('./mock-pi.mjs', import.meta.url));
const U = 'p:u-0001';
const A = 'a:alpha-0001';

// 真身栈：真 adapter（mock-pi 替身引擎）+ ep-connector 接线
async function freshStack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-ep-'));
  const db = openDb(path.join(dir, 't.db'));
  const sessionDir = path.join(dir, 'sessions');
  const adapter = createAcpAdapter({
    db,
    pianistAgentId: A,
    userId: U,
    piCommand: process.execPath,
    piBaseArgs: [MOCK_PI],
    cwd: dir,
    sessionDir,
    telemetryDir: path.join(dir, 'telemetry'),
    env: {},
  });
  const epForward = createEpForward(adapter);
  return { dir, db, sessionDir, adapter, epForward, close: () => { adapter.stop(); db.close(); } };
}

// mock-pi 会话文件里的 user 行 content（EP 实际读到的进话面）
function userLinesOf(sessionDir, sessionId) {
  const name = fs.readdirSync(sessionDir).find((n) => n.endsWith(`_${sessionId}.jsonl`));
  return fs
    .readFileSync(path.join(sessionDir, name), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((l) => l.type === 'message' && l.message?.role === 'user')
    .map((l) => l.message.content);
}

// 等条件成真（转发/回话是异步链：mock-pi spawn→退场→回写，测试不睡死钟）
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`until 超时（${ms}ms）`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

// ---------------------------------------------------------------------------
// 三态行为（判据 T5 的转发面）：unpinned 流 EP / pinned 不越壳 / shell-fault 自动改道
// ---------------------------------------------------------------------------

test('三态：unpinned→EP 收到；pinned→epForward 零调用（不越壳）；shell-fault→auto 改道照流', async () => {
  const f = await freshStack();
  try {
    const thread = createThread(f.db, { type: 'topic', createdBy: U, memberIds: [U, A] });
    const sent = [];

    // pinned：不外发（epForward 不被调——router 层拦）
    const pinnedOut = [];
    routeMessage(f.db, { threadId: thread.id, speakerId: U, session_id: 's:t', role: 'user', content: 'pin 住的话', pinState: 'pinned' }, {
      emit: (ev) => pinnedOut.push(ev),
      epForward: (p) => { sent.push(p); },
    });
    assert.equal(sent.length, 0, 'pinned 不越壳');
    assert.ok(pinnedOut.some((e) => e.type === 'approval' && e.reason === 'pinned-shell'));

    // unpinned：流 EP（auto=false）
    routeMessage(f.db, { threadId: thread.id, speakerId: U, session_id: 's:t', role: 'user', content: '正常话', pinState: 'unpinned' }, {
      emit: () => {},
      epForward: (p) => { sent.push(p); },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.content, '正常话');
    assert.equal(sent[0].auto, false);

    // shell-fault：双通知先至 + auto 改道照流 EP
    const faultOut = [];
    routeMessage(f.db, { threadId: thread.id, speakerId: U, session_id: 's:t', role: 'user', content: '故障时的话', pinState: 'shell-fault' }, {
      emit: (ev) => faultOut.push(ev),
      epForward: (p) => { sent.push(p); },
    });
    assert.equal(sent.at(-1).auto, true, 'shell-fault 自动改道照流 EP');
    const faults = faultOut.filter((e) => e.type === 'shell-fault');
    assert.deepEqual(faults.map((e) => e.target).sort(), ['agent', 'user'], 'agent/user 双通知');
  } finally {
    f.close();
  }
});

// ---------------------------------------------------------------------------
// 端到端（真接线+mock-pi 引擎）：消息闭环 + 防双写 + 会话连续
// ---------------------------------------------------------------------------

test('端到端：routeMessage 真形状驱动——unpinned 消息真流 EP→回话落库；user 恰一条（防双写）；续轮续同一会话', async () => {
  const f = await freshStack();
  try {
    const thread = createThread(f.db, { type: 'topic', createdBy: U, memberIds: [U, A] });

    // 首条：routeMessage（唯一落库口）+ 真接线 epForward——一步到位的蓝图形状
    routeMessage(f.db, { threadId: thread.id, speakerId: U, session_id: 's:ws-1', role: 'user', content: '开单：报数', pinState: 'unpinned' }, {
      emit: () => {},
      epForward: f.epForward,
    });
    await until(() => f.epForward.stats.forwarded >= 1);
    await until(() => listThreadMessages(f.db, thread.id).some((m) => m.role === 'agent'));
    const sid = [...f.epForward.sessions.values()][0].sessionId;
    assert.deepEqual(userLinesOf(f.sessionDir, sid), ['开单：报数'], 'EP 读到的进话=用户原话（路由层落的库面）');

    // 防双写：thread 里 user 恰一条（routeMessage 落的），adapter 没有再落
    const msgs1 = listThreadMessages(f.db, thread.id);
    assert.equal(msgs1.filter((m) => m.role === 'user').length, 1, 'user 恰一条（taskPreStored 防双写）');
    // 回话：agent 出话回写 thread（消息闭环的正向半边）
    assert.ok(msgs1.find((m) => m.role === 'agent').content.startsWith('MOCKPI-OK'));

    // 续轮：同 thread 第二条→forward 续同一会话文件（会话连续性挂文件不挂进程）
    routeMessage(f.db, { threadId: thread.id, speakerId: U, session_id: 's:ws-1', role: 'user', content: '续轮：再报', pinState: 'unpinned' }, {
      emit: () => {},
      epForward: f.epForward,
    });
    await until(() => f.epForward.stats.forwarded >= 2);
    await until(() => listThreadMessages(f.db, thread.id).filter((m) => m.role === 'user').length === 2);
    assert.deepEqual(userLinesOf(f.sessionDir, sid), ['开单：报数', '续轮：再报']);
  } finally {
    f.close();
  }
});

test('端到端：shell-fault 改道同通道（auto=true 也流 EP）+ 转发失败自吞记账', async () => {
  const f = await freshStack();
  try {
    const thread = createThread(f.db, { type: 'topic', createdBy: U, memberIds: [U, A] });
    const r = await f.epForward({ threadId: thread.id, message: { content: '故障改道话' }, auto: true });
    assert.ok(r.ok);
    assert.deepEqual(userLinesOf(f.sessionDir, r.session.sessionId), ['故障改道话'], '改道不改通道（唯一自动路由）');
    assert.equal(f.epForward.stats.forwarded, 1);

    // 失败面：坏载荷自吞记账（不 unhandledRejection——server 同步调不 await）
    const bad = await f.epForward({ threadId: null });
    assert.equal(bad.ok, false);
    assert.equal(f.epForward.stats.errors, 1);
    assert.match(f.epForward.stats.lastError, /epForward 需/);
  } finally {
    f.close();
  }
});

test('栈组装端到端（compose）：WS 发 unpinned 消息→EP 回话广播回窗（消息闭环全链）+ 心跳树吃事件', async (t) => {
  const { createPortalkStack } = await import('../src/compose.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-stack-'));
  const db = openDb(path.join(dir, 't.db'));
  const stack = await createPortalkStack({
    db,
    exportDir: path.join(dir, 'exports'),
    pianistAgentId: A,
    userId: U,
    piCommand: process.execPath,
    piBaseArgs: [MOCK_PI],
    cwd: dir,
    sessionDir: path.join(dir, 'sessions'),
    telemetryDir: path.join(dir, 'telemetry'),
    env: {},
  });
  const { port } = await stack.start();
  t.after(() => stack.close());
  t.after(() => db.close());

  const thread = createThread(db, { type: 'topic', title: '闭环窗', createdBy: U, memberIds: [U, A] });
  const ws = await wsConnect(port, `/threads/${thread.id}?speakerId=${encodeURIComponent(U)}`);
  t.after(() => ws.destroy());
  await nextOfType(ws, 'ready');

  // 用户在窗里说话（unpinned）→ 落库+广播+真流 EP → mock-pi 回话经回话回流广播回窗
  ws.send({ type: 'message', threadId: thread.id, sessionId: 's:ep-1', speakerId: U, role: 'human', content: '窗口里的话' });
  const userMsg = await nextOfType(ws, 'message');
  assert.equal(userMsg.content, '窗口里的话');
  const agentMsg = await nextOfType(ws, 'message'); // 第二条广播=agent 回话（compose 回话回流）
  assert.equal(agentMsg.role, 'agent');
  assert.ok(agentMsg.content.startsWith('MOCKPI-OK'), 'EP 回话真的回到窗口（闭环下半边）');

  const msgs = listThreadMessages(db, thread.id);
  assert.equal(msgs.filter((m) => m.role === 'user').length, 1, '全链 user 恰一条（防双写）');

  // 心跳树同一组装里吃事件（G1 接线）：session 已在树上
  await until(() => stack.tree.snapshot().sessions.length >= 1);
  const snap = await (await fetch(`http://127.0.0.1:${port}/api/tree`)).json();
  assert.ok(snap.tree.sessions.length >= 1, '树面有会话（adapter 事件流喂树）');
  assert.ok(['active', 'thinking', 'ended'].includes(snap.tree.sessions[0].state));
});
