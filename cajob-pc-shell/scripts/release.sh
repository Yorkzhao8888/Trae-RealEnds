#!/usr/bin/env bash
# Cajob PC 壳 —— 构建 / 上传 / 校验 一键脚本（Phase 2 签名 + Phase 3 自动更新元数据）
#
# 用法：
#   ./scripts/release.sh                    # 全量：构建 mac+win 并上传
#   SKIP_UPLOAD=1 ./scripts/release.sh      # 只构建不上传
#   SKIP_WIN=1 ./scripts/release.sh         # 只出 mac 产物
#
# 签名/公证凭据（齐备时自动启用；缺失时 electron-builder 降级为未签名构建，不报错）：
#   CSC_LINK / CSC_KEY_PASSWORD                              # mac 签名身份
#   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID   # macOS 公证
#   WIN_CSC_LINK / WIN_CSC_PASSWORD                          # Windows Authenticode
#
# 上传目标：
#   REMOTE=user@host  DEST_DIR=/opt/oas/download/latest     # 缺省需设 REMOTE，否则必须 SKIP_UPLOAD=1
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-https://h5.cewaycloud.com/download/latest}"
ARTIFACTS="Cajob-mac-arm64.dmg Cajob-mac-x64.dmg Cajob-Setup.exe Cajob-mac-arm64.zip Cajob-win-x64.zip"
METADATA="latest-mac.yml latest.yml"

echo "==> [1/4] 构建 mac 产物（dmg+zip；注意：DMG 需在沙箱外执行）"
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "    检测到公证凭据 → 启用 notarize"
  npx electron-builder --mac -c.mac.notarize=true
else
  echo "    未检测到公证凭据 → 未签名构建（内测口径）"
  npx electron-builder --mac
fi

if [ "${SKIP_WIN:-0}" != "1" ]; then
  echo "==> [1/4] 构建 win 产物（nsis+zip）"
  npx electron-builder --win
fi

echo "==> [2/4] 产物清单（含自动更新元数据，yml 必须随产物同版本发布）"
ls -la dist-release/ | grep -E '\.(dmg|exe|zip|yml)$' || true

if [ "${SKIP_UPLOAD:-0}" = "1" ]; then
  echo "==> SKIP_UPLOAD=1，跳过上传与校验"
  exit 0
fi
: "${REMOTE:?请设置 REMOTE=user@host，或使用 SKIP_UPLOAD=1}"
DEST_DIR="${DEST_DIR:-/opt/oas/download/latest}"

echo "==> [3/4] 上传稳定名产物 + 更新元数据 → $REMOTE:$DEST_DIR"
# shellcheck disable=SC2086
rsync -av --checksum \
  $(for f in $ARTIFACTS $METADATA; do [ -f "dist-release/$f" ] && echo "dist-release/$f"; done) \
  "$REMOTE:$DEST_DIR/"

echo "==> [4/4] 线上字节校验"
fail=0
for f in $ARTIFACTS $METADATA; do
  [ -f "dist-release/$f" ] || continue
  local_size=$(stat -f%z "dist-release/$f" 2>/dev/null || stat -c%s "dist-release/$f")
  remote_size=$(curl -sI "$BASE_URL/$f" | grep -i '^content-length' | tail -1 | tr -dc '0-9')
  if [ "$local_size" = "$remote_size" ] && [ -n "$local_size" ]; then
    echo "MATCH  $f ($local_size bytes)"
  else
    echo "DIFF   $f  local=$local_size remote=$remote_size"
    fail=1
  fi
done
[ "$fail" = "0" ] && echo "==> 完成：全部 MATCH" || { echo "==> 存在 DIFF，请核查"; exit 1; }
