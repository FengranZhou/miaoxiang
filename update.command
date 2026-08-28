#!/bin/bash
# ============================================================================
# 妙想 · 手动/定时更新（双击运行；launchd 每日以 --silent 调用同一份）
# ----------------------------------------------------------------------------
# git pull 拉取最新版本 → 重跑同步引擎（幂等）。扩展文件有变化时提示重启 Chrome。
# ============================================================================
set -uo pipefail

MX_ROOT="$HOME/.miaoxiang"
[[ -d "$MX_ROOT/.git" ]] || { echo "✗ 未找到 ${MX_ROOT}（先跑 install.command）"; exit 1; }
[[ "${1:-}" == "--silent" ]] && export MX_SILENT=1

BEFORE=$(git -C "$MX_ROOT" rev-parse HEAD 2>/dev/null || echo none)
git -C "$MX_ROOT" pull --ff-only >/dev/null 2>&1 || {
  [[ "${MX_SILENT:-0}" == "1" ]] || echo "⚠ 拉取失败（网络？），保持现有版本"; exit 0; }
AFTER=$(git -C "$MX_ROOT" rev-parse HEAD)

# shellcheck source=/dev/null
source "$MX_ROOT/lib/sync.sh"

if [[ "$BEFORE" == "$AFTER" ]]; then
  # 没有新版本也把环境同步跑一遍（补装上次失败的 npm/venv/模型）
  miaoxiang_sync_all
  [[ "${MX_SILENT:-0}" == "1" ]] || echo "已是最新版本"
  exit 0
fi

miaoxiang_sync_all
VER=$(python3 -c "import json;print(json.load(open('$MX_ROOT/extension/manifest.json'))['version'])" 2>/dev/null || echo "?")

if git -C "$MX_ROOT" diff --name-only "$BEFORE" "$AFTER" | grep -q "^extension/"; then
  MSG="妙想已更新到 v${VER}，扩展部分在下次重启 Chrome 后生效"
  # 静默模式下发系统通知，让用户知道有更新落地了
  osascript -e "display notification \"$MSG\" with title \"妙想\"" 2>/dev/null || true
  [[ "${MX_SILENT:-0}" == "1" ]] || echo "✓ $MSG"
else
  [[ "${MX_SILENT:-0}" == "1" ]] || echo "✓ 已更新到 v$VER（skills/服务类更新，立即生效）"
fi
