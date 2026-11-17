// test/acp-adapter.test.mjs —— P1b adapter：session new/prompt/close + 遥测事件 + 审批卡浮出
// 全 mock：pi 替身= node test/mock-pi.mjs（零真 spawn 零真钱），壳替身= test/mock-shell.mjs（listen(0)）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { listThreadMessages, getThread, findDmByMembers } from '../src/threads.mjs';
import { createAcpAdapter, resolvePianistIdentity, encodeCwdDir } from '../src/acp-adapter.mjs';
import { startMockShell } from './mock-shell.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const MOCK_PI = fileURLToPath(new URL('./mock-pi.mjs', import.meta.url));
const USER = 'p:u-0001';
const AGENT = 'a:alpha-0001';

async function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-acp-'));
  const db = openDb(path.join(dir, 't.db'));
  const telemetryDir = path.join(dir, 'telemetry');
  const sessionDir = path.join(dir, 'sessions');
  const shell = await startMockShell({ telemetryDir });
  const events = [];
  const cards = [];
  const adapter = createAcpAdapter({
    db,
    pianistAgentId: AGENT,
    userId: USER,
    piCommand: process.execPath,
    piBaseArgs: [MOCK_PI],
    cwd: dir, // mock-pi 的 cwd（session header 里会记，但替身发现不依赖编码目录——sessionDir 显式传）
    sessionDir,
    telemetryDir,
    shellUrl: shell.url,
    readerIntervalMs: 40,
    approvalIntervalMs: 40,
    env: { PIANIST_SHELL_URL: shell.url }, // 子进程最小 env：mock-pi 只认这两个
    onEvent: (ev) => events.push(ev),
    onApproval: (card) => cards.push(card),
  });
  return { dir, db, adapter, shell, sessionDir, telemetryDir, events, cards, close: () => {
    adapter.stop();
    shell.close();
    db.close();
  } };
}

// —— P0 消费（判据 1） ——

test('resolvePianistIdentity：从出厂成员位解析 pianist（P0 manifest 被本层消费，判据 1）', () => {
  // 用仓内真出厂件（members/pianist.yaml+schema.json，静态文件零夹具竞态）；拷入私有目录隔离
  const membersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-acp-members-'));
  fs.copyFileSync(path.join(REPO_ROOT, 'members', 'pianist.yaml'), path.join(membersDir, 'pianist.yaml'));
  fs.copyFileSync(path.join(REPO_ROOT, 'members', 'schema.json'), path.join(membersDir, 'schema.json'));
  const id = resolvePianistIdentity({ membersDir });
  assert.equal(id.slug, 'pianist');
  assert.match(id.agentId, /^a:/);
  assert.equal(id.manifest.kind, 'agent');
  assert.equal(id.manifest.identity.memory.ref, 'tideline:///root/portalk/data/tideline/mcp_memory.db');
  assert.throws(() => resolvePianistIdentity({ membersDir, slug: 'no-such' }), /成员位无 no-such/);
});

test('encodeCwdDir：pi 同款 cwd→项目目录名编码', () => {
  assert.equal(encodeCwdDir('/root/portalk'), '--root-portalk--');
  assert.equal(encodeCwdDir('/tmp/l0-bridge-07Ho3N'), '--tmp-l0-bridge-07Ho3N--');
});

// —— session new（ACP 形状 1） ——

test('newSession：dm 建连（复用恰一）+ 首轮消息落库（speaker=user 身份）+ session_start 事件', async () => {
  const f = await fresh();
  try {
    const s1 = await f.adapter.newSession({ task: '首单任务' });
    assert.ok(s1.sessionId, 'session_id=pi 会话文件名 uuid');
    assert.match(s1.sessionId, /^[0-9a-f-]{36}$/);
    const file = fs.readdirSync(f.sessionDir).find((n) => n.endsWith(`_${s1.sessionId}.jsonl`));
    assert.ok(file, '会话文件真实落盘');
    const t = getThread(f.db, s1.threadId);
    assert.equal(t.type, 'dm');
    assert.equal(findDmByMembers(f.db, [USER, AGENT]).id, t.id, 'dm 复用恰一');

    const msgs = listThreadMessages(f.db, t.id);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].speaker_id, USER, '说话人记身份 ID 非壳');
    assert.equal(msgs[0].session_id, s1.sessionId, '双指针：session_id 归 EP');
    assert.equal(msgs[0].content, '首单任务');

    const start = f.events.find((e) => e.kind === 'session_start');
    assert.ok(start, 'session_start 触感事件');
    assert.equal(start.ref, s1.sessionId);
    assert.equal(start.detail.threadId, t.id);

    f.adapter.close(s1);
  } finally {
    f.close();
  }
});

test('newSession 复用既有 dm：第二次拿到同一条 thread（P1a 连续性不依赖 session）', async () => {
  const f = await fresh();
  try {
    const s1 = await f.adapter.newSession({ task: '一' });
    f.adapter.close(s1);
    const s2 = await f.adapter.newSession({ task: '二' });
    assert.equal(s2.threadId, s1.threadId, '同一对 user↔agent 恰一 dm');
    assert.notEqual(s2.sessionId, s1.sessionId, 'session 各自独立（硬切无感=thread 连续）');
    const msgs = listThreadMessages(f.db, s2.threadId);
    assert.equal(msgs.length, 2, '两条 user 消息各挂各的 session_id（未 wait=无 agent 回话）');
    assert.notEqual(msgs[0].session_id, msgs[1].session_id, 'session 硬切：thread 连续不依赖 session 连续');
    f.adapter.close(s2);
  } finally {
    f.close();
  }
});

// —— prompt（ACP 形状 2）：出话回写 thread（判据 2） ——

test('newSession 完整轮：替身回话落库（speaker=agent 身份）', async () => {
  const f = await fresh();
  try {
    const s = await f.adapter.newSession({ task: '算 1+1' });
    const done = await s.wait();
    assert.equal(done.exitCode, 0);
    assert.match(done.reply, /MOCKPI-OK: 算 1\+1/);
    const msgs = listThreadMessages(f.db, s.threadId);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].role, 'agent');
    assert.equal(msgs[1].speaker_id, AGENT);
    assert.equal(msgs[1].session_id, s.sessionId);
    f.adapter.close(s);
  } finally {
    f.close();
  }
});

test('prompt 续轮：--session-id 续同一会话文件，user+agent 消息各落一条', async () => {
  const f = await fresh();
  try {
    const s = await f.adapter.newSession({ task: '第一轮' });
    await s.wait();
    const before = fs.readFileSync(path.join(f.sessionDir, fs.readdirSync(f.sessionDir).find((n) => n.endsWith(`_${s.sessionId}.jsonl`))), 'utf8');
    const r2 = await f.adapter.prompt(s, '第二轮');
    assert.equal(r2.exitCode, 0);
    const after = fs.readFileSync(path.join(f.sessionDir, fs.readdirSync(f.sessionDir).find((n) => n.endsWith(`_${s.sessionId}.jsonl`))), 'utf8');
    assert.ok(after.length > before.length, '续轮追加进同一会话文件（进程退场≠session 断）');

    const msgs = listThreadMessages(f.db, s.threadId);
    assert.deepEqual(
      msgs.map((m) => `${m.role}:${m.content}`),
      ['user:第一轮', 'agent:MOCKPI-OK: 第一轮', 'user:第二轮', 'agent:MOCKPI-OK: 第二轮'],
    );
    f.adapter.close(s);
  } finally {
    f.close();
  }
});

// —— update stream（ACP 形状 3）：reader 遥测→触感事件 ——

test('update 事件：替身上报遥测→reader 吐 task_progress+heartbeat（流式不做，只有工具级）', async () => {
  const f = await fresh();
  try {
    const s = await f.adapter.newSession({ task: '干活' });
    await s.wait(); // mock-pi 已 POST /telemetry/ingest → mock 壳落遥测文件
    await new Promise((r) => setTimeout(r, 200)); // reader 一个节拍
    const kinds = f.events.filter((e) => e.ref === s.agentName).map((e) => e.kind);
    assert.ok(f.events.some((e) => e.kind === 'session_start' && e.ref === s.sessionId), 'session_start ref=session_id');
    assert.ok(kinds.includes('task_progress'), `tool_use→task_progress，实得 ${kinds}`);
    assert.ok(kinds.includes('heartbeat'), 'message_end→heartbeat');
    assert.ok(f.events.every((e) => e.shell === 'pianist'), '触感标准 shell=pianist');
    assert.ok(!kinds.includes('session_end'), '进程退场不误发 session_end（session 结束走 close）');
    f.adapter.close(s);
  } finally {
    f.close();
  }
});

// —— session 结束（ACP 形状 1 收口） ——

test('close：session_end 事件 + thread 消息全存（连续性不依赖 session）', async () => {
  const f = await fresh();
  try {
    const s = await f.adapter.newSession({ task: '收尾' });
    await s.wait();
    const threadId = s.threadId;
    f.adapter.close(s, { reason: 'demo-end' });
    const end = f.events.find((e) => e.kind === 'session_end');
    assert.equal(end.ref, s.sessionId);
    assert.equal(end.detail.reason, 'demo-end');
    assert.equal(listThreadMessages(f.db, threadId).length, 2, 'thread 账本无恙');
    await assert.rejects(() => f.adapter.prompt(s, '再说话'), /已 close/);
  } finally {
    f.close();
  }
});

test('close 杀活进程：HANG 替身被 SIGTERM 兜底，session_end 照发且不重复', async () => {
  const f = await fresh();
  try {
    const s = await f.adapter.newSession({ task: 'HANG-不退场' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(s.child.exitCode, null, '替身还活着');
    f.adapter.close(s, { reason: 'kill-test' });
    assert.ok(s.child.killed, 'SIGTERM 已发');
    const end = f.events.find((e) => e.kind === 'session_end');
    assert.equal(end.detail.reason, 'kill-test');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.events.filter((e) => e.kind === 'session_end').length, 1, '幂等不重复发');
    // 已退场的 child 再 close 也幂等
    f.adapter.close(s);
    assert.equal(f.events.filter((e) => e.kind === 'session_end').length, 1);
  } finally {
    f.close();
  }
});

// —— permission request（ACP 形状 4）：审批卡浮出 ——

test('审批轮询：新卡浮出恰一次（去重），后到的卡也浮', async () => {
  const f = await fresh();
  try {
    f.shell.setCards([{ id: 'ap-1', action: 'sandbox_execute', summary: '跑命令', plainLine: '跑一条命令' }]);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(f.cards.length, 1, '已有卡立即浮出');
    assert.equal(f.cards[0].id, 'ap-1');

    f.shell.setCards([{ id: 'ap-1', action: 'sandbox_execute', summary: '跑命令' }, { id: 'ap-2', action: 'grimoire_submit', summary: '交书' }]);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(f.cards.length, 2, '老卡不重浮，新卡浮');
    assert.equal(f.cards[1].id, 'ap-2');

    f.shell.setCards([{ id: 'ap-2', action: 'grimoire_submit', summary: '交书' }]); // ap-1 被人批走
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(f.cards.length, 2, '消失的卡不触发；同 id 复现不重浮');
  } finally {
    f.close();
  }
});

test('审批轮询容错：壳 404/坏 json 不炸不停，恢复后照常浮', async () => {
  const f = await fresh();
  try {
    // 借 fetchImpl 注入一个先坏后好的壳视图：坏期间错误计数增长，不崩
    const real = fetch;
    let broken = true;
    const cards2 = [];
    const f2 = createAcpAdapter({
      db: f.db,
      pianistAgentId: AGENT,
      userId: USER,
      piCommand: process.execPath,
      piBaseArgs: [MOCK_PI],
      cwd: f.dir,
      sessionDir: path.join(f.dir, 'sessions2'),
      telemetryDir: f.telemetryDir,
      shellUrl: f.shell.url, // 指准 mock 壳（防 env 泄漏到本机活壳——测试密闭纪律）
      env: {},
      approvalIntervalMs: 30,
      fetchImpl: async (url, init) => {
        if (broken) return new Response('not found', { status: 404 });
        return real(url, init);
      },
      onApproval: (c) => cards2.push(c),
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(f2.approvals.errors > 0, '坏壳计错不出声炸');
    assert.equal(cards2.length, 0);
    broken = false;
    f.shell.setCards([{ id: 'ap-9', action: 'x', summary: 'y' }]);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(cards2.length, 1, '恢复后照常浮');
    f2.stop();
  } finally {
    f.close();
  }
});

test('shell 不在场：不轮询不炸（拆卸态）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-acp-noshell-'));
  const db = openDb(path.join(dir, 't.db'));
  const cards = [];
  const adapter = createAcpAdapter({
    db,
    pianistAgentId: AGENT,
    userId: USER,
    piCommand: process.execPath,
    piBaseArgs: [MOCK_PI],
    cwd: dir,
    sessionDir: path.join(dir, 'sessions'),
    telemetryDir: path.join(dir, 'telemetry'),
    env: {},
    onApproval: (c) => cards.push(c),
  });
  const s = await adapter.newSession({ task: '无壳也能跑' });
  await s.wait();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(cards.length, 0);
  adapter.stop();
  db.close();
});
