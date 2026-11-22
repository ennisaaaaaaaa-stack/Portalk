// test/memory-remind.test.mjs —— P2B 记忆提醒（判据 7）：权限位/恰一次/豁免链/配置面
// 突变锚点：拆 newSession 的 prompt0 拼接（提醒不进 argv）→ 「恰一次送达 agent」断言红；
//           拆 memoryReminder 豁免行 → pianist 零提醒断言红。突变实验记录见 self-review.md §突变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.mjs';
import { listThreadMessages } from '../src/threads.mjs';
import { loadMembers } from '../src/loader.mjs';
import { createAcpAdapter, memoryReminder, MEMORY_REMIND_TEXT } from '../src/acp-adapter.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MOCK_PI = fileURLToPath(new URL('./mock-pi.mjs', import.meta.url));
const USER = 'p:u-0001';
const AGENT = 'a:hermes-0001';

// ---------------------------------------------------------------------------
// 裁决函数（unit）
// ---------------------------------------------------------------------------

test('memoryReminder：权限位三态 + Pianist 硬豁免（显式开也不吃）', () => {
  // 关/缺省：零提醒
  assert.equal(memoryReminder(null, { slug: 'hermes' }), null);
  assert.equal(memoryReminder({ prefs: {} }, { slug: 'hermes' }), null);
  assert.equal(memoryReminder({ prefs: { memory_remind: false } }, { slug: 'hermes' }), null);
  // 开（非 pianist）：恰一段提醒文本
  assert.equal(memoryReminder({ prefs: { memory_remind: true } }, { slug: 'hermes' }), MEMORY_REMIND_TEXT);
  // Pianist 豁免：硬规则最优先
  assert.equal(memoryReminder({ prefs: { memory_remind: true } }, { slug: 'pianist' }), null);
});

// ---------------------------------------------------------------------------
// 配置面：schema 权限位过闸（loader 载入）
// ---------------------------------------------------------------------------

test('配置面：prefs.memory_remind 权限位进 schema v1（manifest 带位载入过闸）', () => {
  const membersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-remind-members-'));
  fs.copyFileSync(path.join(REPO_ROOT, 'members', 'schema.json'), path.join(membersDir, 'schema.json'));
  fs.copyFileSync(path.join(REPO_ROOT, 'members', 'pianist.yaml'), path.join(membersDir, 'pianist.yaml'));
  // 造一位非 pianist 成员：权限位开
  fs.writeFileSync(
    path.join(membersDir, 'hermes.yaml'),
    [
      'manifest_version: 1',
      'slug: hermes',
      'kind: agent',
      'agent_id: a:hermes-0001',
      'identity:',
      '  memory:',
      '    ref: tideline:///tmp/hermes-mem.db',
      '    liveness: file',
      'perms:',
      '  project: []',
      '  interact: []',
      '  dialog:',
      '    - threads:own:*',
      'prefs:',
      '  memory_remind: true',
      '',
    ].join('\n'),
    'utf8',
  );
  const result = loadMembers(membersDir);
  assert.ok(result.ok, `带权限位的 manifest 该过闸：${JSON.stringify(result.errors)}`);
  assert.equal(result.tree.hermes.prefs.memory_remind, true);
  assert.equal(result.tree.pianist.prefs, undefined, 'pianist 出厂无 prefs（豁免不靠配置缺省）');
});

// ---------------------------------------------------------------------------
// 端到端（mock-pi）：提醒恰一次送达 agent，不进对话史
// ---------------------------------------------------------------------------

async function fresh(adapterOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-remind-'));
  const db = openDb(path.join(dir, 't.db'));
  const sessionDir = path.join(dir, 'sessions');
  const adapter = createAcpAdapter({
    db,
    pianistAgentId: AGENT,
    userId: USER,
    piCommand: process.execPath,
    piBaseArgs: [MOCK_PI],
    cwd: dir,
    sessionDir,
    telemetryDir: path.join(dir, 'telemetry'),
    env: {},
    ...adapterOpts,
  });
  return { dir, db, sessionDir, adapter, close: () => { adapter.stop(); db.close(); } };
}

// 读 mock-pi 会话文件里全部 user 行 content（argv 面即 agent 读到的 prompt）
function userLinesOf(sessionDir, sessionId) {
  const name = fs.readdirSync(sessionDir).find((n) => n.endsWith(`_${sessionId}.jsonl`));
  const lines = fs.readFileSync(path.join(sessionDir, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return lines.filter((l) => l.type === 'message' && l.message?.role === 'user').map((l) => l.message.content);
}

test('端到端：权限位开→提醒进首轮 prompt 恰一次、不进 thread 库（库里是用户原话）', async () => {
  const f = await fresh({ memoryRemind: true, slug: 'hermes' }); // slug 必须非 pianist（豁免硬规则最优先）
  try {
    const s = await f.adapter.newSession({ task: '干活' });
    const lines = userLinesOf(f.sessionDir, s.sessionId);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith(MEMORY_REMIND_TEXT), '提醒在首轮 prompt 头（送达 agent）');
    assert.ok(lines[0].endsWith('干活'), '用户原话跟在提醒后');

    // thread 库：首条 user 消息=原 task（提醒不进对话史）
    const msgs = listThreadMessages(f.db, s.threadId);
    assert.equal(msgs.filter((m) => m.role === 'user').length, 1);
    assert.equal(msgs.find((m) => m.role === 'user').content, '干活');

    // 续轮不再注入（恰一次的闸=session new 唯一）
    await f.adapter.prompt(s, '接着干');
    const lines2 = userLinesOf(f.sessionDir, s.sessionId);
    assert.equal(lines2.length, 2);
    assert.ok(!lines2[1].includes('记忆提醒'), '续轮零提醒');
    assert.ok(lines2[1].startsWith('接着干'));
    f.adapter.close(s);
  } finally {
    f.close();
  }
});

test('端到端：每 session 一次≠全局一次（新 session 再提醒一次）', async () => {
  const f = await fresh({ memoryRemind: true, slug: 'hermes' });
  try {
    const s1 = await f.adapter.newSession({ task: '一号活' });
    const s2 = await f.adapter.newSession({ task: '二号活' });
    assert.ok(userLinesOf(f.sessionDir, s1.sessionId)[0].includes('记忆提醒'));
    assert.ok(userLinesOf(f.sessionDir, s2.sessionId)[0].includes('记忆提醒'), '每 session 恰一次（判据 7 的时基是 session）');
    f.adapter.close(s1);
    f.adapter.close(s2);
  } finally {
    f.close();
  }
});

test('端到端：权限位关→零提醒；pianist 豁免→显式开也不吃', async () => {
  // 关（缺省）
  {
    const f = await fresh({});
    try {
      const s = await f.adapter.newSession({ task: '静默干活' });
      assert.ok(!userLinesOf(f.sessionDir, s.sessionId)[0].includes('记忆提醒'), '权限位缺省=零提醒');
      f.adapter.close(s);
    } finally {
      f.close();
    }
  }
  // pianist 豁免：显式 memoryRemind=true 也不吃
  {
    const f = await fresh({ memoryRemind: true, slug: 'pianist' });
    try {
      const s = await f.adapter.newSession({ task: 'pianist 不吃提醒' });
      assert.ok(!userLinesOf(f.sessionDir, s.sessionId)[0].includes('记忆提醒'), 'Pianist 豁免是硬规则');
      f.adapter.close(s);
    } finally {
      f.close();
    }
  }
});
