// test/threads.test.mjs —— thread 行为层（P1a §4）：dm 唯一性 / 归档找回 / purge 全清 / 消息形状校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import {
  createThread,
  findDmByMembers,
  archiveThread,
  unarchiveThread,
  listThreads,
  appendMessage,
  listThreadMessages,
  joinThread,
  leaveThread,
  switchAgent,
  exportThread,
  exportPathForThread,
  purgeThread,
  getThread,
  listThreadMembers,
} from '../src/threads.mjs';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-threads-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, dir };
}

const U = 'p:u-0001';
const A = 'a:alpha-0001';
const B = 'a:beta-0002';

// —— dm 唯一性（应用层 upsert-复用） ——

test('dm user↔agent 恰一：重复建拿到同一条，成员序不同也算同一对', () => {
  const { db } = fresh();
  const t1 = createThread(db, { type: 'dm', createdBy: U, memberIds: [U, A] });
  const t2 = createThread(db, { type: 'dm', createdBy: A, memberIds: [A, U] }); // 序倒过来
  const t3 = createThread(db, { type: 'dm', createdBy: U, memberIds: [U, A] });
  assert.equal(t1.id, t2.id);
  assert.equal(t2.id, t3.id);
  assert.equal(t1.type, 'dm');
  assert.equal(t1.title, null); // dm 为 NULL（无主题是 dm 的定义）
  const n = db.prepare("SELECT COUNT(*) AS c FROM threads WHERE type='dm'").get();
  assert.equal(n.c, 1, '库里只有一条 dm');
  assert.equal(findDmByMembers(db, [A, U]).id, t1.id);
  db.close();
});

test('dm agent↔agent 恰一：纯 agent 私聊同表同法', () => {
  const { db } = fresh();
  const t1 = createThread(db, { type: 'dm', createdBy: A, memberIds: [A, B] });
  const t2 = createThread(db, { type: 'dm', createdBy: B, memberIds: [B, A] });
  assert.equal(t1.id, t2.id);
  assert.equal(findDmByMembers(db, [B, A]).id, t1.id);
  // 与 user↔agent 的 dm 互不串
  const u = createThread(db, { type: 'dm', createdBy: U, memberIds: [U, A] });
  assert.notEqual(u.id, t1.id);
  db.close();
});

test('dm 形状铁则：恰两人 / 无主题 / 不挂项目 / 不可自聊', () => {
  const { db } = fresh();
  assert.throws(() => createThread(db, { type: 'dm', createdBy: U, memberIds: [U, A, B] }), /恰两人/);
  assert.throws(() => createThread(db, { type: 'dm', createdBy: U, memberIds: [U, A], title: '私聊不该有主题' }), /不挂主题/);
  assert.throws(() => createThread(db, { type: 'dm', createdBy: U, memberIds: [U, A], projectIds: ['prj:ocean'] }), /不挂项目/);
  assert.throws(() => createThread(db, { type: 'dm', createdBy: A, memberIds: [A, A] }), /有重复|不得相同/); // 自聊=同身份双挂，去重检查先拦
  assert.throws(() => createThread(db, { type: 'groupchat', createdBy: U, memberIds: [U, A] }), /dm\|topic/);
  db.close();
});

test('topic：可多开、挂项目多对多、user 或 agent 建同权', () => {
  const { db } = fresh();
  const t1 = createThread(db, { type: 'topic', title: '听海', createdBy: U, memberIds: [U, A], projectIds: ['prj:ocean-listen', 'prj:portalk'] });
  const t2 = createThread(db, { type: 'topic', title: '听海（又一窗）', createdBy: A, memberIds: [U, A], projectIds: ['prj:ocean-listen'] });
  assert.notEqual(t1.id, t2.id, 'topic 无唯一性，随便开');
  const projects = db.prepare('SELECT project_id FROM thread_projects WHERE thread_id=? ORDER BY project_id').all(t1.id).map((r) => r.project_id);
  assert.deepEqual(projects, ['prj:ocean-listen', 'prj:portalk']);
  db.close();
});

// —— 归档找回 ——

test('归档：默认列表不可见，includeArchived 调出，unarchive 回列表', () => {
  const { db } = fresh();
  const keep = createThread(db, { type: 'topic', title: '在册', createdBy: U, memberIds: [U, A] });
  const gone = createThread(db, { type: 'topic', title: '归档件', createdBy: U, memberIds: [U, A] });
  const archived = archiveThread(db, gone.id);
  assert.ok(archived.archived_at, '归档时间戳落库');
  let list = listThreads(db).map((t) => t.id);
  assert.ok(list.includes(keep.id));
  assert.ok(!list.includes(gone.id), '归档从列表摘除');
  list = listThreads(db, { includeArchived: true }).map((t) => t.id); // 筛选按钮调出
  assert.ok(list.includes(gone.id));
  assert.ok(archiveThread(db, gone.id).archived_at, '归档幂等：时间戳不丢');
  unarchiveThread(db, gone.id); // 点开继续聊=回列表
  list = listThreads(db).map((t) => t.id);
  assert.ok(list.includes(gone.id));
  db.close();
});

test('墓碑：deleted_at 置位的行默认不可见，includeDeleted 调出', () => {
  const { db } = fresh();
  const t = createThread(db, { type: 'topic', title: '墓碑件', createdBy: U, memberIds: [U, A] });
  db.prepare('UPDATE threads SET deleted_at=? WHERE id=?').run('2026-11-16T00:00:00Z', t.id); // 墓碑只由 purge 之外的外部写手置（软删防孤儿）
  assert.ok(!listThreads(db).some((x) => x.id === t.id));
  assert.ok(!listThreads(db, { includeArchived: true }).some((x) => x.id === t.id));
  assert.ok(listThreads(db, { includeDeleted: true }).some((x) => x.id === t.id));
  db.close();
});

// —— 发消息（只做形状校验，不做轮次推断） ——

test('appendMessage 形状校验：双指针必填 / role 枚举 / speaker 在成员表 / thread 存在', () => {
  const { db } = fresh();
  const t = createThread(db, { type: 'topic', title: '形状', createdBy: U, memberIds: [U, A] });
  const m = appendMessage(db, { thread_id: t.id, session_id: 's:ep-001', speaker_id: U, role: 'user', content: '你好' });
  assert.equal(m.thread_id, t.id);
  assert.equal(m.speaker_id, U);
  assert.equal(m.role, 'user');

  assert.throws(() => appendMessage(db, { session_id: 's', speaker_id: U, role: 'user', content: 'x' }), /thread_id 必填/);
  assert.throws(() => appendMessage(db, { thread_id: t.id, speaker_id: U, role: 'user', content: 'x' }), /session_id 必填/);
  assert.throws(() => appendMessage(db, { thread_id: t.id, session_id: 's', role: 'user', content: 'x' }), /speaker_id 必填/);
  assert.throws(() => appendMessage(db, { thread_id: t.id, session_id: 's', speaker_id: U, role: 'system', content: 'x' }), /user\|agent/);
  assert.throws(() => appendMessage(db, { thread_id: t.id, session_id: 's', speaker_id: U, role: 'user', content: 42 }), /content 必须是字符串/);
  assert.throws(() => appendMessage(db, { thread_id: 'th:none', session_id: 's', speaker_id: U, role: 'user', content: 'x' }), /thread 不存在/);
  assert.throws(() => appendMessage(db, { thread_id: t.id, session_id: 's', speaker_id: 'a:stranger', role: 'agent', content: 'x' }), /不在本 thread 成员表/);
  db.close();
});

test('轮次铁律不归本层：连续 agent 消息照收（回归护栏，防本层私做轮次推断）', () => {
  const { db } = fresh();
  const t = createThread(db, { type: 'topic', title: '轮次', createdBy: U, memberIds: [U, A] });
  appendMessage(db, { thread_id: t.id, session_id: 's:1', speaker_id: A, role: 'agent', content: 'agent 先说' });
  appendMessage(db, { thread_id: t.id, session_id: 's:2', speaker_id: A, role: 'agent', content: 'agent 又说' }); // 规格外形状留给引擎层 P2 判
  assert.equal(listThreadMessages(db, t.id).length, 2);
  db.close();
});

test('切走的成员不可发言', () => {
  const { db } = fresh();
  const t = createThread(db, { type: 'topic', title: '切换', createdBy: U, memberIds: [U, A] });
  leaveThread(db, t.id, A);
  assert.throws(() => appendMessage(db, { thread_id: t.id, session_id: 's', speaker_id: A, role: 'agent', content: 'x' }), /已切走/);
  db.close();
});

// —— 成员进出 / 切身份 ——

test('topic 切 agent 身份：切走记 left_at，切回归位旧行；dm 锁身份拒切', () => {
  const { db } = fresh();
  const t = createThread(db, { type: 'topic', title: '共享窗口', createdBy: U, memberIds: [U, A] });
  joinThread(db, t.id, B); // 拉 B 进来
  const switched = switchAgent(db, t.id, { from: A, to: B }); // 窗口内共享 agent：A 切走 B 切进
  assert.equal(switched.member_id, B);
  assert.equal(switched.left_at, null);
  const aRow = db.prepare('SELECT * FROM thread_members WHERE thread_id=? AND member_id=?').get(t.id, A);
  assert.ok(aRow.left_at, 'A 的 left_at 落账（身份切换史）');
  assert.equal(listThreadMembers(db, t.id).filter((m) => m.left_at === null).map((m) => m.member_id).sort().join(','), [U, B].sort().join(','));

  // A 切回：复活旧行（PK 一人一行），joined_at 更新
  const back = switchAgent(db, t.id, { from: B, to: A });
  assert.ok(back.joined_at >= aRow.joined_at, '切回=复活旧行，joined_at 更新为回归时间');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM thread_members WHERE thread_id=?').get(t.id).c, 3, '仍是一人一行（A/B/U）');

  const dm = createThread(db, { type: 'dm', createdBy: U, memberIds: [U, A] });
  assert.throws(() => switchAgent(db, dm.id, { from: A, to: B }), /dm 锁身份/);
  db.close();
});

// —— 导出与删除（purgeThread 一个口全清） ——

test('purgeThread 全清：消息行归零 + 导出文件消失 + threads 行消失 + 挂表行清空', () => {
  const { db, dir } = fresh();
  const exports = path.join(dir, 'exports');
  const t = createThread(db, { type: 'topic', title: '要删的窗', createdBy: U, memberIds: [U, A], projectIds: ['prj:x'] });
  appendMessage(db, { thread_id: t.id, session_id: 's:1', speaker_id: U, role: 'user', content: '第一条' });
  appendMessage(db, { thread_id: t.id, session_id: 's:1', speaker_id: A, role: 'agent', content: '第二条' });
  const file = exportThread(db, t.id, exports);
  assert.ok(fs.existsSync(file), '导出文件已生成');
  assert.match(fs.readFileSync(file, 'utf8'), /要删的窗/);

  const r = purgeThread(db, t.id, { exportDir: exports });
  assert.equal(r.threadGone, true);
  assert.equal(getThread(db, t.id), null, 'threads 行消失');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages WHERE thread_id=?').get(t.id).c, 0, '消息行归零');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM thread_members WHERE thread_id=?').get(t.id).c, 0, '成员挂行清');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM thread_projects WHERE thread_id=?').get(t.id).c, 0, '项目挂行清');
  assert.equal(fs.existsSync(file), false, '导出文件消失');
  db.close();
});

test('purgeThread：thread 行不在=报错不静默（阴性对照）', () => {
  const { db, dir } = fresh();
  assert.throws(() => purgeThread(db, 'th:nonexistent', { exportDir: path.join(dir, 'exports') }), /thread 不存在/);
  db.close();
});

test('dm 前端不可删：purgeThread 默认拒私聊，force 才走系统级清理', () => {
  const { db, dir } = fresh();
  const dm = createThread(db, { type: 'dm', createdBy: U, memberIds: [U, A] });
  appendMessage(db, { thread_id: dm.id, session_id: 's', speaker_id: U, role: 'user', content: 'hi' });
  assert.throws(() => purgeThread(db, dm.id, { exportDir: dir }), /私聊永不关闭/);
  assert.ok(getThread(db, dm.id), '默认拒后 dm 还在');
  purgeThread(db, dm.id, { exportDir: dir, force: true });
  assert.equal(getThread(db, dm.id), null);
  db.close();
});

test('purge 后 dm 重开=新 thread（旧窗已干净消失，无复用残留）', () => {
  const { db } = fresh();
  const dm1 = createThread(db, { type: 'dm', createdBy: U, memberIds: [U, A] });
  purgeThread(db, dm1.id, { force: true, exportDir: os.tmpdir() });
  const dm2 = createThread(db, { type: 'dm', createdBy: U, memberIds: [U, A] });
  assert.notEqual(dm1.id, dm2.id);
  db.close();
});

test('exportPathForThread：th:uuid → th_uuid.md（冒号换下划线）', () => {
  assert.equal(exportPathForThread('/x', 'th:abc-123'), path.join('/x', 'th_abc-123.md'));
});
