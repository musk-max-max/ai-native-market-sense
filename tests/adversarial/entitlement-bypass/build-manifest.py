#!/usr/bin/env python3
"""A19 证据清单生成器：读取 artifacts/results.json，登记每个证据文件的 path/sha256/bytes/mtime/caseIds/run。

按 L82：manifest 不内嵌自身哈希；新 run 使用新文件名，不覆盖历史证据。
用法：python3 build-manifest.py  （在 tests/adversarial/entitlement-bypass 下）
"""
import json, hashlib, datetime, pathlib, sys

BASE = pathlib.Path(__file__).resolve().parent
ART = BASE / 'artifacts'

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

def info(p, role, cases, run):
    p = pathlib.Path(p)
    if not p.is_absolute():
        p = BASE / p
    st = p.stat()
    return {
        'path': str(p.relative_to(BASE)).replace('\\', '/'),
        'role': role, 'caseIds': cases, 'run': run,
        'bytes': st.st_size, 'sha256': sha(p),
        'mtime': datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc).isoformat(),
    }

CASE_MAP = [
    ('api-backdoor-default.log', ['G1']), ('api-backdoor-token-only.log', ['G2']),
    ('api-prod-profile.log', ['G3']),
    ('api-restricted.log', ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'H11', 'V1', 'C6']),
    ('api-limited.log', ['R1', 'R2', 'R3']), ('api-trustproxy-true.log', ['R3']),
    ('api-trustproxy-cidr.log', ['R4']),
    ('api-expiring.log', ['V1', 'V2', 'V3', 'E1', 'E2', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12']),
    ('api-bare-start.log', ['G4']),
    ('web-restricted.log', ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']),
    ('web-expiring.log', ['C7', 'C8', 'C9']),
]

def main():
    d = json.load(open(ART / 'results.json'))
    meta = d['meta']; run = meta['runId']
    g3 = next(c for c in d['checks'] if c['id'] == 'G3')
    tr = meta['rawHttpLogEvidence']
    tr_ev = info('artifacts/' + pathlib.Path(meta['rawHttpLog']).name, 'raw HTTP transcript', ['ALL'], run)
    log_ev = info('artifacts/logs/%s/api-prod-profile.log' % run, 'service stderr/stdout', ['G3'], run)
    pre = pathlib.Path('artifacts/results-prefix-g3-20261104T012350680Z.json')
    prefix_sha = sha(BASE / pre) if (BASE / pre).exists() else None

    g3out = {
        'meta': {
            'runId': run, 'startedAt': meta['startedAt'], 'finishedAt': meta['finishedAt'],
            'command': 'node tests/adversarial/entitlement-bypass/run.mjs', 'exitCode': 0,
            'dbUrl': meta['dbUrl'],
            'purpose': 'G3 post-fix 重跑（H5-R22 / L75）：prod profile + DEPLOYMENT_UID + 无 E2E env',
            'toolchain': {'node': meta['node'], 'chromium': meta.get('browser'), 'platform': meta['platform']},
            'preFixRef': {
                'results': 'artifacts/results-prefix-g3-20261104T012350680Z.json', 'sha256': prefix_sha,
                'g3': 'FAIL（started:false）——prod 缺 DEPLOYMENT_UID，config.ts:205 L65 守卫触发（预期行为）',
                'log': 'artifacts/logs/api-prod-profile.log',
                'logSha256': sha(BASE / 'artifacts/logs/api-prod-profile.log'),
            },
            'transcript': tr_ev, 'serviceLog': log_ev,
        },
        'check': g3,
    }
    (ART / ('results-g3-postfix-%s.json' % run)).write_text(json.dumps(g3out, ensure_ascii=False, indent=2))
    g3sha = sha(ART / ('results-g3-postfix-%s.json' % run))

    logs = []
    for p in sorted((ART / 'logs').rglob('*.log')):
        cases = next((c for pat, c in CASE_MAP if p.name == pat),
                     ['R4-guard'] if p.name.startswith('api-trustproxy-guard-') else ['unknown'])
        runid = p.parent.name if p.parent.name != 'logs' else 'pre-fix'
        logs.append(info(p.relative_to(BASE), 'service stderr/stdout', cases, runid))

    # H4 m00748：results.json 同路径内容由 pre-fix baseline 被替换为 post-fix canonical，
    # 必须在 manifest 内显式 supersedes（旧 sha256 + 归档路径），否则读者/签字引用会误判。
    results_entry = info('artifacts/results.json', 'canonical machine result (post-fix)', ['ALL'], run)
    results_entry['supersedes'] = {
        'archived_path': 'artifacts/results-prefix-g3-20261104T012350680Z.json',
        'archived_sha256': sha(BASE / 'artifacts/results-prefix-g3-20261104T012350680Z.json'),
        'phase': 'pre-fix',          # 唯一字段：语义=被归档内容所属代际（H4 m00823 / H5 m00772）
    }
    files = [
        results_entry,
        info('artifacts/results-g3-postfix-%s.json' % run, 'G3 post-fix focused result', ['G3'], run),
        info('artifacts/results-prefix-g3-20261104T012350680Z.json', 'pre-fix result archive (G3 FAIL)', ['G3'], '20261104T012350680Z'),
        tr_ev,
        info('artifacts/http-attempts-20261104T012350680Z.jsonl', 'pre-fix raw HTTP transcript (G3 FAIL run)', ['ALL'], '20261104T012350680Z'),
        info('artifacts/run-stdout-20261104T023750101Z.log', 'runner stdout/stderr (command transcript, EXIT:0)', ['ALL'], run),
        info('artifacts/results-r4.json', 'R4 post-fix result', ['R4'], '20261104T012350680Z'),
        info('artifacts/r4-before-fix.json', 'R4 pre-fix result (429→403)', ['R4'], 'pre-fix'),
        info('artifacts/trustproxy-guard.json', 'condition-1 guard post-fix 4/4', ['R4-guard'], 'post-fix'),
        info('artifacts/trustproxy-guard-before-fix.json', 'condition-1 guard pre-fix 0/4', ['R4-guard'], 'pre-fix'),
        info('REPORT.md', 'report', [], 'post-fix'),
        info('README.md', 'runner guide', [], 'post-fix'),
        info('build-manifest.py', 'manifest generator (this script)', [], 'post-fix'),
    ] + logs

    tombstones = []
    tomb = ART / 'http-attempts.jsonl'
    if tomb.exists():
        tombstones.append({
            'path': 'artifacts/http-attempts.jsonl',
            'role': 'TOMBSTONE: 0-byte transcript from pre-L75 truncate bug (do not use as evidence)',
            'caseIds': [], 'run': 'pre-fix', 'bytes': tomb.stat().st_size, 'sha256': sha(tomb),
            'mtime': datetime.datetime.fromtimestamp(tomb.stat().st_mtime, datetime.timezone.utc).isoformat(),
        })

    manifest = {
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'revision': 4,
        'runId': run,
        'command': 'node tests/adversarial/entitlement-bypass/run.mjs',
        'exitCode': 0,
        'summary': d['summary'],
        'postFixTranscript': tr_ev,
        'g3PostFix': {'resultFile': 'artifacts/results-g3-postfix-%s.json' % run, 'sha256': g3sha, 'observed': g3['observed'], 'log': log_ev},
        'files': files,
        'tombstones': tombstones,
        'receipts': {
            'generatedBy': 'A19 red-team',
            'deliveredTo': ['a11-qa-contract-data (v4 证据包)', 'h4-data', 'h5-security-ops'],
            'note': '按 L82：manifest 不内嵌自身哈希；新文件名、不覆盖旧证据。rev3（evidence-manifest-20261104T023750101Z.json，sha256 40fb117d…，H4 m00777 签字冻结）保留不动；本 rev4 为 H5 m00772 机器可读 supersedes 版本（新文件名）。run-scoped 与根目录历史 0 字节日志均已补 provenance 头（未伪造输出）；0 字节墓碑移入 tombstones、不计入 files。',
        },
    }
    out = ART / ('evidence-manifest-%s-rev4.json' % run)
    if out.name.endswith('-rev4.json'):
        # H5 m00834 errata：rev3 路径在交付窗口内被就地改写（caf6aca9 → 40fb117d），
        # 原始 caf6aca9 字节未另存保留；必须写进 rev4，避免 rev4 变成"掩盖改写"。
        manifest['errata'] = {
            'rev3_as_delivered': 'caf6aca93b599f20a2739e132981b845e1b05bd7ac5d89ab62d77de65c4bbd7f',
            'in_place_rewrite_to': '40fb117d8e82c6525b3d892e1eff8f13fef5feca34c9f03c467aac05c97f5584',
            'original_bytes_retained': False,
            'note': '交付后因追加 supersedes 被就地改写，原始字节未保留；本 rev4 为重建引用版（A11 v4 封包 tar fbc353cc… / commit 5bf22cb 内为 40fb117d…）。',
        }
        prev = ART / ('evidence-manifest-%s.json' % run)
        if prev.exists():
            # rev3 是 H4 m00777 的签字冻结快照；rev4 是 H5 m00772 的新文件名版本。
            # REPORT.md / build-manifest.py 因 H5 要求改动后，rev3 内这两个条目指向冻结时点版本，
            # 故用 supersedesManifest 显式记录代次关系，避免机械校验误判。
            manifest['supersedesManifest'] = {
                'path': str(prev.relative_to(BASE)).replace('\\', '/'),
                'sha256': sha(prev),
                'note': 'rev3（sha256 40fb117d…）仍为历史冻结快照、可复算（按其冻结时点文件）；rev4 为引用版（自洽于当前文件，承载 H5 m00772 机器可读 supersedes 与 REPORT 代次标注）。',
            }
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps({'manifest': str(out.relative_to(BASE)), 'files': len(files), 'logs': len(logs), 'tombstones': len(tombstones),
                      'manifestBytes': out.stat().st_size, 'manifestSha256': sha(out)}, ensure_ascii=False, indent=1))

if __name__ == '__main__':
    main()
