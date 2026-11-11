#!/usr/bin/env node
/* global console, process, URL */
/**
 * 生产构建负向扫描（ADR-006 D4 / H3 m00870）。
 *
 * 客户端可取得即出口：JS bundle、HTML、CSS、sourcemap、DOM 注入路径都算。
 * 扫描 dist/ 后断言不含内部标识、权限分层取值、渠道/来源内部 ID、厂商名、内部错误码。
 *
 * `F1` 按「形态判定」而非「文件归属豁免」（H3 m01038 裁定①）：
 *  - 高置信命中（中文/括号/引号上下文，或与授权/积分/权限共现）→ 直接失败；
 *  - 裸 "F1"（如 react-dom 键盘键名枚举 F1..F12）→ 低置信清单，必须每次发版由人工
 *    在 scripts/f1-low-confidence-ack.json 签字（含当前 COPY_VERSION 与清单 hash），
 *    否则构建失败——不静默放过，也不因 chunk 改名而绕过。
 *
 * 用法：node scripts/check-bundle-compliance.mjs   （在 pnpm build 之后运行）
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { COPY_VERSION } from '../src/lib/copy.ts';

const H5_DIR = fileURLToPath(new URL('..', import.meta.url));
const DIST_DIR = join(H5_DIR, 'dist');
const ACK_FILE = join(H5_DIR, 'scripts', 'f1-low-confidence-ack.json');

/** ADR-006 D4 清单 + Lead/H3 追加项（F1 单独按形态判定，见上）。 */
const FORBIDDEN = [
  /\bENTITLEMENT_RESTRICTED\b/,
  /\binternal_eval\b/,
  /\bc_end_display\b/,
  /\bplatform_user_data\b/,
  /\bresearch_only\b/,
  /\bsource_id\b/,
  /\bchannel\s*[=:]/,
  /\btier\b/,
  /tushare/i,
  /\bts_code\b/,
  /\bpct_chg\b/,
  /\bwind\b/i,
  /\bchoice\b/i,
  /\bifind\b/i,
  /\bakshare\b/i,
  /\beastmoney\b/i,
  /积分套餐/,
];

const SCAN_EXT = /\.(js|mjs|html|css|json|map|txt)$/;

// 高置信只认「人类可读上下文」：全角括号、或中文字符邻接（含授权/积分/权限词）。
// 半角括号 `(F1)` 和引号 `"F1":` 是压缩 JS 合法语法（vendor bundle react-dom 键名枚举、函数参数等），归低置信。
const F1_HIGH_CONFIDENCE =
  /(?:[（【]\s*F1\s*[）】]|[\u4e00-\u9fff][^\n]{0,8}\bF1\b|\bF1\b[^\n]{0,8}[\u4e00-\u9fff]|\bF1\b[^\n]{0,8}(?:授权|积分|权限|牌照)|(?:授权|积分|权限|牌照)[^\n]{0,8}\bF1\b)/;
const F1_ANY = /\bF1\b/g;

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function main() {
  let files;
  try {
    files = walk(DIST_DIR).filter((file) => SCAN_EXT.test(file));
  } catch {
    console.error(`[bundle] dist 不存在：${DIST_DIR}，请先构建。`);
    process.exit(1);
  }

  const hits = [];
  /** 归一化后的出现位置：文件名去掉内容 hash，避免每次构建因 chunk 名变化而重签。 */
  const occurrenceMap = new Map();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const relativeName = file.slice(DIST_DIR.length + 1);
    const stableName = relativeName.replace(/-[A-Za-z0-9_-]{8}(?=\.[a-z0-9]+$)/, '-*');
    for (const pattern of FORBIDDEN) {
      const match = pattern.exec(text);
      if (match) {
        const index = Math.max(0, match.index - 40);
        const context = text.slice(index, match.index + match[0].length + 40).replace(/\s+/g, ' ');
        hits.push(`${relativeName}: ${pattern} → …${context}…`);
      }
    }
    if (F1_HIGH_CONFIDENCE.test(text)) {
      hits.push(`${relativeName}: F1 高置信命中（中文/括号/权限共现）`);
    }
    const tokens = new Map();
    for (const match of text.matchAll(F1_ANY)) {
      tokens.set(match[0], (tokens.get(match[0]) ?? 0) + 1);
    }
    for (const [token, count] of tokens) {
      const key = `${stableName}|${token}`;
      occurrenceMap.set(key, {
        file: stableName,
        token,
        count: (occurrenceMap.get(key)?.count ?? 0) + count,
      });
    }
  }

  if (hits.length > 0) {
    console.error('[bundle] 生产构建含客户端可取得的内部标识：');
    for (const hit of hits) console.error(`  - ${hit}`);
    process.exit(1);
  }

  const occurrences = [...occurrenceMap.values()].sort((a, b) => a.file.localeCompare(b.file));
  const lowTokens = [...new Set(occurrences.map((item) => item.token))].sort();
  const lowHash = createHash('sha256').update(lowTokens.join('\n'), 'utf8').digest('hex');

  /**
   * 低置信豁免必须第二人签（H3 m01320 生效条件）：
   *  - signer 只能是 A0 或 H5（流水线审查者），A7 自签无效；
   *  - 历史条目 append 保留，不覆盖；
   *  - 一次新增豁免 >1 个 token，或 token 不在键盘键名枚举内 → 需 H3 终审。
   */
  const ALLOWED_SIGNERS = new Set(['A0', 'H5']);
  const KEYBOARD_TOKENS = new Set([
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ]);
  let ack = null;
  if (existsSync(ACK_FILE)) {
    try {
      ack = JSON.parse(readFileSync(ACK_FILE, 'utf8'));
    } catch {
      console.error(`[bundle] 无法解析 ${ACK_FILE}`);
      process.exit(1);
    }
  }
  const entries = Array.isArray(ack?.entries) ? ack.entries : [];
  const duplicatedVersions = entries
    .map((entry) => entry.version)
    .filter((version, index, list) => list.indexOf(version) !== index);
  if (duplicatedVersions.length > 0) {
    console.error(`[bundle] ack 版本重复（append-only，请保留历史条目）：${duplicatedVersions.join(', ')}`);
    process.exit(1);
  }
  const current = entries.find((entry) => entry.version === COPY_VERSION);
  const needsH3 = lowTokens.length > 1 || lowTokens.some((token) => !KEYBOARD_TOKENS.has(token));
  const signedBySecondPerson =
    current !== undefined &&
    current.hash === lowHash &&
    ALLOWED_SIGNERS.has(current.signer) &&
    typeof current.signedAt === 'string' &&
    current.signedAt.length > 0 &&
    typeof current.reason === 'string' &&
    current.reason.length > 0 &&
    Array.isArray(current.occurrences) &&
    current.occurrences.length > 0;
  const h3Signed = signedBySecondPerson && current?.signer === 'H3';

  if (occurrences.length > 0 && (!signedBySecondPerson || (needsH3 && !h3Signed))) {
    console.error(`[bundle] F1 低置信命中 ${occurrences.reduce((sum, item) => sum + item.count, 0)} 处，需第二人签字（非豁免）：`);
    if (current !== undefined) {
      console.error(`  当前条目 signer=${JSON.stringify(current.signer)}（A7 自签无效；需 A0 或 H5）`);
    }
    if (needsH3 && !h3Signed) {
      console.error('  本次豁免含多个 token 或非键盘键名枚举，须 H3 终审（signer: "H3"）。');
    }
    console.error(`[bundle] 审核后 append 到 ${ACK_FILE}（历史条目保留，不要覆盖）：`);
    console.error(
      JSON.stringify(
        {
          format: 2,
          entries: [
            ...entries,
            {
              version: COPY_VERSION,
              hash: lowHash,
              signer: needsH3 ? 'H3' : 'A0 或 H5',
              signedAt: 'YYYY-MM-DD',
              reason: 'react-dom 键盘键名枚举 F1..F12，非业务出口',
              occurrences,
            },
          ],
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  if (occurrences.length > 0) {
    console.log(
      `[bundle] F1 低置信命中 ${occurrences.reduce((sum, item) => sum + item.count, 0)} 处，已由 ${current?.signer} 于 ${current?.signedAt} 第二人签字（${current?.reason ?? ''}）`,
    );
  }
  console.log(`[bundle] OK · 扫描 ${files.length} 个产物文件，未发现内部标识`);
}

main();
