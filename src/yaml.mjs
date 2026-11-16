// src/yaml.mjs —— 极简 YAML 子集解析器（零依赖约束下的自写件）
//
// 只支持本仓 members/*.yaml 用到的形状（P0 蓝图 §3）：
//   - 嵌套 map（缩进 2 空格，任意深度）
//   - list of map（"- key: value" 起头，续行对齐首键列 = 短横列 + 2）
//   - list of scalar（"- threads:own:*"：冒号后无空格视为标量）
//   - 行注释（# 整行注释 / 行尾 # 前必有空白；引号内的 # 不算）
//   - 内联空数组 []、空对象 {}
//   - 裸标量：整数/浮点转 number，true/false/null 转字面量，其余一律 string
// 不支持（超出子集即报错，不静默）：tab 缩进、锚点、多文档、流式集合（除 [] {}）、
// 块标量 |>、含 " # " 的裸标量（需引号包裹）。
//
// 解析失败抛 YamlSyntaxError（带行号）；调用方（loader）转黄灯错误对象，整套载入继续。

export class YamlSyntaxError extends Error {
  constructor(message, line) {
    super(`YAML 语法错误（第 ${line} 行）：${message}`);
    this.name = 'YamlSyntaxError';
    this.line = line;
  }
}

function stripComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function tokenize(source) {
  const lines = [];
  const raws = source.split(/\r?\n/);
  for (let n = 0; n < raws.length; n++) {
    const raw = raws[n];
    if (raw.includes('\t')) throw new YamlSyntaxError('不允许 tab（本子集只用空格缩进）', n + 1);
    const stripped = stripComment(raw).trimEnd();
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    const text = stripped.trimStart();
    lines.push({ indent, text, line: n + 1, dash: text === '-' || text.startsWith('- ') });
  }
  return lines;
}

function parseScalar(text, line) {
  const t = text.trim();
  if (t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1);
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1);
  if (t.startsWith('[') || t.startsWith('{') || t.startsWith('- ')) {
    throw new YamlSyntaxError(`不支持的值形状（本子集只允许 [] {} 内联空集合）：${t}`, line);
  }
  if (t.includes(': ') || t.endsWith(':')) {
    throw new YamlSyntaxError(`疑似键值对出现在标量位置：${t}`, line);
  }
  return t;
}

function splitKey(text) {
  // 在 text 里找第一个「冒号后跟空格或行尾」的冒号，切出 [key, rest]；不是键值形状返回 null
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) i++;
      continue;
    }
    if (c === ':') {
      if (i + 1 === text.length) return [unquote(text.slice(0, i)), ''];
      if (text[i + 1] === ' ') return [unquote(text.slice(0, i)), text.slice(i + 1).trim()];
    }
  }
  return null;
}

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

function parseBlock(lines, idx, indent) {
  if (lines[idx].dash) return parseList(lines, idx, indent);
  return parseMap(lines, idx, indent);
}

function parseMap(lines, idx, indent) {
  const map = {};
  while (idx < lines.length) {
    const ln = lines[idx];
    if (ln.indent < indent) break; // 块结束，交还外层
    if (ln.indent > indent) throw new YamlSyntaxError(`缩进异常（期望 ${indent} 列，实际 ${ln.indent} 列）`, ln.line);
    if (ln.dash) throw new YamlSyntaxError('此处不应出现列表项 "-"', ln.line);
    const kv = splitKey(ln.text);
    if (!kv) throw new YamlSyntaxError(`无法解析的行（不是 key: value 形状）：${ln.text}`, ln.line);
    const [key, rest] = kv;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
      throw new YamlSyntaxError(`键名形状非法（本子集只允许字母开头的标识符）：${key}`, ln.line);
    }
    if (key === '') throw new YamlSyntaxError('键名为空', ln.line);
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new YamlSyntaxError(`重复键：${key}`, ln.line);
    }
    if (rest !== '') {
      map[key] = rest === '[]' ? [] : rest === '{}' ? {} : parseScalar(rest, ln.line);
      idx++;
    } else {
      const nxt = lines[idx + 1];
      if (nxt && nxt.indent > indent) {
        [map[key], idx] = parseBlock(lines, idx + 1, nxt.indent);
      } else {
        map[key] = null; // 空枝（人机同构：枝空=事实稀疏）
        idx++;
      }
    }
  }
  return [map, idx];
}

function parseList(lines, idx, indent) {
  const arr = [];
  while (idx < lines.length) {
    const ln = lines[idx];
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlSyntaxError(`缩进异常（期望 ${indent} 列，实际 ${ln.indent} 列）`, ln.line);
    if (!ln.dash) break; // 同级回到 map 键，交还外层
    const after = ln.text === '-' ? '' : ln.text.slice(2);
    if (after.trim() === '') {
      // 纯 "-"：项为嵌套块或 null
      const nxt = lines[idx + 1];
      if (!nxt || nxt.indent <= indent) {
        arr.push(null);
        idx++;
      } else {
        const [v, ni] = parseBlock(lines, idx + 1, nxt.indent);
        arr.push(v);
        idx = ni;
      }
      continue;
    }
    const kv = splitKey(after);
    if (kv) {
      // map 项：首键在短横列 + 2；把首键值拼成伪行，续行须对齐同列
      const itemIndent = indent + 2;
      const virtual = [
        { indent: itemIndent, text: after, line: ln.line, dash: false },
        ...lines.slice(idx + 1),
      ];
      const [item, consumed] = parseMap(virtual, 0, itemIndent);
      arr.push(item);
      idx += consumed;
    } else {
      arr.push(parseScalar(after, ln.line));
      idx++;
    }
  }
  return [arr, idx];
}

export function parseYaml(source) {
  const lines = tokenize(source);
  if (lines.length === 0) throw new YamlSyntaxError('空文件（manifest 不能为空）', 1);
  if (lines[0].indent !== 0) throw new YamlSyntaxError('文档必须从第 0 列开始', lines[0].line);
  const [doc, idx] = parseMap(lines, 0, 0);
  if (idx !== lines.length) {
    throw new YamlSyntaxError('文档根部有多余内容', lines[idx]?.line ?? 1);
  }
  return doc;
}
