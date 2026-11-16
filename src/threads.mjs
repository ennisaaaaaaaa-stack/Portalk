// src/threads.mjs —— thread 行为层（P1a 蓝图 §4 行为规格）
//
// - dm 唯一性：应用层 upsert-复用（§3【选型】落定：跨 dm 两种形态约束逻辑更简单）
// - 归档/删除是两个独立动作：归档=时间戳+默认列表滤除；删除=purgeThread() 一个口全清
//   （thread 行 + 消息行 + 导出 markdown + 成员/项目挂表行）
// - appendMessage 只做 schema 形状校验（thread 存在、speaker 在成员表且未切走、role 枚举、双指针必填），
//   不做轮次推断——topic 轮次铁律（每轮必 user 收尾、只有 user 触发 agent 输出）归引擎层 P2。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();

export function getThread(db, threadId) {
  return db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) ?? null;
}

function requireThread(db, threadId) {
  const t = getThread(db, threadId);
  if (!t) throw new Error(`thread 不存在：${threadId}`);
  return t;
}

export function listThreadMembers(db, threadId) {
  return db.prepare('SELECT * FROM thread_members WHERE thread_id = ? ORDER BY joined_at, rowid').all(threadId);
}

// —— 建 thread（§4：topic 由 user 或 agent 建，created_by 同权；dm 不可「新建」多开，复用唯一通道） ——
export function createThread(db, { type, title = null, createdBy, memberIds, projectIds = [] }) {
  if (type !== 'dm' && type !== 'topic') {
    throw new Error(`thread 类型只有 dm|topic（P1a §2 定案，无第三种），收到：${JSON.stringify(type)}`);
  }
  if (!createdBy || typeof createdBy !== 'string') {
    throw new Error('created_by 必填（member_id，user 或 agent 同权）');
  }
  if (!Array.isArray(memberIds) || memberIds.length === 0) throw new Error('memberIds 必填（至少一名成员）');
  const members = [...new Set(memberIds)];
  if (members.length !== memberIds.length) throw new Error(`memberIds 有重复：${JSON.stringify(memberIds)}`);
  for (const m of members) {
    if (typeof m !== 'string' || m === '') throw new Error(`成员 ID 必须是非空字符串：${JSON.stringify(m)}`);
  }
  if (!Array.isArray(projectIds)) throw new Error('projectIds 必须是数组');

  if (type === 'dm') {
    if (title != null) throw new Error('dm 不挂主题（title 必须为 NULL——无主题是 dm 的定义，P1a §3）');
    if (projectIds.length > 0) throw new Error('dm 不挂项目（P1a §2：dm 不挂项目，仅 topic 挂）');
    if (members.length !== 2) {
      throw new Error(`dm 恰两人（user↔agent 或 agent↔agent），收到 ${members.length} 人；≥3 主体=群聊形态走参与规则引擎，不进树`);
    }
    if (members[0] === members[1]) throw new Error('dm 两人不得相同');
    const existing = findDmByMembers(db, members);
    if (existing) return existing; // 应用层 upsert-复用：每 agent 身份/每对 agent 恰一 dm，重复建=拿回同一条
  }

  const id = `th:${randomUUID()}`; // th:{uuid}【选型：对齐 m:/t:/v: 家族】
  const ts = now();
  db.prepare('INSERT INTO threads (id, type, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, type, title ?? null, createdBy, ts);
  const insMember = db.prepare('INSERT INTO thread_members (thread_id, member_id, joined_at) VALUES (?, ?, ?)');
  for (const m of members) insMember.run(id, m, ts);
  const insProject = db.prepare('INSERT OR IGNORE INTO thread_projects (thread_id, project_id) VALUES (?, ?)');
  for (const p of [...new Set(projectIds)]) insProject.run(id, p);
  return getThread(db, id);
}

// dm 唯一性查询：成员集合恰为 {a,b} 的在册 dm（删过的不算——purge 已全清）
export function findDmByMembers(db, memberIds) {
  const [a, b] = [...memberIds].sort();
  const rows = db
    .prepare(
      `SELECT t.* FROM threads t
       WHERE t.type = 'dm' AND t.deleted_at IS NULL
         AND (SELECT COUNT(*) FROM thread_members tm WHERE tm.thread_id = t.id) = 2
         AND EXISTS (SELECT 1 FROM thread_members x WHERE x.thread_id = t.id AND x.member_id = ?)
         AND EXISTS (SELECT 1 FROM thread_members y WHERE y.thread_id = t.id AND y.member_id = ?)`,
    )
    .all(a, b);
  if (rows.length > 1) {
    throw new Error(`dm 唯一性已破损（${a}↔${b} 存在 ${rows.length} 条在册 dm）——请走 purgeThread 清理后重建`);
  }
  return rows[0] ?? null;
}

// —— 归档（§4：从列表摘除、消息保留；≠删除）。幂等。 ——
export function archiveThread(db, threadId) {
  const t = requireThread(db, threadId);
  if (t.deleted_at) throw new Error(`thread 已删除（墓碑），不可归档：${threadId}`);
  if (t.archived_at) return getThread(db, threadId);
  db.prepare('UPDATE threads SET archived_at = ? WHERE id = ?').run(now(), threadId);
  return getThread(db, threadId);
}

// —— 归档找回（§4，11-16 定案：筛选按钮调出；点开继续聊=回列表） ——
export function unarchiveThread(db, threadId) {
  requireThread(db, threadId);
  db.prepare('UPDATE threads SET archived_at = NULL WHERE id = ?').run(threadId);
  return getThread(db, threadId);
}

// 列表默认滤掉归档与墓碑；includeArchived / includeDeleted 调出
export function listThreads(db, { includeArchived = false, includeDeleted = false, type } = {}) {
  let sql = 'SELECT * FROM threads WHERE 1=1';
  const params = [];
  if (!includeArchived) sql += ' AND archived_at IS NULL';
  if (!includeDeleted) sql += ' AND deleted_at IS NULL';
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  sql += ' ORDER BY created_at, rowid';
  return db.prepare(sql).all(...params);
}

// —— 发消息（§4：双指针落库；只做形状校验，不做轮次推断） ——
export function appendMessage(db, { thread_id, session_id, speaker_id, role, content, id, created_at } = {}) {
  if (!thread_id || typeof thread_id !== 'string') throw new Error('thread_id 必填（住哪个窗口）');
  if (!session_id || typeof session_id !== 'string') throw new Error('session_id 必填（哪口气说的——接缝国法：thread_id 归 Portalk，session_id 归 EP）');
  if (!speaker_id || typeof speaker_id !== 'string') throw new Error('speaker_id 必填（记身份 ID 非壳——P0 定案）');
  if (role !== 'user' && role !== 'agent') throw new Error(`role 必须是 user|agent，收到：${JSON.stringify(role)}`);
  if (typeof content !== 'string') throw new Error(`content 必须是字符串，收到：${typeof content}`);

  const thread = requireThread(db, thread_id);
  if (thread.deleted_at) throw new Error(`thread 已删除（墓碑），拒收消息：${thread_id}`);

  const member = db.prepare('SELECT * FROM thread_members WHERE thread_id = ? AND member_id = ?').get(thread_id, speaker_id);
  if (!member) throw new Error(`speaker_id 不在本 thread 成员表：${speaker_id}`);
  if (member.left_at) throw new Error(`speaker 已切走（left_at=${member.left_at}），不可发言：${speaker_id}`);
  // 轮次形状（上一条 user、这条 agent……）不在此推断：轮次铁律归引擎层 P2

  const mid = id ?? `m:${randomUUID()}`;
  db.prepare(
    'INSERT INTO messages (id, session_id, thread_id, speaker_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(mid, session_id, thread_id, speaker_id, role, content, created_at ?? now());
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(mid);
}

export function listThreadMessages(db, threadId) {
  return db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY rowid').all(threadId);
}

// —— 成员进出 / 切身份（§4：仅 topic 可切；user 恒为成员由调用方保证——引擎知道谁是 user） ——
export function joinThread(db, threadId, memberId) {
  requireThread(db, threadId);
  const existing = db.prepare('SELECT * FROM thread_members WHERE thread_id = ? AND member_id = ?').get(threadId, memberId);
  const ts = now();
  if (existing && existing.left_at === null) return existing; // 已在，幂等
  if (existing) {
    // 复活旧行【选型落定】：PK (thread_id, member_id) 强制一人一行，切回=清 left_at、joined_at 更新为回归时间
    db.prepare('UPDATE thread_members SET left_at = NULL, joined_at = ? WHERE thread_id = ? AND member_id = ?').run(ts, threadId, memberId);
  } else {
    db.prepare('INSERT INTO thread_members (thread_id, member_id, joined_at) VALUES (?, ?, ?)').run(threadId, memberId, ts);
  }
  return db.prepare('SELECT * FROM thread_members WHERE thread_id = ? AND member_id = ?').get(threadId, memberId);
}

export function leaveThread(db, threadId, memberId) {
  requireThread(db, threadId);
  const r = db
    .prepare('UPDATE thread_members SET left_at = ? WHERE thread_id = ? AND member_id = ? AND left_at IS NULL')
    .run(now(), threadId, memberId);
  if (r.changes === 0) throw new Error(`成员不在或已切走，无法记 left_at：${memberId}`);
  return db.prepare('SELECT * FROM thread_members WHERE thread_id = ? AND member_id = ?').get(threadId, memberId);
}

// 切 agent 身份：仅 topic（dm 锁身份，P1a §2 分类学）
export function switchAgent(db, threadId, { from, to }) {
  const t = requireThread(db, threadId);
  if (t.type === 'dm') throw new Error('dm 锁身份不可切（P1a §2：只有 topic 可切 agent 身份）');
  if (!from || !to) throw new Error('switchAgent 需 { from, to }（切走谁、切进谁）');
  leaveThread(db, threadId, from);
  return joinThread(db, threadId, to);
}

// —— 导出 markdown（日历翻阅/导出消费方） ——
export function exportPathForThread(exportDir, threadId) {
  return path.join(exportDir, threadId.replaceAll(':', '_') + '.md'); // th:uuid → th_uuid.md（: 换 _ 跨平台安全）
}

export function exportThread(db, threadId, exportDir = 'data/exports') {
  const t = requireThread(db, threadId);
  const members = listThreadMembers(db, threadId).map((m) => m.member_id);
  const msgs = listThreadMessages(db, threadId);
  const title = t.type === 'dm' ? `私聊：${members.join(' ↔ ')}` : t.title ?? threadId;
  const lines = [`# ${title}`, '', `- thread_id: ${t.id}`, `- type: ${t.type}`, `- 成员: ${members.join(', ')}`, '', '---', ''];
  for (const m of msgs) {
    lines.push(`**${m.speaker_id}（${m.role}）** ${m.created_at} · ${m.session_id}`, '', m.content, '');
  }
  const file = exportPathForThread(exportDir, threadId);
  fs.mkdirSync(exportDir, { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

// —— 删除（§4，11-16 定案）：thread+消息+导出 markdown 全清，thread 干净消失。
// 全 Portalk 只此一个口（消息行、导出文件、threads 行、成员/项目挂表行都走它）。
// dm 前端永不可删（私聊永不关闭）——系统级清理需显式 force:true，默认拒。
export function purgeThread(db, threadId, { exportDir = 'data/exports', force = false } = {}) {
  const t = requireThread(db, threadId); // 行不在=报错不静默
  if (t.type === 'dm' && !force) {
    throw new Error(`私聊永不关闭、前端不可删（P1a §4）；确需系统级清理 ${threadId} 请传 { force: true }`);
  }
  const exportFile = exportPathForThread(exportDir, threadId);
  const exportExisted = fs.existsSync(exportFile);
  db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
  db.prepare('DELETE FROM thread_projects WHERE thread_id = ?').run(threadId);
  db.prepare('DELETE FROM thread_members WHERE thread_id = ?').run(threadId);
  db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  if (exportExisted) fs.rmSync(exportFile); // 导出文件同清；从未导出=无账可清
  return { purged: threadId, exportExisted, messagesGone: true, threadGone: getThread(db, threadId) === null };
}
