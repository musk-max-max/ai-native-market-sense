#!/bin/bash
# 恢复「AI原生市场感知平台Agent团队可行性分析」主会话（session-3ecb64e0）
#
# 用途：把 22:19 被错误重写的会话日志还原为应用可加载的合法帧结构，并把该会话
#       重新登记回工作区索引，使其重新出现在侧栏。
#
# 用法：
#   bash recover-ai-native-session.sh          # 应用仍在运行时：等待其退出后自动修复
#   bash recover-ai-native-session.sh --now    # 应用已经退出：立即修复
#
# 修复完成后重新打开 DeepSeek Harness 即可。

set -euo pipefail

SESS="session-3ecb64e0-6fb4-4ee6-a0a0-2b51bca44071"
DASH="$HOME/.dsh"
ROOT="$DASH/sessions/--Users-leiyu-Documents-deepseek-harness-default-workspace--/$SESS"
REC="$DASH/recovered/$SESS/session.v4.jsonl.zstd"
WS="$DASH/storages/workspace.json"
PROJ="$DASH/storages/session_projcache/sessions/$SESS.json"

NODE="/opt/homebrew/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "错误：找不到 node"; exit 1; }

host_running() { ps -Ao comm= 2>/dev/null | grep -q 'Contents/MacOS/DeepSeek Harness$'; }

if [ "${1:-}" != "--now" ]; then
  if host_running; then
    echo "检测到 DeepSeek Harness 仍在运行。"
    echo "请现在完全退出应用（菜单 → 退出，或 Cmd+Q）。脚本会在退出后自动修复…"
    for _ in $(seq 1 600); do
      host_running || break
      sleep 1
    done
    if host_running; then
      echo "等待超时：应用 10 分钟内仍未退出，未做任何修改。"; exit 1
    fi
    echo "应用已退出，开始修复。"
    sleep 1
  fi
fi

[ -f "$REC" ] || { echo "错误：恢复文件不存在：$REC"; exit 1; }
[ -d "$ROOT" ] || { echo "错误：会话目录不存在：$ROOT"; exit 1; }

# 1) 会话日志：还原为合法帧结构（首帧只含 header 记录）
if ! cmp -s "$REC" "$ROOT/session.v4.jsonl.zstd"; then
  if [ ! -f "$ROOT/session.v4.jsonl.zstd.replaced-$(date +%Y%m%d-%H%M%S)" ]; then
    cp "$ROOT/session.v4.jsonl.zstd" "$ROOT/session.v4.jsonl.zstd.replaced-$(date +%Y%m%d-%H%M%S)"
  fi
  cp "$REC" "$ROOT/session.v4.jsonl.zstd"
  echo "1/3 已写入修复后的会话日志"
else
  echo "1/3 会话日志已是修复版本"
fi

# 2) 工作区索引：把会话 id 重新登记到该工作区 sessionIds 首位
"$NODE" - "$WS" "$SESS" <<'NODE'
const fs = require('node:fs');
const [ , , wsPath, sess ] = process.argv;
const d = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
const id = Object.keys(d.tables.workspaces).find((k) => d.tables.workspaces[k].path === '/Users/leiyu/Documents/deepseek-harness/default-workspace');
if (!id) { console.error('错误：workspace.json 中找不到 default-workspace'); process.exit(1); }
const ws = d.tables.workspaces[id];
if (ws.sessionIds.includes(sess)) { console.log('2/3 工作区索引已包含该会话'); process.exit(0); }
ws.sessionIds = [sess, ...ws.sessionIds];
ws.updatedAt = new Date().toISOString();
const tmp = wsPath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
fs.renameSync(tmp, wsPath);
console.log('2/3 已把会话重新登记到工作区索引');
NODE

# 3) 清掉旧的投影缓存，让应用从日志重建
rm -f "$PROJ"
echo "3/3 已清除旧投影缓存"

# 自检：首帧必须恰好是一条 header 记录，且全部行可解码
"$NODE" - "$ROOT/session.v4.jsonl.zstd" <<'NODE'
const fs = require('node:fs');
const zlib = require('node:zlib');
const buf = fs.readFileSync(process.argv[2]);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offs = [];
let i = 0;
for (;;) {
  const j = buf.indexOf(magic, i);
  if (j < 0) break;
  offs.push(j); i = j + 1;
}
const frames = [];
for (let k = 0; k < offs.length; k++) frames.push(zlib.zstdDecompressSync(buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length)));
const header = frames[0];
if (header.length === 0 || header.at(-1) !== 10 || header.indexOf(10) !== header.length - 1) {
  console.error('自检失败：首帧不是单条 header 记录'); process.exit(1);
}
const h = JSON.parse(header.subarray(0, -1).toString('utf8'));
if (h.id !== 'session-3ecb64e0-6fb4-4ee6-a0a0-2b51bca44071') { console.error('自检失败：header id 不符'); process.exit(1); }
let n = 0, minSeq = Infinity, maxSeq = -Infinity;
for (let k = 1; k < frames.length; k++) {
  let start = 0;
  for (let q = frames[k].indexOf(10); q !== -1; q = frames[k].indexOf(10, start)) {
    const line = frames[k].subarray(start, q); start = q + 1;
    if (line.length === 0) continue;
    const row = JSON.parse(line.toString('utf8'));
    n++; if (row.seq < minSeq) minSeq = row.seq; if (row.seq > maxSeq) maxSeq = row.seq;
  }
}
console.log(`自检通过：${frames.length} 帧，${n} 条事件，seq ${minSeq}..${maxSeq}，header 正常`);
NODE

echo
echo "修复完成。现在重新打开 DeepSeek Harness，侧栏第一项即为该会话。"
