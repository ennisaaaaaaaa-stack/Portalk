// test/heartbeat.test.mjs —— P2B 心跳树（判据 5）：语义映射表 / 树状态机 / server 数据面
// 突变锚点：拆 TOOL_PHRASES（映射表置空）→ 「在读文件」语义断言红（树面回落「在用工具」）；
//           拆 ingest 的 phrase 行 → label 断言红。突变实验见 self-review.md §突变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { createThread } from '../src/threads.mjs';
import { createHeartbeatTree, translateToolUse, TOOL_PHRASES } from '../src/heartbeat.mjs';
import { createPortalkServer } from '../src/server.mjs';
import { wsConnect, nextOfType } from './ws-client.mjs';

const U = 'p:u-0001';
const A = 'a:alpha-0001';

// 触感事件工厂（reader v0 统一形状 {shell, kind, ref, detail}）
const ev = (kind, ref, detail = {}) => ({ shell: 'pianist', kind, ref, detail });

// ---------------------------------------------------------------------------
// 语义映射表（判据 5：树上语义标签非黑话）
// ---------------------------------------------------------------------------

test('translateToolUse：常用工具翻人话，未匹配回 null（树面另有兜底）', () => {
  assert.equal(translateToolUse({ tool: 'read', input: { path: '/a' } }), '在读文件');
  assert.equal(translateToolUse({ tool: 'bash', input: { command: 'ls' } }), '在跑命令');
  assert.equal(translateToolUse({ tool: 'edit', input: { path: '/a' } }), '在改文件');
  assert.equal(translateToolUse({ tool: 'grep' }), '在找东西');
  assert.equal(translateToolUse({ tool: 'npm_test' }), '在跑测试');
  // 别名前缀形状（mcp__pianist_bridge / bash:extra）同表命中
  assert.equal(translateToolUse({ tool: 'mcp__pianist_bridge' }), '在走桥调用');
  assert.equal(translateToolUse({ tool: 'bash:wrapped' }), '在跑命令');
  // 未匹配/坏形状：null（不是异常——未知工具不上黑话，树面回落「在用工具」）
  assert.equal(translateToolUse({ tool: 'totally-unknown' }), null);
  assert.equal(translateToolUse({}), null);
  assert.equal(translateToolUse(null), null);
});

test('translateToolUse：表序即优先序，条目可带参数模式位（when）——v0 表不启用参数级', () => {
  // 拆表实验位（突变等价验证）：清空映射表 → 全部回落 null
  const backup = [...TOOL_PHRASES];
  TOOL_PHRASES.length = 0;
  try {
    assert.equal(translateToolUse({ tool: 'read' }), null, '拆表后连 read 也不认（表是唯一语义源）');
  } finally {
    TOOL_PHRASES.push(...backup); // 还原（同测内自愈——跨测零污染）
  }
  assert.equal(translateToolUse({ tool: 'read' }), '在读文件', '还原后照常');
});

// ---------------------------------------------------------------------------
// 树状态机（判据 5：工具级事件秒级可读；长静默=「在想」）
// ---------------------------------------------------------------------------

test('心跳树：session_start→task_progress→snapshot 树面人话+机械面留档', () => {
  let nowMs = 1_700_000_000_000;
  const tree = createHeartbeatTree({ now: () => new Date(nowMs), thinkingAfterMs: 10_000 });
  tree.ingest(ev('session_start', 'sess-1', { agent: 'pianist-acp-1', ts: new Date(nowMs).toISOString() }));
  nowMs += 2_000;
  tree.ingest(ev('task_progress', 'sess-1', { agent: 'pianist-acp-1', ts: new Date(nowMs).toISOString(), tool: 'bash', input: { command: 'npm test' }, isError: false, durationMs: 120 }));
  nowMs += 500;
  tree.ingest(ev('heartbeat', 'sess-1', { agent: 'pianist-acp-1', ts: new Date(nowMs).toISOString(), usage: { totalTokens: 30, cost: { total: 0.0001 } } }));

  const snap = tree.snapshot();
  assert.equal(snap.sessions.length, 1);
  const s = snap.sessions[0];
  assert.equal(s.ref, 'sess-1');
  assert.equal(s.state, 'active');
  assert.equal(s.label, '在跑命令', '树面是人话非黑话（判据 5）');
  assert.equal(s.activity.length, 1);
  assert.equal(s.activity[0].phrase, '在跑命令');
  assert.equal(s.activity[0].machine.tool, 'bash', '机械面留档给排障（双层家风）');
  assert.equal(s.activity[0].machine.input.command, 'npm test');
  assert.equal(s.beats[0].tokens, 30, 'message_end 心跳节拍入账');
});

test('心跳树：长静默段=「在想」（不是死了）——假时钟越过阈值翻态', () => {
  let nowMs = 1_700_000_000_000;
  const tree = createHeartbeatTree({ now: () => new Date(nowMs), thinkingAfterMs: 10_000 });
  tree.ingest(ev('session_start', 'sess-1', { ts: new Date(nowMs).toISOString() }));
  tree.ingest(ev('task_progress', 'sess-1', { ts: new Date(nowMs).toISOString(), tool: 'edit' }));
  assert.equal(tree.snapshot().sessions[0].state, 'active');

  nowMs += 9_999; // 阈内：还活着
  assert.equal(tree.snapshot().sessions[0].state, 'active');
  assert.equal(tree.snapshot().sessions[0].label, '在改文件');

  nowMs += 2; // 越阈：在想
  const snap = tree.snapshot();
  assert.equal(snap.sessions[0].state, 'thinking');
  assert.equal(snap.sessions[0].label, '在想');

  tree.ingest(ev('task_progress', 'sess-1', { ts: new Date(nowMs).toISOString(), tool: 'read' })); // 工具事件来了：回活
  assert.equal(tree.snapshot().sessions[0].state, 'active');
  assert.equal(tree.snapshot().sessions[0].label, '在读文件');
});

test('心跳树：session_end=收工；subagent 分支挂树（树的下层形状）', () => {
  let nowMs = 1_700_000_000_000;
  const tree = createHeartbeatTree({ now: () => new Date(nowMs), thinkingAfterMs: 10_000 });
  tree.ingest(ev('session_start', 'sess-1', { ts: new Date(nowMs).toISOString() }));
  tree.ingest(ev('subagent_spawn', 'sess-1', { ts: new Date(nowMs).toISOString(), subagent: 'minion-a' }));
  nowMs += 1_000;
  tree.ingest(ev('subagent_exit', 'sess-1', { ts: new Date(nowMs).toISOString(), subagent: 'minion-a' }));
  nowMs += 1_000;
  tree.ingest(ev('session_end', 'sess-1', { ts: new Date(nowMs).toISOString() }));
  const s = tree.snapshot().sessions[0];
  assert.equal(s.state, 'ended');
  assert.equal(s.label, '收工了');
  assert.equal(s.subagents.length, 1);
  assert.equal(s.subagents[0].phrase, '分身收工');
  assert.ok(s.subagents[0].exitTs);
});

// ---------------------------------------------------------------------------
// server 数据面（HTTP 轮询 + WS 推送共用 snapshot 形状）
// ---------------------------------------------------------------------------

test('server 集成：GET /api/tree 快照 + WS 推送（onChange→broadcastAll 全局面）+ 未注入 404', async (t) => {
  // 未注入：面不世
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-hb-'));
    const db = openDb(path.join(dir, 't.db'));
    const srv0 = createPortalkServer({ db, exportDir: path.join(dir, 'exports') });
    const { port: p0 } = await srv0.start();
    t.after(() => srv0.close());
    t.after(() => db.close());
    const r0 = await fetch(`http://127.0.0.1:${p0}/api/tree`);
    assert.equal(r0.status, 404);
  }

  // 注入：两瓣数据面
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-hb-'));
  const db = openDb(path.join(dir, 't.db'));
  const thread = createThread(db, { type: 'topic', title: '心跳树窗', createdBy: U, memberIds: [U, A] });
  let pushTree = null;
  const tree = createHeartbeatTree({ onChange: (snap) => pushTree?.(snap) });
  const srv = createPortalkServer({ db, exportDir: path.join(dir, 'exports'), tree });
  const { port } = await srv.start();
  t.after(() => srv.close());
  t.after(() => db.close());

  // HTTP 轮询面：空树也有形状（sessions:[]），ingest 后立刻可读（事件驱动无轮询延迟）
  const empty = await (await fetch(`http://127.0.0.1:${port}/api/tree`)).json();
  assert.deepEqual(empty.tree.sessions, []);
  tree.ingest(ev('session_start', 'sess-ws', { agent: 'pianist-acp-ws' }));
  tree.ingest(ev('task_progress', 'sess-ws', { agent: 'pianist-acp-ws', tool: 'grep' }));
  const after = await (await fetch(`http://127.0.0.1:${port}/api/tree`)).json();
  assert.equal(after.tree.sessions[0].label, '在找东西', 'HTTP 轮询口秒级可读（判据 5）');

  // WS 推送面：tree.ingest 经 onChange 广播到所有活动连接（全局面不挑门牌）
  const ws = await wsConnect(port, `/threads/${thread.id}?speakerId=${encodeURIComponent(U)}`);
  t.after(() => ws.destroy());
  await nextOfType(ws, 'ready');
  pushTree = (snap) => srv.broadcastAll({ type: 'tree', tree: snap }); // 组装层接线（compose 同款）
  tree.ingest(ev('task_progress', 'sess-ws', { agent: 'pianist-acp-ws', tool: 'read' }));
  const frame = await nextOfType(ws, 'tree');
  assert.equal(frame.type, 'tree');
  assert.equal(frame.tree.sessions[0].label, '在读文件', 'WS 推送与 HTTP 快照同一形状');
});
