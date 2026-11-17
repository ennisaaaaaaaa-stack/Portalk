#!/usr/bin/env node
// test/mock-pi.mjs —— pi 子进程替身（零真 spawn 零真钱：adapter 测试注入 piCommand=node, piBaseArgs=[本文件]）
//
// 模拟 pi -p 的三件与本单相关的事：
//   1. 新会话：在 --session-dir 目录落 `<UTC时间戳(:.→-)>_<uuid>.jsonl`，首行 session header（id=文件名 uuid）
//   2. 续轮（--session-id <id>）：找 `*_<id>.jsonl` 追加一行 user 消息（会话文件连续性）
//   3. 遥测：若 PIANIST_SHELL_URL 在场，POST /telemetry/ingest 上报 tool_use + message_end 两行
//      （真链里这是 pianist-tools 扩展干的活；替身直连 mock 壳，让 reader 有粮可吃）
// 退场：stdout 打 `MOCKPI-OK: <task>`（= pi -p text 模式的最终回话），exit 0。
// 参数形状对齐真 pi：-p --model M --session-dir D [--session-id ID] <task>

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const sessionDir = flagValue('--session-dir');
const sessionId = flagValue('--session-id');
// task = 最后一个不以 - 开头的位置参数（真 pi parseArgs 同语义：位置参数进 messages）
const task = [...argv].reverse().find((a) => !a.startsWith('-'));

if (!sessionDir) {
  console.error('mock-pi: 缺 --session-dir');
  process.exit(2);
}

const uuid = sessionId ?? randomUUID();
const file = path.join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${uuid}.jsonl`);
const line = JSON.stringify({
  type: 'message',
  id: randomUUID().slice(0, 8),
  parentId: null,
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: task ?? '' },
});
if (sessionId) {
  // 续轮：会话文件必须已在（append 一行）；不在=续错对象，大声死
  const existing = fs.readdirSync(sessionDir).find((n) => n.endsWith(`_${sessionId}.jsonl`));
  if (!existing) {
    console.error(`mock-pi: --session-id ${sessionId} 无对应会话文件`);
    process.exit(3);
  }
  fs.appendFileSync(path.join(sessionDir, existing), line + '\n');
} else {
  fs.mkdirSync(sessionDir, { recursive: true });
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: uuid,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  });
  fs.writeFileSync(file, header + '\n' + line + '\n');
}

// 遥测上报（壳不在场=拆卸态：静默跳过，与真扩展语义一致）
const shellUrl = process.env.PIANIST_SHELL_URL;
if (shellUrl) {
  const agent = process.env.PIANIST_AGENT_ID ?? 'pianist-mock-1';
  const ts = new Date().toISOString();
  const events = [
    { ts, agent, kind: 'tool_use', data: { tool: 'read', input: { path: '/tmp/mock' }, isError: false, durationMs: 3, resultBytes: 128 } },
    { ts, agent, kind: 'message_end', data: { usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.0001 } } } },
  ];
  try {
    await fetch(`${shellUrl.replace(/\/$/, '')}/telemetry/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, events }),
    });
  } catch {
    /* 拆卸态静默 */
  }
}

// HANG 任务：写了会话文件后不退场（测 close 的 SIGTERM 兑底），不打印回话
if (task && task.startsWith('HANG')) {
  setInterval(() => {}, 1 << 30);
} else {
  console.log(`MOCKPI-OK: ${task ?? ''}`);
}
