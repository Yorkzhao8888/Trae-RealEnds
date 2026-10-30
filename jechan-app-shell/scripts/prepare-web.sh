#!/usr/bin/env bash
# 组装 Capacitor webDir。
#
# 壳的页面来自三处：
#   index.html      本地占位页（仅在 server.url 被移除时生效）
#   offline.html    server.errorPath 指向的断网兜底页
#   shell/          原生桥运行时（由 H5 根按需引入）
#
# 业务页面不在此组装：真实业务始终来自 https://hp.jechan.cewaysoft.com。
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist
cp index.html offline.html dist/
cp shell/jechan-shell.js dist/
[ -f ../shell-core/dist/selftest.html ] && cp ../shell-core/dist/selftest.html dist/ || true

echo "==> dist/ 就绪：$(ls dist | tr '\n' ' ')"
