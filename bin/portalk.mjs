#!/usr/bin/env node
// bin/portalk.mjs —— 最小 CLI 入口（本单只做：建库 + 成员位载入亮黄灯；conductor 归后续轨道）
// 用法：portalk [--db PATH] [--members DIR]

import { openDb, resolveDbPath } from '../src/db.mjs';
import { loadMembers, formatErrors, DEFAULT_MEMBERS_DIR } from '../src/loader.mjs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
};

const membersDir = flagValue('--members') ?? DEFAULT_MEMBERS_DIR;
const dbPath = resolveDbPath();

const db = openDb(dbPath);
console.log(`portalk db ready: ${dbPath}`);
db.close();

const result = loadMembers(membersDir);
if (result.ok) {
  console.log(`members ok（${Object.keys(result.tree).length} 位入树）: ${Object.keys(result.tree).join(', ')}`);
} else {
  console.error(formatErrors(result)); // 亮黄灯：坏件拒载要出声
  const kept = Object.keys(result.tree);
  console.error(`已拒载 ${result.errors.length} 件；好件照载 ${kept.length} 位：${kept.join(', ') || '（无）'}`);
  process.exitCode = 1;
}
