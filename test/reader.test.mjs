// test/reader.test.mjs —— reader v0：映射 / tail 增量 / 跨日界切换 / 坏行不炸
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReader, touchEvent, TOUCH_KINDS } from '../src/reader.mjs';

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-reader-'));
}
const line = (o) => JSON.stringify(o) + '\n';
const toolLine = (agent, tool = 'bash') =>
  line({ v: 1, ts: '2026-11-17T01:02:03.000Z', agent, kind: 'tool_use', data: { tool, input: { command: 'ls' }, isError: false, durationMs: 5, resultBytes: 100 } });
const msgEndLine = (agent) =>
  line({ v: 1, ts: '2026-11-17T01:02:04.000Z', agent, kind: 'message_end', data: { usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.001 } } } });

function collect() {
  const events = [];
  return { events, onEvent: (ev) => events.push(ev) };
}

test('touchEvent 形状：shell/kind/ref/detail，kind 越枚举即拒', () => {
  const ev = touchEvent('task_progress', 'pianist-acp-x', { tool: 'bash' });
  assert.equal(ev.shell, 'pianist');
  assert.equal(ev.kind, 'task_progress');
  assert.equal(ev.ref, 'pianist-acp-x');
  assert.deepEqual(Object.keys(ev).sort(), ['detail', 'kind', 'ref', 'shell']);
  assert.equal(TOUCH_KINDS.length, 6);
  assert.throws(() => touchEvent('token_delta', 'x'), /触感 kind 不在标准枚举/);
  assert.throws(() => touchEvent('heartbeat', ''), /ref 必填/);
});

test('映射：tool_use→task_progress，message_end→heartbeat，agent→ref', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'pianist-acp-1-2026-11-17.jsonl'), toolLine('pianist-acp-1') + msgEndLine('pianist-acp-1'));
  const { events, onEvent } = collect();
  const r = createReader({ telemetryDir: dir, agents: 'pianist-acp-1', startAt: 'beginning', now: () => new Date('2026-11-17T12:00:00Z'), onEvent });
  r.tick();
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'task_progress');
  assert.equal(events[0].ref, 'pianist-acp-1');
  assert.equal(events[0].detail.tool, 'bash');
  assert.equal(events[1].kind, 'heartbeat');
  assert.deepEqual(events[1].detail.usage.totalTokens, 3);
  r.stop();
});

test('tail 增量：只读新增字节，旧账不重放（startAt:end 缺省）', () => {
  const dir = freshDir();
  const f = path.join(dir, 'pianist-acp-2-2026-11-17.jsonl');
  fs.writeFileSync(f, toolLine('pianist-acp-2')); // 预存历史
  const { events, onEvent } = collect();
  const r = createReader({ telemetryDir: dir, agents: ['pianist-acp-2'], now: () => new Date('2026-11-17T12:00:00Z'), onEvent });
  r.tick();
  assert.equal(events.length, 0, '首见从文件尾起步：历史不重放');
  fs.appendFileSync(f, msgEndLine('pianist-acp-2'));
  r.tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'heartbeat');
  fs.appendFileSync(f, toolLine('pianist-acp-2', 'read'));
  r.tick();
  assert.equal(events.length, 2);
  assert.equal(events[1].detail.tool, 'read');
  r.stop();
});

test('跨日界切换：旧文件残余排干 + 新文件从头读 + 日界后写进旧文件的竞态不丢', () => {
  const dir = freshDir();
  const oldFile = path.join(dir, 'pianist-acp-3-2026-11-17.jsonl');
  const newFile = path.join(dir, 'pianist-acp-3-2026-11-18.jsonl');
  fs.writeFileSync(oldFile, toolLine('pianist-acp-3'));

  let day = new Date('2026-11-17T23:59:00.000Z');
  const { events, onEvent } = collect();
  const r = createReader({ telemetryDir: dir, agents: 'pianist-acp-3', startAt: 'beginning', now: () => day, onEvent });
  r.tick();
  assert.equal(events.length, 1, 'D1 旧文件读到');

  day = new Date('2026-11-18T00:00:30.000Z'); // 翻面
  fs.writeFileSync(newFile, msgEndLine('pianist-acp-3')); // 新文件已有内容
  fs.appendFileSync(oldFile, toolLine('pianist-acp-3', 'edit')); // 日界后仍写进旧文件（竞态）
  r.tick();
  const kinds = events.map((e) => e.kind);
  // 新文件 heartbeat（从头读）+ 旧文件 edit（linger 排干）；顺序不保证，但两条都在
  assert.equal(events.length, 3, `跨日界两条都不丢，实得 ${events.length}`);
  assert.ok(kinds.includes('heartbeat'));
  assert.ok(kinds.includes('task_progress') && events.some((e) => e.detail.tool === 'edit'));

  // linger 退场：再无新增，重读不重复
  r.tick();
  assert.equal(events.length, 3, '排干过的不再重放');
  r.stop();
});

test('跨日界切换（阴性对照腿）：拆掉 linger 排干则日界后旧文件事件丢失', () => {
  // 本测钉住「日界竞态兜底」语义：oldFile 在切换 tick 之后才追加的事件也必须被读到。
  // 突变验收（拆 reader 日界切换→跨日界腿红）时：把 reader 的 linger 机制注释掉本测应红。
  const dir = freshDir();
  const oldFile = path.join(dir, 'pianist-acp-9-2026-11-17.jsonl');
  const newFile = path.join(dir, 'pianist-acp-9-2026-11-18.jsonl');
  fs.writeFileSync(oldFile, toolLine('pianist-acp-9'));

  let day = new Date('2026-11-17T23:59:00.000Z');
  const { events, onEvent } = collect();
  const r = createReader({ telemetryDir: dir, agents: 'pianist-acp-9', startAt: 'beginning', now: () => day, onEvent });
  r.tick();
  day = new Date('2026-11-18T00:00:30.000Z');
  fs.writeFileSync(newFile, '');
  r.tick(); // 切换 tick：旧文件此刻无新增
  fs.appendFileSync(oldFile, msgEndLine('pianist-acp-9')); // 切换之后才落旧文件
  r.tick(); // linger 面应捞到
  assert.equal(events.length, 2, '切换后写进旧文件的 message_end 必须被 linger 捞回');
  assert.equal(events[1].kind, 'heartbeat');
  r.stop();
});

test('坏行跳过不炸、未知 kind 计数、文件截断重置', () => {
  const dir = freshDir();
  const f = path.join(dir, 'pianist-acp-4-2026-11-17.jsonl');
  // 首写比后续重写更长（真截断形状：size < offset）
  fs.writeFileSync(f, `{oops 不是json${'　'.repeat(200)}\n` + line({ v: 1, ts: 'x', agent: 'pianist-acp-4', kind: 'session_startish', data: {}, pad: 'x'.repeat(300) }));
  const { events, onEvent } = collect();
  const r = createReader({ telemetryDir: dir, agents: 'pianist-acp-4', startAt: 'beginning', now: () => new Date('2026-11-17T12:00:00Z'), onEvent });
  r.tick();
  assert.equal(events.length, 0);
  assert.equal(r.skipped.malformed, 1);
  assert.equal(r.skipped.unknownKind, 1);

  fs.writeFileSync(f, toolLine('pianist-acp-4')); // 截断重写（size < offset）
  r.tick();
  assert.equal(events.length, 1, '截断后从 0 重读');
  r.stop();
});

test('classifyToolUse 钩子：可改判 subagent_spawn/exit 或吞掉', () => {
  const dir = freshDir();
  fs.writeFileSync(
    path.join(dir, 'pianist-acp-5-2026-11-17.jsonl'),
    toolLine('pianist-acp-5', 'pianist_bridge') + toolLine('pianist-acp-5', 'bash'),
  );
  const { events, onEvent } = collect();
  const r = createReader({
    telemetryDir: dir,
    agents: 'pianist-acp-5',
    startAt: 'beginning',
    now: () => new Date('2026-11-17T12:00:00Z'),
    onEvent,
    classifyToolUse: (entry) => (entry.data?.tool === 'pianist_bridge' ? 'subagent_spawn' : null),
  });
  r.tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'subagent_spawn');
  r.stop();
});

test('start/stop：start 立即首巡，stop 后不再吐（判据：秒级可读）', async () => {
  const dir = freshDir();
  const f = path.join(dir, 'pianist-acp-6-2026-11-17.jsonl');
  fs.writeFileSync(f, '');
  const { events, onEvent } = collect();
  const r = createReader({ telemetryDir: dir, agents: 'pianist-acp-6', intervalMs: 40, now: () => new Date('2026-11-17T12:00:00Z'), onEvent });
  r.start();
  assert.equal(events.length, 0, 'start 首巡读空文件无事件');
  const t0 = Date.now();
  await new Promise((res) => setTimeout(res, 30)); // 等 spawn 侧写遥测（此处直接模拟写）
  fs.appendFileSync(f, toolLine('pianist-acp-6'));
  await new Promise((res) => setTimeout(res, 120));
  const latency = Date.now() - t0;
  assert.equal(events.length, 1);
  assert.ok(latency < 1000, `事件在秒级内可读（${latency}ms）`);
  r.stop();
  fs.appendFileSync(f, toolLine('pianist-acp-6'));
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(events.length, 1, 'stop 后不再吐');
});

test('agents 必填校验', () => {
  assert.throws(() => createReader({ telemetryDir: '/tmp', agents: [] }), /agents 必填/);
  assert.throws(() => createReader({ agents: 'x' }), /telemetryDir 必填/);
});
