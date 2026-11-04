#!/usr/bin/env bash
# market-sense-h5 · 安装固定版本 oasdiff（契约破坏性 diff 门禁依赖）
# 为什么不用 latest：契约门禁必须可复现（Lead 派单 m00019）。升级走 PR 改版本号并重算校验值。
# 用法：
#   infra/ci/install-oasdiff.sh                 # 安装到 $RUNNER_TEMP/oasdiff（CI）或 ~/.local/bin（本地）
#   OASDIFF_BIN_DIR=/usr/local/bin infra/ci/install-oasdiff.sh
set -euo pipefail

OASDIFF_VERSION="1.35.0"
SHA256_LINUX_AMD64="a8023002fcb2eaa7f5758148a9303cb63d33b939886df312268bc0fc7b939140"
SHA256_DARWIN_ALL="964ad2c0331768c4515fc49779827094bc89a65b1d309dac28886d1c3faf305c"

UNAME_S="$(uname -s)"
UNAME_M="$(uname -m)"
case "${UNAME_S}/${UNAME_M}" in
  Linux/x86_64)  ASSET="oasdiff_${OASDIFF_VERSION}_linux_amd64.tar.gz";  EXPECTED="${SHA256_LINUX_AMD64}" ;;
  Linux/aarch64) ASSET="oasdiff_${OASDIFF_VERSION}_linux_arm64.tar.gz";  EXPECTED="" ;; # 用官方 checksums.txt 校验（见下）
  Darwin/*)      ASSET="oasdiff_${OASDIFF_VERSION}_darwin_all.tar.gz";   EXPECTED="${SHA256_DARWIN_ALL}" ;;
  *) echo "不支持的平台 ${UNAME_S}/${UNAME_M}" >&2; exit 1 ;;
esac

DEST_DIR="${OASDIFF_BIN_DIR:-}"
if [[ -z "${DEST_DIR}" ]]; then
  if [[ -n "${RUNNER_TEMP:-}" ]]; then DEST_DIR="${RUNNER_TEMP}/oasdiff-bin"; else DEST_DIR="${HOME}/.local/bin"; fi
fi
mkdir -p "${DEST_DIR}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

URL="https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/${ASSET}"
echo "下载 ${URL}"
curl -fsSL --retry 3 --max-time 120 -o "${TMP_DIR}/${ASSET}" "${URL}"

if [[ -z "${EXPECTED}" ]]; then
  curl -fsSL --retry 3 --max-time 60 -o "${TMP_DIR}/checksums.txt" \
    "https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/checksums.txt"
  EXPECTED="$(grep "  ${ASSET}\$" "${TMP_DIR}/checksums.txt" | awk '{print $1}')"
  [[ -n "${EXPECTED}" ]] || { echo "checksums.txt 中找不到 ${ASSET}" >&2; exit 1; }
fi

ACTUAL="$(shasum -a 256 "${TMP_DIR}/${ASSET}" | awk '{print $1}')"
if [[ "${ACTUAL}" != "${EXPECTED}" ]]; then
  echo "校验失败：期望 ${EXPECTED}，实际 ${ACTUAL}" >&2
  exit 1
fi
echo "sha256 校验通过"

tar -xzf "${TMP_DIR}/${ASSET}" -C "${TMP_DIR}"
install -m 0755 "${TMP_DIR}/oasdiff" "${DEST_DIR}/oasdiff"
"${DEST_DIR}/oasdiff" --version

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "${DEST_DIR}" >> "${GITHUB_PATH}"
fi
