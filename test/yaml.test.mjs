// test/yaml.test.mjs —— 极简 YAML 子集解析器
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../src/yaml.mjs';
import { REPO_ROOT } from './fixtures.mjs';

test('出厂 pianist.yaml 全形状解析（嵌套 map / list of map / list of scalar / 行注释 / []）', () => {
  const doc = parseYaml(fs.readFileSync(path.join(REPO_ROOT, 'members', 'pianist.yaml'), 'utf8'));
  assert.equal(doc.manifest_version, 1); // 整数转 number
  assert.equal(doc.slug, 'pianist');
  assert.equal(doc.kind, 'agent');
  assert.equal(doc.agent_id, 'a:b7c2e9f4a1d83c60');
  assert.equal(doc.display_name, 'Emergence Pianist'); // 注释不混入值
  assert.equal(doc.identity.memory.ref, 'tideline:///root/portalk/data/tideline/mcp_memory.db');
  assert.equal(doc.identity.memory.liveness, 'file');
  assert.equal(doc.shells.length, 1);
  assert.equal(doc.shells[0].mount, 'pianist@local-default');
  assert.equal(doc.shells[0].provider, 'pianist');
  assert.equal(doc.shells[0].provider_ref, 'local-default');
  assert.equal(doc.shells[0].claim_bound_at, '2026-11-16'); // 日期保持 string
  assert.equal(doc.shells[0].claim_bound_by, 'p:tianxin');
  assert.equal(doc.shells[0].address, 'systemd:portalk-conductor'); // 冒号未跟空格=标量
  assert.deepEqual(doc.perms.project, []); // 内联空数组
  assert.deepEqual(doc.perms.interact, []);
  assert.deepEqual(doc.perms.dialog, ['threads:own:*']); // 标量列表项（冒号未跟空格）
  assert.equal(doc.senses[0].name, 'moonshine');
  assert.equal(doc.senses[0].ref, 'moonshake:///root/portalk/senses/moonshine/');
  assert.deepEqual(doc.vault.diary, []);
  assert.deepEqual(doc.vault.opus, []);
});

test('标量类型：整数/浮点/布尔/null/引号串', () => {
  const doc = parseYaml('a: 42\nb: -3\nc: 1.5\nd: true\ne: false\nf: null\ng: "has # hash"\n');
  assert.equal(doc.a, 42);
  assert.equal(doc.b, -3);
  assert.equal(doc.c, 1.5);
  assert.equal(doc.d, true);
  assert.equal(doc.e, false);
  assert.equal(doc.f, null);
  assert.equal(doc.g, 'has # hash'); // 引号内的 # 不当注释
});

test('嵌套块与同级键混合', () => {
  const doc = parseYaml('top: 1\nouter:\n  inner:\n    deep: yes-please\n  sibling: 2\nafter: 3\n');
  assert.deepEqual(doc.outer, { inner: { deep: 'yes-please' }, sibling: 2 });
  assert.equal(doc.after, 3);
});

test('空枝= null（枝空是事实稀疏，不是错误）', () => {
  const doc = parseYaml('kind: human\nidentity:\nperms:\n  project: []\n');
  assert.equal(doc.identity, null);
});

test('tab 缩进拒收（带行号）', () => {
  assert.throws(() => parseYaml('a: 1\n\tb: 2\n'), /第 2 行.*tab/);
});

test('重复键拒收', () => {
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /重复键：a/);
});

test('缩进异常拒收', () => {
  assert.throws(() => parseYaml('a: 1\n    b: 2\n'), /缩进异常/);
});

test('垃圾行拒收', () => {
  assert.throws(() => parseYaml('::::\n'), /键名形状非法|键名为空|无法解析/);
});

test('空文件拒收', () => {
  assert.throws(() => parseYaml('# 只有注释\n\n'), /空文件/);
});
