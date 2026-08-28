#!/bin/bash
# ============================================================================
# 妙想 · 同步引擎（install.command / update.command / launchd 更新器共用）
# ----------------------------------------------------------------------------
# 职责：把 ~/.miaoxiang 仓库里的内容安置到本机各就位点。幂等，可反复跑。
#   - skills/  → ~/.claude/skills/（逐个 skill 精确镜像）
#   - bridge/  → launchd 常驻服务（复用 bridge/install.sh）
#   - 按图生环境：npm 依赖 / Python venv / 抠图模型 / Confirm.app 去隔离
#   - 使用者版 CLAUDE 片段 → ~/.claude/CLAUDE.md（标记块，重复跑会更新）
# 被调用方式：source 本文件后调 miaoxiang_sync_all；环境变量 MX_SILENT=1 时静默。
# ============================================================================

MX_ROOT="${MX_ROOT:-$HOME/.miaoxiang}"
MX_LOG="$MX_ROOT/update.log"

# 便携 Node 运行时（无系统 Node 的机器由 install.command 解压到这里）。
# 放 PATH 头部：install/update/launchd 三个入口都经过本文件，统一生效。
if [[ -d "$MX_ROOT/runtime/node/bin" ]]; then
  export PATH="$MX_ROOT/runtime/node/bin:$PATH"
fi
NPM_REGISTRY="https://registry.npmmirror.com"
PIP_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
MODEL_BASE="https://github.com/FengranZhou/miaoxiang/releases/download/models-v1"

mx_log() {
  if [[ "${MX_SILENT:-0}" == "1" ]]; then echo "[$(date '+%F %T')] $*" >> "$MX_LOG"
  else echo "$*"; fi
}

mx_sync_skills() {
  mkdir -p "$HOME/.claude/skills"
  local s
  for s in "$MX_ROOT/skills"/*/; do
    [[ -d "$s" ]] || continue
    local name; name="$(basename "$s")"
    # --delete 让每个 skill 与发布版精确一致；同事自己的其他 skill 不受影响。
    # 环境产物（node_modules/.venv/模型缓存）不在仓库里，须排除以免被 --delete 清掉。
    rsync -a --delete \
      --exclude=node_modules --exclude=.venv --exclude=.wheels \
      --exclude='*.log' --exclude=__pycache__ \
      "$s" "$HOME/.claude/skills/$name/"
    mx_log "✓ skill 已同步：$name"
  done
}

mx_setup_anystyle_env() {
  local d="$HOME/.claude/skills/按图生"
  [[ -d "$d" ]] || return 0

  # Confirm.app / 可执行去 Gatekeeper 隔离（下载产物首次运行会被拦）
  xattr -dr com.apple.quarantine "$d/bin" 2>/dev/null || true

  # npm 依赖。判定标准不是「node_modules 目录在不在」——装到一半失败会留下
  # 半成品目录，光看目录会误判为已装好（同事实测：发散报「找不到 playwright-core」）。
  # 这里改为检查真正被消费的那个包是否可用。
  local need_npm=0
  [[ -f "$d/node_modules/playwright-core/package.json" ]] || need_npm=1
  [[ "$d/package-lock.json" -nt "$d/node_modules" ]] && need_npm=1
  if [[ $need_npm -eq 1 ]]; then
    mx_log "→ 按图生 npm 依赖安装中…"
    local npm_ok=0 reg
    # 镜像优先 + 官方源兜底；失败清掉半成品再重来，避免残留把下次判定带偏
    for reg in "$NPM_REGISTRY" "https://registry.npmjs.org"; do
      if (cd "$d" && npm install --registry="$reg" --no-audit --no-fund >>"$MX_LOG" 2>&1) \
         && [[ -f "$d/node_modules/playwright-core/package.json" ]]; then
        npm_ok=1; break
      fi
      rm -rf "$d/node_modules"
    done
    if [[ $npm_ok -eq 1 ]]; then
      mx_log "✓ npm 依赖就绪"
    else
      mx_log "⚠ npm 依赖安装失败 —— 「发散」与「按图生」将不可用（其他功能不受影响）。"
      mx_log "  可稍后重跑更新程序重试；持续失败请把 ${MX_LOG} 发给分发者。"
    fi
  fi

  # 抠图 venv：requirements 锁定重建
  if [[ ! -x "$d/.venv/bin/python3" ]]; then
    mx_log "→ 按图生 Python 环境创建中（抠图/图像后处理）…"
    if python3 -m venv "$d/.venv" >>"$MX_LOG" 2>&1 \
       && "$d/.venv/bin/pip" install -q -i "$PIP_INDEX" -r "$d/requirements-cutout.txt" >>"$MX_LOG" 2>&1; then
      mx_log "✓ Python 环境就绪"
    else
      mx_log "⚠ Python 环境创建失败（抠图暂不可用）。稍后手动：python3 -m venv $d/.venv && $d/.venv/bin/pip install -i $PIP_INDEX -r $d/requirements-cutout.txt"
    fi
  fi
}

mx_setup_watermark_env() {
  local d="$HOME/.claude/skills/去水印"
  [[ -d "$d" ]] || return 0
  if [[ ! -x "$d/.venv/bin/python3" ]]; then
    mx_log "→ 去水印 Python 环境创建中…"
    if python3 -m venv "$d/.venv" >>"$MX_LOG" 2>&1 \
       && "$d/.venv/bin/pip" install -q -i "$PIP_INDEX" opencv-python-headless numpy >>"$MX_LOG" 2>&1; then
      mx_log "✓ 去水印环境就绪"
    else
      mx_log "⚠ 去水印环境创建失败（该功能暂不可用），详见 $MX_LOG"
    fi
  fi
}

mx_download_models() {
  mkdir -p "$HOME/.u2net"
  local m u ok
  for m in birefnet-general.onnx u2net.onnx; do
    local dst="$HOME/.u2net/$m"
    [[ -s "$dst" ]] && continue
    mx_log "→ 下载抠图模型 ${m}（一次性，请耐心）…"
    ok=0
    # 镜像优先（国内直连 GitHub Release 常见 KB 级龟速）；镜像挂了退直连。
    # --speed-limit：持续 30s 低于 50KB/s 视为坏源，及时放弃换下一个。
    for u in "https://gh-proxy.com/$MODEL_BASE/$m" "$MODEL_BASE/$m"; do
      if curl -L --fail --retry 2 -C - --speed-limit 51200 --speed-time 30 \
           -o "$dst.part" "$u" >>"$MX_LOG" 2>&1; then ok=1; break; fi
    done
    if [[ $ok -eq 1 ]]; then
      mv "$dst.part" "$dst"; mx_log "✓ 模型就绪：$m"
    else
      rm -f "$dst.part"
      mx_log "⚠ 模型 $m 下载失败（抠图将不可用）。可稍后双击 update.command 重试，或参考 README 的手动下载方法"
    fi
  done
}

mx_setup_bridge() {
  [[ -f "$MX_ROOT/bridge/install.sh" ]] || return 0
  # bridge/install.sh 自带幂等（先卸后装）与探活；静默模式收进日志
  if bash "$MX_ROOT/bridge/install.sh" >>"$MX_LOG" 2>&1; then
    mx_log "✓ 本地桥已就绪（AI 深度分析 / 发散）"
  else
    mx_log "⚠ 本地桥安装未成功（AI 深度分析/发散暂不可用），详见 $MX_LOG"
  fi
}

mx_setup_claude_snippet() {
  local snippet="$MX_ROOT/claude-snippet.md"
  [[ -f "$snippet" ]] || return 0
  local target="$HOME/.claude/CLAUDE.md"
  mkdir -p "$HOME/.claude"; touch "$target"
  python3 - "$snippet" "$target" <<'PYEOF'
import sys
snippet = open(sys.argv[1], encoding='utf-8').read().strip()
path = sys.argv[2]
src = open(path, encoding='utf-8').read()
START, END = '<!-- miaoxiang:start -->', '<!-- miaoxiang:end -->'
block = f'{START}\n{snippet}\n{END}'
if START in src and END in src:
    pre = src.split(START)[0]
    post = src.split(END)[1]
    out = pre + block + post
else:
    out = src.rstrip() + '\n\n' + block + '\n'
open(path, 'w', encoding='utf-8').write(out)
PYEOF
  mx_log "✓ CLAUDE 使用须知已写入 ~/.claude/CLAUDE.md（miaoxiang 标记块）"
}

# 受管标记：只在 ~/.miaoxiang/extension 里生成，不入 git。扩展启动时读它判断
# 自己是不是「会被自动更新的那一份」；下载文件夹里的副本没有此文件 → 扩展告警。
mx_write_install_tag() {
  local ext="$MX_ROOT/extension"
  [[ -d "$ext" ]] || return 0
  printf '{"managed":true,"root":"%s"}\n' "$MX_ROOT" > "$ext/install-tag.json"
}

miaoxiang_sync_all() {
  mkdir -p "$MX_ROOT"; touch "$MX_LOG"
  mx_write_install_tag
  mx_sync_skills
  mx_setup_bridge
  mx_setup_anystyle_env
  mx_setup_watermark_env
  mx_download_models
  mx_setup_claude_snippet
}
