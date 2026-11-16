// test/jsonschema.test.mjs —— 自写校验器（只实现用到的关键字：required/type/enum/pattern/uniqueItems/items/properties/minItems）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateSchema } from '../src/jsonschema.mjs';
import { REPO_ROOT } from './fixtures.mjs';

test('required：缺字段报路径', () => {
  const r = validateSchema({ type: 'object', required: ['a', 'b'] }, { a: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].message, '缺少必填字段：b');
});

test('type：整数/字符串/数组/对象，数组型 type 任一命中即可', () => {
  assert.equal(validateSchema({ type: 'integer' }, 1).ok, true);
  assert.equal(validateSchema({ type: 'integer' }, 1.5).ok, false);
  assert.equal(validateSchema({ type: ['string', 'null'] }, null).ok, true);
  assert.equal(validateSchema({ type: 'array' }, []).ok, true);
  assert.equal(validateSchema({ type: 'object' }, []).ok, false);
  assert.equal(validateSchema({ type: 'string' }, 1).ok, false);
});

test('enum：枚举外拒收（含类型不符）', () => {
  const s = { enum: ['agent', 'human'] };
  assert.equal(validateSchema(s, 'agent').ok, true);
  assert.equal(validateSchema(s, 'robot').ok, false);
  assert.equal(validateSchema(s, 3).ok, false);
});

test('pattern：只作用于字符串，非字符串跳过', () => {
  const s = { type: 'string', pattern: '^[a-z]+$' };
  assert.equal(validateSchema(s, 'abc').ok, true);
  assert.equal(validateSchema(s, 'Abc').ok, false);
  assert.equal(validateSchema({ pattern: '^[a-z]+$' }, 123).ok, true); // 非串不判
});

test('items + properties：逐项逐属性下钻，错误带路径', () => {
  const s = {
    type: 'array',
    items: { type: 'object', required: ['mount'], properties: { mount: { type: 'string', pattern: '^\\S+$' } } },
  };
  const r = validateSchema(s, [{ mount: 'ok@x' }, { mount: 'bad id' }]);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].path, '$[1].mount');
});

test('minItems / uniqueItems', () => {
  assert.equal(validateSchema({ type: 'array', minItems: 1 }, []).ok, false);
  assert.equal(validateSchema({ type: 'array', minItems: 0 }, []).ok, true);
  assert.equal(validateSchema({ type: 'array', uniqueItems: true }, ['a', 'b', 'a']).ok, false);
  assert.equal(validateSchema({ type: 'array', uniqueItems: true }, ['a', 'b']).ok, true);
});

test('schema.json 本体可加载且只声明受支持关键字', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'members', 'schema.json'), 'utf8'));
  const supported = new Set(['type', 'enum', 'pattern', 'required', 'properties', 'items', 'minItems', 'uniqueItems', 'description', 'title', '$schema', '$id']);
  const offenders = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'properties') {
        Object.values(v).forEach(walk); // properties 的键是属性名不是关键字，只下钻值
        continue;
      }
      if (['enum', 'required', 'pattern', 'type', 'minItems', 'uniqueItems'].includes(k)) continue; // 数据位，不下钻
      if (!supported.has(k)) offenders.push(k);
      walk(v);
    }
  };
  walk(schema, '$');
  assert.deepEqual(offenders, [], 'schema.json 出现了校验器不支持的关键字（会被静默视为无约束）');
});
