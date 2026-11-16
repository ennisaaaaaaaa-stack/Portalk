#!/usr/bin/env node
// test/gen-fixtures.mjs —— 夹具生成脚本 CLI
// 用法：node test/gen-fixtures.mjs [目录]
// 可重置：删 testdata/ 目录后重跑本脚本（或任一测试）即重建。

import { buildFixtures } from './fixtures.mjs';

const dir = process.argv[2] ?? undefined;
const built = buildFixtures(dir);
console.log(`fixtures 已重建：${built}`);
