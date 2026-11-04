#!/usr/bin/env node
/**
 * C01 提交门禁：对外契约与生成产物中不得出现供数厂商标识。
 *
 * 规则（ADR-002 D2a / ADR-004）：
 *  - 扫描面：contracts/**\/*.yaml（含 description/examples）与 packages/api-client/src/generated/**\/*.ts。
 *  - 只扫对外可见面：ADR、内部文档、实现代码、测试夹具不在此脚本范围（它们可以讨论供数方）。
 *  - 不匹配「五个字母」这种绕过式规则：按厂商标识词表整词匹配，命中即红灯。
 *  - SourceRef.source 必须是显式有限枚举（平台词表），不允许回退为自由字符串 + 示例。
 *
 * 用法：node infra/ci/check-source-vocabulary.mjs [--self-test]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_DIR = join(ROOT, 'contracts');
const GENERATED_DIR = join(ROOT, 'packages/api-client/src/generated');

/**
 * 供数厂商标识（整词、大小写不敏感）。增删须 A0 提案 + H2 签字（ADR-002 D2a / ADR-004）。
 * 分两类，避免误伤英文常用词：
 *  - HARD：唯一指向供数方的标识，命中即红灯。
 *  - CONTEXTUAL：wind / choice 也是普通英文词，仅当同一行出现数据/来源上下文才视为厂商标识；
 *    这是「范围划清楚优先于匹配写严密」的取舍（Lead m00556）。
 */
const HARD_VENDOR_IDENTIFIERS = ['tushare', 'ifind', 'akshare', 'eastmoney'];
const CONTEXTUAL_VENDOR_IDENTIFIERS = ['wind', 'choice'];
const VENDOR_IDENTIFIERS = [...HARD_VENDOR_IDENTIFIERS, ...CONTEXTUAL_VENDOR_IDENTIFIERS];

const CONTEXT_RE = /\b(data|source|provider|terminal|api|feed|quote|market|vendor)\b/i;

const PATTERNS = HARD_VENDOR_IDENTIFIERS.map((name) => ({
  name,
  re: new RegExp(`\\b${name}\\b`, 'i'),
}));
const CONTEXTUAL_PATTERNS = CONTEXTUAL_VENDOR_IDENTIFIERS.map((name) => ({
  name,
  re: new RegExp(`\\b${name}\\b`, 'i'),
}));

function walk(dir, ext) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // 目录尚未生成（如 generated/ 重建中）不视为红灯，等生成后再扫
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(abs, ext));
    else if (abs.endsWith(ext)) out.push(abs);
  }
  return out;
}

function scanFile(file) {
  const findings = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    for (const { name, re } of PATTERNS) {
      if (re.test(line))
        findings.push({
          file: relative(ROOT, file),
          line: idx + 1,
          token: name,
          text: line.trim(),
        });
    }
    // wind/choice 需同行出现数据/来源上下文，避免英文 description 误伤
    if (CONTEXT_RE.test(line)) {
      for (const { name, re } of CONTEXTUAL_PATTERNS) {
        if (re.test(line))
          findings.push({
            file: relative(ROOT, file),
            line: idx + 1,
            token: name,
            text: line.trim(),
          });
      }
    }
  });
  return findings;
}

/** SourceRef.source 必须存在有限 enum，防止有人把它改回自由字符串。 */
function checkSourceEnum(findings) {
  const shared = join(CONTRACT_DIR, 'shared/openapi.yaml');
  const text = readFileSync(shared, 'utf8');
  const m = text.match(/SourceRef:[\s\S]*?source:\s*([\s\S]*?)\n\s{8}as_of:/);
  if (!m) {
    findings.push({
      file: 'contracts/shared/openapi.yaml',
      line: 0,
      token: 'SourceRef.source',
      text: '未找到 SourceRef.source 定义',
    });
    return;
  }
  const body = m[1];
  if (!/enum:/.test(body))
    findings.push({
      file: 'contracts/shared/openapi.yaml',
      line: 0,
      token: 'SourceRef.source',
      text: 'SourceRef.source 不是显式 enum（禁止自由字符串）',
    });
  const members = [...body.matchAll(/^\s{12}- ([a-z0-9_]+)$/gm)].map((x) => x[1]);
  if (members.length < 4)
    findings.push({
      file: 'contracts/shared/openapi.yaml',
      line: 0,
      token: 'SourceRef.source',
      text: `enum 成员过少或解析失败：${JSON.stringify(members)}`,
    });
  const nonPlatform = members.filter((x) => !x.startsWith('platform_'));
  if (nonPlatform.length > 0)
    findings.push({
      file: 'contracts/shared/openapi.yaml',
      line: 0,
      token: 'SourceRef.source',
      text: `enum 成员不是平台词表：${nonPlatform.join(', ')}`,
    });
  const vendorInEnum = members.filter((x) =>
    VENDOR_IDENTIFIERS.some((v) => x.toLowerCase().includes(v)),
  );
  if (vendorInEnum.length > 0)
    findings.push({
      file: 'contracts/shared/openapi.yaml',
      line: 0,
      token: 'SourceRef.source',
      text: `enum 含厂商标识：${vendorInEnum.join(', ')}`,
    });
}

function collectFindings() {
  const contractFiles = walk(CONTRACT_DIR, '.yaml');
  const generatedFiles = walk(GENERATED_DIR, '.ts');
  const files = [...contractFiles, ...generatedFiles];
  const findings = files.flatMap(scanFile);
  // 「没有输入」不能等于「通过」：契约目录缺失/为空时门禁必须红灯（A13 review 建议）。
  if (contractFiles.length === 0) {
    findings.push({
      file: 'contracts',
      line: 0,
      token: 'scan-input',
      text: '未扫描到任何 contract yaml（目录缺失或为空）——门禁不得静默通过',
    });
  }
  if (generatedFiles.length === 0) {
    findings.push({
      file: 'packages/api-client/src/generated',
      line: 0,
      token: 'scan-input',
      text: '未扫描到任何 generated ts（目录缺失或为空）——门禁不得静默通过',
    });
  }
  checkSourceEnum(findings);
  return { findings, files };
}

/**
 * 变异测试：不是「跑一遍断言它绿」，而是「种一个违规再断言它红」。
 * 每个用例临时改真实文件 → 断言非零且定位到期望文件 → finally 还原并复核。
 */
function runSelfTest() {
  const shared = join(CONTRACT_DIR, 'shared/openapi.yaml');
  const gen = join(GENERATED_DIR, 'shared.ts');
  const originals = new Map([
    [shared, readFileSync(shared, 'utf8')],
    [gen, readFileSync(gen, 'utf8')],
  ]);
  const restore = () => {
    for (const [file, content] of originals) writeFileSync(file, content);
  };
  const failures = [];
  const fail = (message) => failures.push(message);
  const restoreAndVerifyClean = () => {
    restore();
    const { findings } = collectFindings();
    if (findings.length > 0) {
      fail(`还原后仍有 ${findings.length} 处红灯（工作区被污染）`);
      return false;
    }
    return true;
  };
  const expectRed = (label, expectedFile, expectedToken, assertions) => {
    const { findings } = collectFindings();
    const rel = relative(ROOT, expectedFile);
    const hit = findings.find((f) => f.file === rel);
    if (findings.length === 0) {
      fail(`${label}: 变异后仍为绿——闸没有响`);
      return;
    }
    if (!hit) {
      fail(`${label}: 有 ${findings.length} 处红灯但未定位到 ${rel}`);
      return;
    }
    if (assertions && !assertions(findings)) {
      fail(`${label}: 红灯定位到 ${rel}，但断言不满足（token=${expectedToken}）`);
      return;
    }
    console.log(
      `self-test: PASS  ${label} → 退出码非零，定位 ${hit.file}:${hit.line} [${hit.token}]`,
    );
  };

  try {
    // 用例 1：契约描述里插入厂商名（实际漏过的位置）
    writeFileSync(
      shared,
      originals
        .get(shared)
        .replace(
          '            词表只描述平台对数据的承诺',
          '            vendor_probe 使用 tushare 数据。\n            词表只描述平台对数据的承诺',
        ),
    );
    expectRed('契约描述插入厂商名', shared, 'tushare', (fs) =>
      fs.some((f) => f.token === 'tushare' && f.line > 0),
    );
    if (!restoreAndVerifyClean()) return 1;

    // 用例 2：SourceRef.source 插入非 platform_* 枚举值
    writeFileSync(
      shared,
      originals
        .get(shared)
        .replace(
          '            - platform_fundamental',
          '            - platform_fundamental\n            - vendor_probe',
        ),
    );
    const enumFindings = collectFindings().findings;
    if (enumFindings.length === 0) {
      fail('enum 插入非平台值: 变异后仍为绿——闸没有响');
    } else if (
      !enumFindings.some((f) => f.token === 'SourceRef.source' && f.text.includes('vendor_probe'))
    ) {
      fail('enum 插入非平台值: 有红灯但未按 SourceRef.source 报出 vendor_probe');
    } else {
      console.log('self-test: PASS  enum 插入非平台值 → 退出码非零，定位 SourceRef.source');
    }
    if (!restoreAndVerifyClean()) return 1;

    // 用例 3：生成产物里插入 @example 厂商名（实际漏过的位置）
    writeFileSync(gen, `${originals.get(gen)}\n// @example tushare\n`);
    expectRed('生成产物插入 @example 厂商名', gen, 'tushare', (fs) =>
      fs.some((f) => f.token === 'tushare' && f.line > 0),
    );
    if (!restoreAndVerifyClean()) return 1;

    // 用例 4：wind 在数据上下文中出现 → 必须红灯（防止 CONTEXT_RE 被改坏后静默放宽）
    writeFileSync(
      shared,
      originals
        .get(shared)
        .replace(
          '            词表只描述平台对数据的承诺',
          '            equity data from Wind terminal.\n            词表只描述平台对数据的承诺',
        ),
    );
    expectRed('wind 出现在数据上下文', shared, 'wind', (fs) =>
      fs.some((f) => f.token === 'wind' && f.line > 0),
    );
    if (!restoreAndVerifyClean()) return 1;

    // 用例 5：wind 作为普通英文词出现 → 不得红灯
    writeFileSync(
      shared,
      originals
        .get(shared)
        .replace(
          '            词表只描述平台对数据的承诺',
          '            a gust of wind.\n            词表只描述平台对数据的承诺',
        ),
    );
    const gustFindings = collectFindings().findings.filter((f) => f.token === 'wind');
    if (gustFindings.length > 0) {
      fail(`普通英文 wind 误报：${gustFindings[0].file}:${gustFindings[0].line}`);
    } else {
      console.log('self-test: PASS  普通英文 wind 不触发（CONTEXT_RE 生效）');
    }
    if (!restoreAndVerifyClean()) return 1;
  } finally {
    restore();
    for (const [file, content] of originals) {
      if (readFileSync(file, 'utf8') !== content)
        fail(`${relative(ROOT, file)} 还原失败（字节不一致）`);
    }
  }

  if (failures.length > 0) {
    console.error(`self-test: FAIL（${failures.length} 项）`);
    for (const message of failures) console.error(`  - ${message}`);
    return 1;
  }
  console.log(
    'self-test: PASS（5 个变异：3 红 + 1 上下文红 + 1 正常词不红；还原后工作区干净、0 命中）',
  );
  return 0;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) process.exit(runSelfTest());

const { findings, files } = collectFindings();

if (findings.length === 0) {
  console.log(
    `check-source-vocabulary: PASS（扫描 ${files.length} 个文件，无厂商标识；SourceRef.source 为平台词表 enum）`,
  );
  process.exit(0);
}
console.error(`check-source-vocabulary: FAIL（${findings.length} 处）`);
for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.token}]  ${f.text}`);
process.exit(1);
