#!/usr/bin/env bash
# 捷才工友 PC 壳 —— 构建 / 上传 / 校验 一键脚本（Phase 2 签名 + Phase 3 自动更新元数据）
#
# 用法：
#   ./scripts/release.sh                    # 全量：构建 mac(arm64+x64)+win(x64) 并上传
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

BASE_URL="${BASE_URL:-https://hp.jechan.cewaysoft.com/download/latest}"
ARTIFACTS_MAC="JECHAN-mac-arm64.dmg JECHAN-mac-x64.dmg JECHAN-mac-arm64.zip JECHAN-mac-x64.zip"
ARTIFACTS_WIN="JECHAN-Setup.exe JECHAN-win-x64.zip"
METADATA="latest-mac.yml latest.yml"

EXPECTED="$ARTIFACTS_MAC"
if [ "${SKIP_WIN:-0}" != "1" ]; then
  EXPECTED="$EXPECTED $ARTIFACTS_WIN"
fi
# 更新元数据只在产出对应平台时要求
EXPECTED_META="latest-mac.yml"
if [ "${SKIP_WIN:-0}" != "1" ]; then
  EXPECTED_META="$EXPECTED_META latest.yml"
fi

rm -rf dist-release

echo "==> [1/4] 构建 mac 产物（arm64 + x64，dmg+zip）"
# 必须显式声明两个架构：electron-builder 默认只构建宿主架构，另一架构会静默缺失
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "    检测到公证凭据 → 启用 notarize"
  npx electron-builder --mac --arm64 --x64 --publish never -c.mac.notarize=true
else
  echo "    未检测到公证凭据 → 未签名构建（内测口径）"
  npx electron-builder --mac --arm64 --x64 --publish never
fi

if [ "${SKIP_WIN:-0}" != "1" ]; then
  echo "==> [1/4] 构建 win 产物（x64，nsis+zip）"
  npx electron-builder --win --x64 --publish never
fi

echo "==> [2/4] 产物完整性检查（缺失即失败，不允许静默跳过）"
missing=0
for f in $EXPECTED $EXPECTED_META; do
  if [ ! -f "dist-release/$f" ]; then
    echo "    MISSING  $f"
    missing=1
  fi
done
if [ "$missing" != "0" ]; then
  echo "==> 产物不全，终止。检查构建日志或架构参数。"
  ls -la dist-release/ 2>/dev/null || true
  exit 1
fi
ls -la dist-release/ | grep -E '\.(dmg|exe|zip|yml)$' || true

if [ "${SKIP_UPLOAD:-0}" = "1" ]; then
  echo "==> SKIP_UPLOAD=1，跳过上传与校验"
  exit 0
fi
: "${REMOTE:?请设置 REMOTE=user@host，或使用 SKIP_UPLOAD=1}"
DEST_DIR="${DEST_DIR:-/opt/oas/download/latest}"

echo "==> [3/4] 上传稳定名产物 + 更新元数据 → $REMOTE:$DEST_DIR"
rsync -av --checksum \
  $(for f in $EXPECTED $EXPECTED_META; do echo "dist-release/$f"; done) \
  "$REMOTE:$DEST_DIR/"

echo "==> [4/4] 线上字节校验"
fail=0
for f in $EXPECTED $EXPECTED_META; do
  local_size=$(stat -f%z "dist-release/$f" 2>/dev/null || stat -c%s "dist-release/$f")
  remote_size=$(curl -sI "$BASE_URL/$f" | grep -i '^content-length' | tail -1 | tr -dc '0-9')
  if [ -n "$local_size" ] && [ "$local_size" = "$remote_size" ]; then
    echo "MATCH  $f ($local_size bytes)"
  else
    echo "DIFF   $f  local=$local_size remote=${remote_size:-<missing>}"
    fail=1
  fi
done
[ "$fail" = "0" ] && echo "==> 完成：全部 MATCH" || { echo "==> 存在 DIFF，请核查"; exit 1; }
