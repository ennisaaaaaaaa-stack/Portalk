// src/db.mjs —— node:sqlite 建库（P1a 蓝图 §3）
//
// 纯 Node 内置（node:sqlite，Node>=22），零 npm 依赖。
// db 文件路径：CLI 参数 --db <path>（或 --db=path）> env PORTALK_DB > 缺省 data/portalk.db（.gitignore 已挡）。

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function resolveDbPath({ argv = process.argv, env = process.env, cwd = process.cwd() } = {}) {
  let fromArgv;
  const i = argv.indexOf('--db');
  if (i !== -1 && i + 1 < argv.length) {
    fromArgv = argv[i + 1];
  } else {
    const eq = argv.find((a) => a.startsWith('--db='));
    if (eq) fromArgv = eq.slice('--db='.length);
  }
  const p = fromArgv || env.PORTALK_DB || 'data/portalk.db';
  return path.resolve(cwd, p);
}

// 打开（或创建）库并确保 schema。返回 DatabaseSync（调用方负责 close）。
export function openDb(dbPath = resolveDbPath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON'); // REFERENCES threads(id) 需要显式开启才真生效
  ensureSchema(db);
  return db;
}

export function ensureSchema(db) {
  // —— P1a 蓝图 §3 SQL 照抄（IF NOT EXISTS 为幂等开库加挂；列注释语义如蓝图文） ——
  db.exec(`
    -- thread 正身（文件是真相：表是索引层，真身=消息与导出的 markdown）
    CREATE TABLE IF NOT EXISTS threads (
      id          TEXT PRIMARY KEY,      -- th:{uuid}【选型：对齐 m:/t:/v: 家族】
      type        TEXT NOT NULL,         -- 'dm' | 'topic'
      title       TEXT,                  -- dm 为 NULL（无主题是dm的定义）
      created_by  TEXT NOT NULL,         -- member_id（user 或 agent 同权；dm 可由首条消息隐式创建）
      created_at  TEXT NOT NULL,
      archived_at TEXT,                  -- 归档时间（11-15 Q3 定案：从列表摘除）；NULL=在列表
      deleted_at  TEXT                   -- 墓碑：软删防孤儿消息引用；删除=thread+消息+导出 markdown 全清（11-16 定案）；NULL=活着
    );

    -- 成员记录（topic 记 agent 身份切换史；dm 两人固定）
    CREATE TABLE IF NOT EXISTS thread_members (
      thread_id   TEXT NOT NULL,
      member_id   TEXT NOT NULL,         -- 引成员位
      joined_at   TEXT NOT NULL,
      left_at     TEXT,                  -- NULL=还在；topic 中 agent 切走=记 left_at（身份切换史）
      PRIMARY KEY (thread_id, member_id)
    );

    -- 多对多，仅 topic（dm 不挂项目）
    CREATE TABLE IF NOT EXISTS thread_projects (
      thread_id   TEXT NOT NULL,
      project_id  TEXT NOT NULL,
      PRIMARY KEY (thread_id, project_id)
    );

    -- 消息表。蓝图原形是对既有 messages 表 ALTER TABLE 加列（挂指针不回填——旧消息没有门牌，
    -- 地址在住户搬进来前钉好）；本仓是新库首建，故指针列直接落进 CREATE，语义同「加列不回填」。
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,      -- m:{uuid}【选型：对齐 th: 家族】
      session_id  TEXT NOT NULL,         -- session_id 归 EP（接缝国法：thread_id 归 Portalk，session_id 归 EP）
      thread_id   TEXT REFERENCES threads(id),  -- 住哪个窗口
      speaker_id  TEXT,                  -- P0 成员位消费方：说话人记身份 ID 非壳（壳信息在 delivery 元数据）
      role        TEXT NOT NULL,         -- 'user' | 'agent'（枚举形状校验在 threads.mjs 行为层）
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);
  return db;
}
