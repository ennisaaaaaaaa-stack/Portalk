// src/jsonschema.mjs —— 自写 JSON Schema 校验器（零依赖）
//
// 只实现本仓 members/schema.json 用到的关键字（任务单圈定）：
//   required / type / enum / pattern / uniqueItems / items / properties / minItems
// 其余关键字（$ref、additionalProperties、const 等）不实现也不静默吞：
//   出现在 schema 里会被视为无约束（schema 本体已保证不使用）。
// 错误返回 { ok, errors: [{ path, message }] }，不抛异常。

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? String(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

function deepEqualByCanonical(a, b) {
  return canonical(a) === canonical(b);
}

function walk(schema, data, path, errors) {
  if (typeof schema !== 'object' || schema === null) return; // 无约束

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const pass = types.some((t) => (TYPE_CHECKS[t] ?? (() => false))(data));
    if (!pass) {
      errors.push({ path, message: `类型应为 ${types.join('|')}，实际是 ${typeName(data)}` });
      return; // 类型已错，后续约束无意义
    }
  }

  if (schema.enum !== undefined) {
    const hit = schema.enum.some((v) => deepEqualByCanonical(v, data));
    if (!hit) {
      errors.push({ path, message: `值必须是 ${JSON.stringify(schema.enum)} 之一，实际是 ${JSON.stringify(data)}` });
    }
  }

  if (schema.pattern !== undefined && typeof data === 'string') {
    if (!new RegExp(schema.pattern).test(data)) {
      errors.push({ path, message: `不匹配模式 /${schema.pattern}/：${JSON.stringify(data)}` });
    }
  }

  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push({ path, message: `至少需要 ${schema.minItems} 项，实际 ${data.length} 项` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of data) {
        const key = canonical(item);
        if (seen.has(key)) {
          errors.push({ path, message: `数组项重复：${JSON.stringify(item)}` });
          break;
        }
        seen.add(key);
      }
    }
    if (schema.items !== undefined) {
      data.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, errors));
    }
  }

  if (TYPE_CHECKS.object(data)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in data)) errors.push({ path, message: `缺少必填字段：${key}` });
      }
    }
    if (schema.properties !== undefined) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in data) walk(sub, data[key], `${path}.${key}`, errors);
      }
    }
  }
}

export function validateSchema(schema, data, path = '$') {
  const errors = [];
  walk(schema, data, path, errors);
  return { ok: errors.length === 0, errors };
}
