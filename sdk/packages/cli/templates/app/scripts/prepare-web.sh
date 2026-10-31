#!/usr/bin/env bash
# 组装 Capacitor webDir（由 uendos init 生成，勿手改文件名）。
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist
cp index.html offline.html dist/
if [ -f "shell/{{shellFile}}" ]; then cp "shell/{{shellFile}}" dist/; else
  echo "缺少 shell/{{shellFile}}：先运行 npx uendos sync" >&2
  exit 1
fi
echo "==> dist/ 就绪：$(ls dist | tr '\n' ' ')"
