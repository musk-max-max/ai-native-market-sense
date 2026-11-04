/**
 * market-sense-h5 · 零依赖 YAML 子集解析器（CI 工具专用）
 *
 * 为什么不用 npm 的 yaml 包：
 *   1. path guard 必须在 `pnpm install` 之前就能跑（否则依赖安装失败会让写域门禁失效）；
 *   2. 工具脚本要能被独立复制/审计，不应引入供应链面。
 *
 * 支持（覆盖 ownership.yaml / monitoring / slo 的实际用法）：
 *   - 块映射、块序列、嵌套（空格缩进，禁止 tab）
 *   - 行内 flow 数组/映射：`[A, B]`、`{ path: x, owner: A4 }`
 *   - 单/双引号字符串、数字、布尔、null/~
 *   - 行尾注释与整行注释（`#` 前必须是行首或空白）
 *   - 文档分隔符 `---` / `...`
 *
 * 不支持（遇到会显式报错，绝不静默猜）：
 *   - tab 缩进、锚点/别名（& *）、标签（!）、多行块标量（| >）、多文档
 *   - 复杂键（? 显式键）、时间戳类型推断（一律按字符串保存）
 */

export class YamlParseError extends Error {
  constructor(message, line) {
    super(line ? `${message}（第 ${line} 行）` : message);
    this.name = 'YamlParseError';
    this.line = line;
  }
}

const BLOCK_SCALAR = /^[|>][+-]?$/;
const NUMERIC = /^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

function stripComment(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth < 0) throw new YamlParseError('flow 括号不匹配', undefined);
    } else if (ch === '#' && depth === 0 && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  if (quote) throw new YamlParseError('字符串引号未闭合');
  return text;
}

function preprocess(text) {
  const lines = [];
  const rawLines = String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  rawLines.forEach((raw, index) => {
    const lineNo = index + 1;
    const leading = raw.match(/^[ \t]*/)[0];
    if (leading.includes('\t')) {
      throw new YamlParseError('缩进中出现 tab；YAML 只允许空格缩进', lineNo);
    }
    let rest = raw.slice(leading.length);
    if (rest.trim() === '') return;
    if (rest.trimStart().startsWith('#')) return;
    if (/^(---|\.\.\.)\s*$/.test(rest.trim())) return;
    rest = stripComment(rest).replace(/\s+$/, '');
    if (rest.trim() === '') return;
    lines.push({ indent: leading.length, text: rest, line: lineNo });
  });
  return lines;
}

function isSeqItem(text) {
  return text === '-' || /^-\s/.test(text);
}

function findTopLevelColon(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ':' && depth === 0) {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

function unquoteKey(key, lineNo) {
  const trimmed = key.trim();
  if (trimmed === '') throw new YamlParseError('空 key', lineNo);
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const [value, next] = parseQuoted(trimmed, 0, lineNo);
    if (trimmed.slice(next).trim() !== '') throw new YamlParseError('key 后存在多余字符', lineNo);
    return value;
  }
  return trimmed;
}

function splitKeyValue(text, lineNo) {
  const idx = findTopLevelColon(text);
  if (idx < 0) return null;
  const key = unquoteKey(text.slice(0, idx), lineNo);
  const rest = text
    .slice(idx + 1)
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
  return { key, rest };
}

function parseQuoted(text, start, lineNo) {
  const quote = text[start];
  let i = start + 1;
  let out = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return [out, i + 1];
    }
    if (quote === '"' && ch === '\\') {
      const esc = text[i + 1];
      const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', 0: '\0' };
      if (esc === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new YamlParseError('非法 \\u 转义', lineNo);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      if (!(esc in map)) throw new YamlParseError(`不支持的转义 \\${esc}`, lineNo);
      out += map[esc];
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  throw new YamlParseError('字符串未闭合', lineNo);
}

function skipSpaces(text, i) {
  let idx = i;
  while (idx < text.length && /\s/.test(text[idx])) idx += 1;
  return idx;
}

function parseFlowValue(text, start, lineNo) {
  let i = skipSpaces(text, start);
  if (i >= text.length) throw new YamlParseError('flow 值缺失', lineNo);
  const ch = text[i];
  if (ch === '[') return parseFlowArray(text, i, lineNo);
  if (ch === '{') return parseFlowMap(text, i, lineNo);
  if (ch === '"' || ch === "'") {
    const [value, next] = parseQuoted(text, i, lineNo);
    return [value, next];
  }
  const begin = i;
  while (i < text.length && !/[,}\]\n]/.test(text[i])) i += 1;
  const plain = text.slice(begin, i).trim();
  return [plainScalar(plain, lineNo), i];
}

function parseFlowArray(text, start, lineNo) {
  let i = start + 1;
  const out = [];
  i = skipSpaces(text, i);
  if (text[i] === ']') return [out, i + 1];
  for (;;) {
    const [value, next] = parseFlowValue(text, i, lineNo);
    out.push(value);
    i = skipSpaces(text, next);
    if (text[i] === ']') return [out, i + 1];
    if (text[i] !== ',') throw new YamlParseError('flow 数组缺少逗号', lineNo);
    i = skipSpaces(text, i + 1);
  }
}

function parseFlowKey(text, start, lineNo) {
  let i = skipSpaces(text, start);
  if (text[i] === '"' || text[i] === "'") {
    const [key, next] = parseQuoted(text, i, lineNo);
    return [key, next];
  }
  const begin = i;
  while (i < text.length && text[i] !== ':' && text[i] !== ',' && text[i] !== '}') i += 1;
  if (text[i] !== ':') throw new YamlParseError('flow 映射缺少 ":"', lineNo);
  return [text.slice(begin, i).trim(), i];
}

function parseFlowMap(text, start, lineNo) {
  let i = start + 1;
  const out = {};
  i = skipSpaces(text, i);
  if (text[i] === '}') return [out, i + 1];
  for (;;) {
    const [key, keyEnd] = parseFlowKey(text, i, lineNo);
    i = skipSpaces(text, keyEnd + 1);
    const [value, next] = parseFlowValue(text, i, lineNo);
    out[key] = value;
    i = skipSpaces(text, next);
    if (text[i] === '}') return [out, i + 1];
    if (text[i] !== ',') throw new YamlParseError('flow 映射缺少逗号', lineNo);
    i = skipSpaces(text, i + 1);
  }
}

function plainScalar(plain, lineNo) {
  if (plain === '') return null;
  if (/^(null|Null|NULL|~)$/.test(plain)) return null;
  if (/^(true|True|TRUE)$/.test(plain)) return true;
  if (/^(false|False|FALSE)$/.test(plain)) return false;
  if (NUMERIC.test(plain)) return Number(plain);
  if (/^[&*!]/.test(plain)) throw new YamlParseError('不支持锚点/别名/标签', lineNo);
  return plain;
}

function parseScalar(raw, lineNo) {
  const text = raw.trim();
  if (text === '') return null;
  if (BLOCK_SCALAR.test(text)) {
    throw new YamlParseError('不支持多行块标量（| / >）；请改用单行字符串', lineNo);
  }
  if (text.startsWith('[') || text.startsWith('{')) {
    const [value, next] = parseFlowValue(text, 0, lineNo);
    if (text.slice(next).trim() !== '') throw new YamlParseError('flow 值后存在多余字符', lineNo);
    return value;
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    const [value, next] = parseQuoted(text, 0, lineNo);
    if (text.slice(next).trim() !== '') throw new YamlParseError('字符串后存在多余字符', lineNo);
    return value;
  }
  return plainScalar(text, lineNo);
}

function parseSequence(lines, start, indent) {
  const out = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && isSeqItem(lines[i].text)) {
    const line = lines[i];
    const afterDash = line.text.replace(/^-/, '');
    const content = afterDash.replace(/^\s+/, '');
    if (content === '') {
      const next = lines[i + 1];
      if (next && next.indent > indent) {
        const [value, nextIndex] = parseNode(lines, i + 1, next.indent);
        out.push(value);
        i = nextIndex;
      } else {
        out.push(null);
        i += 1;
      }
    } else {
      const virtualIndent = line.indent + (line.text.length - content.length);
      if (splitKeyValue(content, line.line)) {
        const [value, nextIndex] = parseMapping(lines, i + 1, virtualIndent, {
          indent: virtualIndent,
          text: content,
          line: line.line,
        });
        out.push(value);
        i = nextIndex;
      } else {
        out.push(parseScalar(content, line.line));
        i += 1;
      }
    }
  }
  return [out, i];
}

function parseMapping(lines, start, indent, firstLine) {
  const out = {};
  let i = start;
  let pending = firstLine ?? null;
  for (;;) {
    let line;
    if (pending) {
      line = pending;
      pending = null;
    } else {
      if (i >= lines.length) break;
      if (lines[i].indent < indent) break;
      if (lines[i].indent > indent) {
        throw new YamlParseError('缩进不一致', lines[i].line);
      }
      line = lines[i];
      i += 1;
    }
    if (isSeqItem(line.text)) throw new YamlParseError('映射位置出现序列项', line.line);
    const pair = splitKeyValue(line.text, line.line);
    if (!pair) throw new YamlParseError('无法解析的映射行（缺少 ":"）', line.line);
    if (Object.hasOwn(out, pair.key)) {
      throw new YamlParseError(`重复 key: ${pair.key}`, line.line);
    }
    if (pair.rest === '') {
      const next = lines[i];
      if (next && next.indent > indent) {
        const [value, nextIndex] = parseNode(lines, i, next.indent);
        out[pair.key] = value;
        i = nextIndex;
      } else {
        out[pair.key] = null;
      }
    } else {
      out[pair.key] = parseScalar(pair.rest, line.line);
    }
  }
  return [out, i];
}

function parseNode(lines, start, indent) {
  if (start >= lines.length) return [null, start];
  const line = lines[start];
  if (line.indent !== indent) throw new YamlParseError('缩进与上下文不一致', line.line);
  if (isSeqItem(line.text)) return parseSequence(lines, start, indent);
  return parseMapping(lines, start, indent);
}

/**
 * @param {string} text YAML 文本
 * @returns {unknown} 解析结果
 */
export function parseYaml(text) {
  const lines = preprocess(text);
  if (lines.length === 0) return null;
  const [value, next] = parseNode(lines, 0, lines[0].indent);
  if (next !== lines.length) {
    throw new YamlParseError('解析结束后存在未被消费的行（缩进错误？）', lines[next].line);
  }
  return value;
}
