#!/bin/bash
# ============================================================================
# 妙想 · 一键安装（双击运行）
# ----------------------------------------------------------------------------
# 做什么：把工具安置到 ~/.miaoxiang（常驻目录，之后自动更新都发生在那里），
# 装好本地桥 / skills / 各运行环境，最后引导你在 Chrome 里加载扩展（唯一手动步骤）。
# 幂等：装挂了随时再双击一次。
# ============================================================================
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MX_ROOT="$HOME/.miaoxiang"
REPO_HTTPS="https://github.com/FengranZhou/miaoxiang.git"

echo "==============================="
echo "  妙想 · 安装程序"
echo "==============================="

# ---- 0. 基础环境检查 -------------------------------------------------------
[[ "$(uname)" == "Darwin" ]] || { echo "✗ 仅支持 macOS"; exit 1; }
command -v git >/dev/null || { echo "✗ 需要 git：首次调用系统会弹出「安装命令行开发者工具」，装完后重新右键打开本文件"; git --version; exit 1; }
command -v python3 >/dev/null || echo "⚠ 未检测到 python3，抠图/去水印环境将跳过（可稍后补装）"
# Node.js 不作硬前提：没有就在第 1.5 步自动装便携版（不动系统）

# ---- 1. 安置常驻目录 ~/.miaoxiang -----------------------------------------
# 国内直连 GitHub 大概率不通，clone/pull 一律「直连失败 → gh-proxy 镜像」双源。
REPO_MIRROR="https://gh-proxy.com/$REPO_HTTPS"

mx_clone() { # $1 = 目标目录
  if git clone "$REPO_HTTPS" "$1" 2>/dev/null; then return 0; fi
  echo "→ 直连 GitHub 不通，改走加速镜像…"
  git clone "$REPO_MIRROR" "$1"   # origin 落在镜像上，以后自动更新也走镜像
}

if [[ "$SELF_DIR" == "$MX_ROOT" ]]; then
  echo "→ 已在常驻目录内运行，跳过安置"
elif [[ -d "$MX_ROOT/.git" ]]; then
  echo "→ 常驻目录已存在，拉取最新版本…"
  git -C "$MX_ROOT" pull --ff-only || echo "⚠ 拉取失败（可能离线），继续用现有版本"
else
  # 半途而废的旧安置（无 .git 的残留目录）直接清掉重来——机器管理目录，无用户数据
  [[ -d "$MX_ROOT" ]] && rm -rf "$MX_ROOT"
  echo "→ 克隆仓库到 $MX_ROOT …"
  if ! mx_clone "$MX_ROOT"; then
    echo "⚠ 在线克隆失败，改用本地拷贝（自动更新将不可用，联网后可重新双击本文件修复）"
    mkdir -p "$MX_ROOT"
    rsync -a "$SELF_DIR/" "$MX_ROOT/"
  fi
fi

# ---- 1.5 Node 运行时（无 Claude Code / 无 Node 的机器自动补齐） -------------
# 便携版解压在 ~/.miaoxiang/runtime/node，不写系统目录、不需要管理员密码。
# 桥服务 / 发散 / 按图生的 npm 依赖都靠它；lib/sync.sh 会自动把它加进 PATH。
mx_ensure_node() {
  command -v node >/dev/null && return 0
  [[ -x "$MX_ROOT/runtime/node/bin/node" ]] && return 0
  echo "→ 未检测到 Node.js，下载独立运行时（约 45MB，一次性）…"
  local ver="v20.18.1" arch tarball base ok=0
  case "$(uname -m)" in arm64) arch="darwin-arm64" ;; *) arch="darwin-x64" ;; esac
  tarball="node-${ver}-${arch}.tar.gz"
  mkdir -p "$MX_ROOT/runtime"
  for base in "https://cdn.npmmirror.com/binaries/node/${ver}" "https://nodejs.org/dist/${ver}"; do
    if curl -L --fail --retry 2 -C - -o "/tmp/${tarball}" "${base}/${tarball}"; then ok=1; break; fi
  done
  if [[ $ok -eq 1 ]] && tar -xzf "/tmp/${tarball}" -C "$MX_ROOT/runtime" \
     && rm -rf "$MX_ROOT/runtime/node" && mv "$MX_ROOT/runtime/node-${ver}-${arch}" "$MX_ROOT/runtime/node"; then
    rm -f "/tmp/${tarball}"
    echo "✓ Node 运行时就绪（$("$MX_ROOT/runtime/node/bin/node" -v)）"
  else
    echo "⚠ Node 运行时安装失败：AI 分析/发散/按图生将不可用，其余功能不受影响（联网后重跑本文件可补）"
  fi
}
mx_ensure_node

# ---- 2. 同步各就位点（skills / 桥 / 环境 / 模型 / CLAUDE 片段） ------------
# shellcheck source=/dev/null
source "$MX_ROOT/lib/sync.sh"
miaoxiang_sync_all

# ---- 3. 注册每日静默自动更新器 ---------------------------------------------
PLIST="$HOME/Library/LaunchAgents/com.miaoxiang.updater.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.miaoxiang.updater</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$MX_ROOT/update.command</string>
    <string>--silent</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$MX_ROOT/update.log</string>
  <key>StandardErrorPath</key><string>$MX_ROOT/update.log</string>
</dict>
</plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✓ 每日自动更新已开启（每天 11:30 静默检查）"

# ---- 4. 收尾引导：唯一的手动步骤 -------------------------------------------
EXT_DIR="$MX_ROOT/extension"
printf '%s' "$EXT_DIR" | pbcopy
# Finder 里定位并选中 extension 文件夹——用户把它拖进 Chrome 的文件选择框即可，
# 免去在隐藏目录里 Cmd+Shift+G 输路径的门槛
open -R "$EXT_DIR" 2>/dev/null || true
echo ""
echo "==============================================="
echo "  只剩最后一步（手动，约 20 秒）："
echo "  1. Chrome 打开 chrome://extensions"
echo "  2. 右上角打开「开发者模式」"
echo "  3. 点「加载未打包的扩展程序」（旧版 Chrome 叫「加载已解压的扩展程序」）"
echo "  4. 弹出的选择框里按 Cmd+Shift+G，粘贴（路径已复制）→ 回车 → 选择"
echo "==============================================="
# 尽力自动打开扩展页（失败不影响，照《妙想安装手册》第 3 步手动操作即可）
osascript -e 'tell application "Google Chrome" to activate' \
          -e 'tell application "Google Chrome" to open location "chrome://extensions/"' 2>/dev/null || true
echo "装好后点浏览器工具栏的妙想图标（或 Alt+Shift+D）即可使用。"
echo ""
echo "扩展加载成功后：当初下载的 zip 和解压出的 miaoxiang-main 文件夹都可以删掉——"
echo "工具已安置在系统里（~/.miaoxiang），不再依赖它们。祝顺利！"
