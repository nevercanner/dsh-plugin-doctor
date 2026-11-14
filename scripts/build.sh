#!/bin/bash
# Build: 编译 src/ → lib/（host 用 tsc），client 由 npm run build:client（tsdown）单独打。
# 依赖解析两种模式：① DSH_CHECKOUT 指向源码 checkout（packages/ 齐全）；
# ② 退化成装好的 dsh（$DSH_APP 或常见安装路径），直接链它 node_modules 里的 @deepseek-ai 类型。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

find_app() {
  local candidate
  for candidate in "${DSH_CHECKOUT:-}" "${DSH_APP:-}" "/d/deepseek/resources/app/dsh" "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh" "${APPDATA:-/nonexistent}/../Local/Programs/dsh/resources/app/dsh"; do
    [ -n "$candidate" ] || continue
    if [ -d "$candidate/node_modules/@deepseek-ai/dsh-tools" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

APP="$(find_app || true)"
if [ -z "$APP" ]; then
  echo "build: 找不到 dsh 安装目录（设置 DSH_APP 或 DSH_CHECKOUT）" >&2
  exit 1
fi
echo "=== dsh 依赖来源: $APP ==="

link() { # $1 = node_modules 下的相对路径, $2 = 目标绝对路径
  local link="$ROOT/node_modules/$1" target="$2"
  [ -e "$target" ] || { echo "build: 缺少依赖 $target" >&2; exit 1; }
  node -e "
    const fs=require('fs'), path=require('path');
    const link=path.resolve(process.argv[1]), target=path.resolve(process.argv[2]);
    fs.rmSync(link,{recursive:true,force:true});
    fs.mkdirSync(path.dirname(link),{recursive:true});
    fs.symlinkSync(target, link, process.platform==='win32'?'junction':'dir');
  " "$link" "$target"
}

mkdir -p node_modules/@deepseek-ai node_modules/@types node_modules/@standard-schema
for pkg in cordis cosmokit schemastery dsh-tools dsh-llm dsh-system-prompt; do
  [ -d "$APP/node_modules/@deepseek-ai/$pkg" ] && link "@deepseek-ai/$pkg" "$APP/node_modules/@deepseek-ai/$pkg"
done
[ -d "$APP/node_modules/@types/node" ] && [ ! -e "$ROOT/node_modules/@types/node/index.d.ts" ] && link "@types/node" "$APP/node_modules/@types/node"
[ -d "$APP/node_modules/@standard-schema/spec" ] && link "@standard-schema/spec" "$APP/node_modules/@standard-schema/spec"

TSC="$ROOT/node_modules/typescript/bin/tsc"
if [ ! -f "$TSC" ]; then
  TSC="$APP/node_modules/typescript/bin/tsc"
fi
if [ ! -f "$TSC" ]; then
  echo "build: 找不到 tsc（在插件目录跑 npm i -D typescript）" >&2
  exit 1
fi

echo "=== 编译 src → lib ==="
node "$TSC" -p tsconfig.json
echo "=== host 构建完成 ==="
