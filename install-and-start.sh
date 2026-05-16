#!/usr/bin/env bash
# ============================================================
#  codex-responses-adapter — 全自动安装 + 启动（macOS / Linux）
#  王小王 著作 · 不得用于二次改编贩卖 · VX：YYYYFC0111
# ============================================================
#
#  1. 检测 Node.js 是否已安装且 >= 20
#  2. 没装就自动用 nvm 安装 LTS（macOS 用 brew，Linux 用 curl）
#  3. 启动 adapter

set -e

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

echo
echo "============================================================"
echo "  codex-responses-adapter 一键安装 / 启动"
echo "  王小王 著作  |  VX: YYYYFC0111"
echo "============================================================"
echo

# ----------------------------------------------------------
#  Step 1: 检测 Node.js
# ----------------------------------------------------------
echo "[1/3] 检测 Node.js ..."

need_install=1
if command -v node >/dev/null 2>&1; then
  ver=$(node -v | sed 's/^v//')
  major=${ver%%.*}
  echo "    已检测到 Node.js v${ver}"
  if [ "$major" -ge 20 ]; then
    echo "    版本满足要求 (>= 20)。"
    need_install=0
  else
    echo "    版本过低 (需要 >= 20)，将自动安装新版本。"
  fi
else
  echo "    未检测到 Node.js，将自动安装。"
fi

# ----------------------------------------------------------
#  Step 2: 安装 Node.js
# ----------------------------------------------------------
if [ "$need_install" -eq 1 ]; then
  echo
  echo "[2/3] 安装 Node.js LTS ..."

  os=$(uname -s)

  if [ "$os" = "Darwin" ]; then
    # macOS: 优先 brew，没 brew 用 nvm
    if command -v brew >/dev/null 2>&1; then
      echo "    使用 Homebrew 安装 ..."
      brew install node@20
      brew link --overwrite node@20
    else
      echo "    未检测到 Homebrew，使用 nvm 安装 ..."
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
      export NVM_DIR="$HOME/.nvm"
      [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
      nvm install --lts
      nvm use --lts
    fi
  else
    # Linux: 用 nvm，国内可用 npmmirror 镜像
    echo "    使用 nvm 安装 ..."
    if ! command -v curl >/dev/null 2>&1; then
      echo "[错误] 缺少 curl。请先 'sudo apt install curl' 或对应命令。"
      exit 1
    fi
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

    # 国内用户加速
    export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
    nvm install --lts
    nvm use --lts
  fi

  echo "    Node.js 安装完成。"
fi

# 让 PATH 在本会话立即生效
hash -r 2>/dev/null || true

# ----------------------------------------------------------
#  Step 3: 启动 adapter
# ----------------------------------------------------------
echo
echo "[3/3] 启动 codex-responses-adapter ..."
echo "    (首次启动会自动 npm install，约 1-2 分钟)"
echo "    (完成后浏览器会自动打开管理面板)"
echo

if [ ! -f "$SCRIPT_DIR/start.sh" ]; then
  echo "[错误] 找不到 start.sh，请确认目录完整。"
  exit 1
fi

chmod +x "$SCRIPT_DIR/start.sh"
exec "$SCRIPT_DIR/start.sh"
