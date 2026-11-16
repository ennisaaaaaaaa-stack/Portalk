// test/db.test.mjs —— 建库三表 + messages 挂指针 + 路径解析
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, resolveDbPath, ensureSchema } from '../src/db.mjs';
import { DatabaseSync } from 'node:sqlite';

function tmpDbPath(name = 'test.db') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-db-')), name);
}

test('建库：threads / thread_members / thread_projects / messages 四表齐', () => {
  const db = openDb(tmpDbPath());
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  assert.ok(tables.includes('threads'));
  assert.ok(tables.includes('thread_members'));
  assert.ok(tables.includes('thread_projects'));
  assert.ok(tables.includes('messages'));
  db.close();
});

test('messages 挂双指针列：thread_id REFERENCES threads(id) + speaker_id', () => {
  const db = openDb(tmpDbPath());
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  assert.ok(cols.includes('thread_id'));
  assert.ok(cols.includes('speaker_id'));
  assert.ok(cols.includes('session_id')); // 接缝国法：双指针
  // REFERENCES 真挂上了：指向不存在的 thread 拒收（PRAGMA foreign_keys=ON）
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO messages (id, session_id, thread_id, speaker_id, role, content, created_at) VALUES ('m:x','s:x','th:none','p:u','user','hi','2026-11-16T00:00:00Z')")
        .run(),
    /FOREIGN KEY/,
  );
  db.close();
});

test('threads 列语义：dm 的 title 可空、archived_at/deleted_at 墓碑列存在', () => {
  const db = openDb(tmpDbPath());
  const cols = db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name);
  for (const c of ['id', 'type', 'title', 'created_by', 'created_at', 'archived_at', 'deleted_at']) {
    assert.ok(cols.includes(c), `缺列 ${c}`);
  }
  db.close();
});

test('幂等开库：同一路径二次 open 不炸（IF NOT EXISTS）', () => {
  const p = tmpDbPath();
  const db1 = openDb(p);
  db1.close();
  const db2 = openDb(p);
  db2.close();
});

test('缺省建到 data/portalk.db（目录自动创建）', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'portalk-cwd-'));
  const p = resolveDbPath({ argv: ['node', 'x'], env: {}, cwd });
  assert.equal(p, path.join(cwd, 'data', 'portalk.db'));
});

test('resolveDbPath 优先级：--db > --db= > PORTALK_DB > 缺省', () => {
  const cwd = '/w';
  assert.equal(resolveDbPath({ argv: ['node', 'x', '--db', 'a.db'], env: { PORTALK_DB: 'b.db' }, cwd }), '/w/a.db');
  assert.equal(resolveDbPath({ argv: ['node', 'x', '--db=a.db'], env: { PORTALK_DB: 'b.db' }, cwd }), '/w/a.db');
  assert.equal(resolveDbPath({ argv: ['node', 'x'], env: { PORTALK_DB: 'b.db' }, cwd }), '/w/b.db');
  assert.equal(resolveDbPath({ argv: ['node', 'x'], env: {}, cwd }), '/w/data/portalk.db');
});

test('ensureSchema 可独立调用（对已开内存库）', () => {
  const db = new DatabaseSync(':memory:');
  ensureSchema(db);
  const n = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get();
  assert.equal(n.c, 4);
  db.close();
});
