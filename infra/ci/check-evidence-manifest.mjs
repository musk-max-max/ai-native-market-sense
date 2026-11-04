#!/usr/bin/env node
/**
 * H5-R19 证据包门禁（零依赖）。
 *
 * 校验 infra/evidence/evidence-manifest.json：
 *  1. 每条 artifact 存在、size>0、bytes/sha256 由本脚本独立复算并一致；
 *  2. manifest 覆盖 infra/evidence/ 下 100% 的待提交文件（不扫内容里的十六进制串）；
 *  3. 每条带 authority(authoritative|historical)/phase(pre-fix|post-fix)/非空 case_ids；
 *     drill/演练证据只允许出现在 infra/evidence/drill-manifest.json，不得混入签字证据包；
 *  4. 若给 --tarball <path>：tar 内文件集合与 manifest 条目一一对应。
 *
 * 用法：node infra/ci/check-evidence-manifest.mjs [--tarball evidence.tar.gz] [--json]
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE_DIR = join(ROOT, 'infra/evidence');
const MANIFEST = join(EVIDENCE_DIR, 'evidence-manifest.json');
const IGNORED = new Set(['evidence-manifest.json', 'drill-manifest.json']);
const AUTHORITY = new Set(['authoritative', 'historical']);
const DRILL_DIR = join(EVIDENCE_DIR, 'drill');
const DRILL_MANIFEST = join(EVIDENCE_DIR, 'drill-manifest.json');
const PHASE = new Set(['pre-fix', 'post-fix']);

const argv = process.argv.slice(2);
const jsonOut = argv.includes('--json');
const tarballIdx = argv.indexOf('--tarball');
const tarball = tarballIdx >= 0 ? argv[tarballIdx + 1] : process.env.EVIDENCE_TARBALL;

const failures = [];
const notes = [];
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (IGNORED.has(name)) continue;
    if (dir === EVIDENCE_DIR && name === 'drill') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(relative(ROOT, full));
  }
  return out;
}

if (!existsSync(MANIFEST)) {
  failures.push('缺少 infra/evidence/evidence-manifest.json（H5-R19：证据包必须有外置 manifest）');
} else {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (err) {
    failures.push(`evidence-manifest.json 不是合法 JSON：${err.message}`);
  }
  if (manifest) {
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
      failures.push('manifest.artifacts 为空');
    }
    const seen = new Set();
    for (const [i, e] of (manifest.artifacts ?? []).entries()) {
      const tag = `artifacts[${i}] ${e?.path ?? '<no path>'}`;
      if (typeof e?.path !== 'string' || e.path.length === 0) {
        failures.push(`${tag}: path 缺失`);
        continue;
      }
      if (seen.has(e.path)) failures.push(`${tag}: path 重复`);
      seen.add(e.path);
      if (!AUTHORITY.has(e.authority))
        failures.push(`${tag}: authority=${e.authority} 不在 authoritative|historical`);
      if (!PHASE.has(e.phase)) failures.push(`${tag}: phase=${e.phase} 不在 pre-fix|post-fix`);
      if (!Array.isArray(e.case_ids) || e.case_ids.length === 0)
        failures.push(`${tag}: case_ids 必须非空`);
      const full = join(ROOT, e.path);
      if (!existsSync(full)) {
        failures.push(`${tag}: 文件不存在`);
        continue;
      }
      const st = statSync(full);
      if (st.size === 0) failures.push(`${tag}: 文件 size=0`);
      if (typeof e.bytes === 'number' && st.size !== e.bytes)
        failures.push(`${tag}: bytes 声明 ${e.bytes}，实际 ${st.size}`);
      const actual = sha256(readFileSync(full));
      if (e.sha256 !== actual) failures.push(`${tag}: sha256 声明 ${e.sha256}，复算 ${actual}`);
    }
    const onDisk = walk(EVIDENCE_DIR);
    const unlisted = onDisk.filter((p) => !seen.has(p));
    if (unlisted.length > 0)
      failures.push(`manifest 未覆盖（100% 要求）：\n  - ${unlisted.join('\n  - ')}`);
    const missing = [...seen].filter((p) => !existsSync(join(ROOT, p)));
    if (missing.length === 0)
      notes.push(`manifest 覆盖 ${onDisk.length} 个文件，sha256 全部独立复算一致`);
    if (Array.isArray(manifest.related_manifests)) {
      for (const r of manifest.related_manifests) {
        if (typeof r?.path === 'string' && existsSync(join(ROOT, r.path))) {
          const actual = sha256(readFileSync(join(ROOT, r.path)));
          if (r.sha256 !== actual)
            failures.push(`related_manifests ${r.path}: sha256 声明 ${r.sha256}，复算 ${actual}`);
          notes.push(`related manifest ${r.path} 复算一致`);
        }
      }
    }
  }
}

// drill 证据独立 manifest（H5 m03007）：drill 只允许出现在 drill-manifest，不得混入签字包
if (!existsSync(DRILL_MANIFEST)) {
  if (existsSync(DRILL_DIR))
    failures.push('存在 infra/evidence/drill/ 但缺少 drill-manifest.json');
} else {
  let dm;
  try {
    dm = JSON.parse(readFileSync(DRILL_MANIFEST, 'utf8'));
  } catch (err) {
    failures.push(`drill-manifest.json 不是合法 JSON：${err.message}`);
  }
  if (dm) {
    const seen = new Set();
    for (const [i, e] of (dm.artifacts ?? []).entries()) {
      const tag = `drill artifacts[${i}] ${e?.path ?? '<no path>'}`;
      if (typeof e?.path !== 'string' || !e.path.startsWith('infra/evidence/drill/')) {
        failures.push(`${tag}: drill 证据必须在 infra/evidence/drill/ 下`);
        continue;
      }
      if (seen.has(e.path)) failures.push(`${tag}: path 重复`);
      seen.add(e.path);
      if (e.authority !== 'drill') failures.push(`${tag}: authority 必须是 drill`);
      if (!PHASE.has(e.phase)) failures.push(`${tag}: phase=${e.phase} 不在 pre-fix|post-fix`);
      if (!Array.isArray(e.case_ids) || e.case_ids.length === 0)
        failures.push(`${tag}: case_ids 必须非空`);
      const full = join(ROOT, e.path);
      if (!existsSync(full)) {
        failures.push(`${tag}: 文件不存在`);
        continue;
      }
      const st = statSync(full);
      if (st.size === 0) failures.push(`${tag}: 文件 size=0`);
      if (typeof e.bytes === 'number' && st.size !== e.bytes)
        failures.push(`${tag}: bytes 声明 ${e.bytes}，实际 ${st.size}`);
      const actual = sha256(readFileSync(full));
      if (e.sha256 !== actual) failures.push(`${tag}: sha256 声明 ${e.sha256}，复算 ${actual}`);
    }
    const onDisk = existsSync(DRILL_DIR) ? walk(DRILL_DIR) : [];
    const unlisted = onDisk.filter((p) => !seen.has(p));
    if (unlisted.length > 0)
      failures.push(`drill manifest 未覆盖（100% 要求）：\n  - ${unlisted.join('\n  - ')}`);
    if (unlisted.length === 0) notes.push(`drill manifest 覆盖 ${onDisk.length} 个文件（不进签字包）`);
  }
}

if (tarball) {
  if (!existsSync(tarball)) {
    failures.push(`--tarball 指定的文件不存在：${tarball}`);
  } else {
    const res = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    if (res.status !== 0) {
      failures.push(`tar -tzf 失败：${res.stderr.trim()}`);
    } else {
      const listed = res.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !s.endsWith('/'));
      let manifestPaths = [];
      try {
        manifestPaths = JSON.parse(readFileSync(MANIFEST, 'utf8')).artifacts.map((a) => a.path);
      } catch {
        // manifest 已单独报错
      }
      const norm = (s) => s.replace(/^\.\//, '');
      const extra = listed.filter(
        (t) => !manifestPaths.some((p) => norm(t) === p || norm(t).endsWith('/' + p)),
      );
      const missing = manifestPaths.filter(
        (p) => !listed.some((t) => norm(t) === p || norm(t).endsWith('/' + p)),
      );
      if (extra.length > 0)
        failures.push(`tar 内存在 manifest 之外的文件：\n  - ${extra.join('\n  - ')}`);
      if (missing.length > 0)
        failures.push(`tar 缺少 manifest 条目：\n  - ${missing.join('\n  - ')}`);
      if (extra.length === 0 && missing.length === 0)
        notes.push(`tar 文件集合与 manifest 一一对应（${listed.length} 个）`);
    }
  }
} else {
  notes.push(
    '未提供 --tarball：只校验目录 ↔ manifest 覆盖，未校验 tar 集合（release 打包时须传）',
  );
}

if (jsonOut) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, notes }, null, 2));
} else {
  for (const n of notes) console.log(`  ✓ ${n}`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  const total = failures.length;
  console.log(
    total === 0 ? '\n✅ 证据 manifest 校验通过' : `\n❌ 证据 manifest 校验失败（${total} 项）`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
