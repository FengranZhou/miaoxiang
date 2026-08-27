#!/usr/bin/env bash
# review-headless.sh —— 纯粹一句话独立进程评审器（v7.3.0 极简）
#
# 设计（用户拍板）：评审 = 一个干净独立进程，只问一句宏观提问——
#   「这两张图属于同一个风格吗？」
# 判是=通过，判否=重生成。没有第②段、没有分区表/门类双轴/主题盲测/DNA清点——全删。
# 只保留上下游衔接（收参考图/生成图路径、写结论 JSON 回主流程）。
#
# 为什么这么极简：实测发现一堆评审规则（分区表/门类双轴/DNA清点…）既慢（第②段 ~2min）
# 又不提升质量、反而分散注意力让模型"找理由通过"放水；而独立干净进程只问一句话时，
# 判断反而更纯粹。规则太重 = 又慢又不准。所以彻底回归一句话。
#
# 独立进程 = 独立上下文（真 fresh-eyes、不被主流程"想让图过"的动机污染）+ 真 Read 像素。
#
# 用法：
#   review-headless.sh --ref <参考图绝对路径> --image <生成图绝对路径> \
#                      --theme <主题词> --temp-dir <本任务 temp_dir> --round <轮次>
#
# 输出：
#   1. 结果 JSON 落盘：<temp_dir>/review-result-第<round>轮.json
#   2. stdout 末行握手 JSON：{"status","result_path","round","child_exit"}
#
# 退出码：0=正常且结果文件已落盘；非0=异常（主窗口应报错，不静默通过）。

set -uo pipefail

REF="" IMAGE="" THEME="" TEMP_DIR="" ROUND=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)      REF="$2";      shift 2 ;;
    --image)    IMAGE="$2";    shift 2 ;;
    --theme)    THEME="$2";    shift 2 ;;
    --temp-dir) TEMP_DIR="$2"; shift 2 ;;
    --round)    ROUND="$2";    shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

# ---- 入参校验 ----
for pair in "ref:$REF" "image:$IMAGE" "theme:$THEME" "temp-dir:$TEMP_DIR" "round:$ROUND"; do
  name="${pair%%:*}"; val="${pair#*:}"
  if [[ -z "$val" ]]; then echo "缺少必填参数：--$name" >&2; exit 2; fi
done
if [[ ! -f "$REF" ]];   then echo "参考图不存在：$REF" >&2; exit 2; fi
if [[ ! -f "$IMAGE" ]]; then echo "生成图不存在：$IMAGE" >&2; exit 2; fi
if [[ ! -d "$TEMP_DIR" ]]; then echo "temp_dir 不存在：$TEMP_DIR" >&2; exit 2; fi

RESULT_PATH="$TEMP_DIR/review-result-第${ROUND}轮.json"
JUDGE_PATH="$TEMP_DIR/judge-第${ROUND}轮.json"
rm -f "$RESULT_PATH" "$JUDGE_PATH"

# ---- 干净环境启动 claude -p（v7.2.1 修 CC 嵌套崩溃）----
# 从 CC 窗口内 fire 本脚本时，claude -p 会继承父会话 CC 环境变量（CLAUDECODE / SESSION_ID 等）
# 导致 session 冲突崩溃。用 env -u 剥离，让子进程从真正干净的环境启动（也让"独立进程"名副其实）。
run_clean_claude() {
  env -u CLAUDECODE \
      -u CLAUDE_CODE_ENTRYPOINT \
      -u CLAUDE_CODE_SESSION_ID \
      -u CLAUDE_CODE_CHILD_SESSION \
      -u CLAUDE_CODE_EXECPATH \
      -u CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS \
      -u CLAUDE_EFFORT \
      -u AI_AGENT \
      claude -p "$1" --allowedTools "Read Write" >/dev/null 2>&1
}

# ============================================================
# 一句话宏观评审（干净独立进程，不 Read 任何文档、不给任何流程）
# ============================================================
read -r -d '' PROMPT <<EOF || true
Read 这两张图（真看像素）：
- 参考图: ${REF}
- 生成图: ${IMAGE}

这两张图属于同一个风格吗？画面主题差异不考虑在内。
如果不属于同一个风格，再判断一下：是在生成图基础上微调就能修好（比如只是某处颜色/线宽/细节偏了），还是风格根本错了、得整张重画？

然后用 Write 工具把结论写入这个文件（只写 JSON、不包 markdown、不加解释）：
${JUDGE_PATH}

JSON 格式：
{
  "同风格": "是 | 否",
  "修复方式": "微调 | 重画（仅当同风格=否时填，同风格=是时填 无）",
  "理由": "string（如实说清判断依据；若否，说清为什么选微调或重画）"
}

写完后 stdout 只回复一个字：done
EOF

echo "[review-headless] 一句话宏观评审 round=${ROUND} …" >&2
echo "[review-headless]   ref=${REF}" >&2
echo "[review-headless]   image=${IMAGE}" >&2

run_clean_claude "$PROMPT"
CHILD_EXIT=$?

if [[ $CHILD_EXIT -ne 0 ]] || [[ ! -s "$JUDGE_PATH" ]]; then
  echo "{\"status\":\"error\",\"reason\":\"judge_failed\",\"child_exit\":${CHILD_EXIT},\"result_path\":\"${RESULT_PATH}\",\"round\":${ROUND}}"
  exit 1
fi

# 解析判定：判是→通过，判否+微调→修订，判否+重画→重生成
SAME_STYLE=""
FIX_WAY=""
if command -v jq >/dev/null 2>&1; then
  SAME_STYLE=$(jq -r '.["同风格"] // empty' "$JUDGE_PATH" 2>/dev/null)
  FIX_WAY=$(jq -r '.["修复方式"] // empty' "$JUDGE_PATH" 2>/dev/null)
else
  grep -q '"同风格"[[:space:]]*:[[:space:]]*"否"' "$JUDGE_PATH" && SAME_STYLE="否" || SAME_STYLE="是"
  grep -q '"修复方式"[[:space:]]*:[[:space:]]*"微调"' "$JUDGE_PATH" && FIX_WAY="微调" || FIX_WAY="重画"
fi
echo "[review-headless]   判定：同风格=${SAME_STYLE} 修复方式=${FIX_WAY}" >&2

# 合成结论 JSON（python 安全写，避开理由里的引号）
python3 - "$RESULT_PATH" "$JUDGE_PATH" "$IMAGE" "$REF" "$THEME" <<'PYEOF'
import json, sys
result_path, judge_path, image, ref, theme = sys.argv[1:6]
with open(judge_path, encoding="utf-8") as f:
    judge = json.load(f)
same = judge.get("同风格", "是")
fix = judge.get("修复方式", "")
reason = judge.get("理由", "")
if same == "是":
    conclusion, strategy = "通过", "无"
elif fix == "微调":
    conclusion, strategy = "修订", "B（修订）"
else:  # 否 + 重画（或修复方式缺失，保守走重生成）
    conclusion, strategy = "重生成", "A（重生成）"
obj = {
  "结论": conclusion,
  "备注": "v7.3.0 一句话宏观评审（独立进程）",
  "同风格判定": {"同风格": same, "修复方式": fix, "理由": reason},
  "结论详情": {"值": conclusion, "迭代策略": strategy, "关键差异前三": ([reason] if same == "否" else [])},
  "推送载荷": {"图片路径": image, "轮次": None, "参考图路径": ref, "主题": theme}
}
with open(result_path, "w", encoding="utf-8") as f:
    json.dump(obj, f, ensure_ascii=False, indent=2)
PYEOF

if [[ ! -s "$RESULT_PATH" ]]; then
  echo "{\"status\":\"error\",\"reason\":\"write_failed\",\"child_exit\":0,\"result_path\":\"${RESULT_PATH}\",\"round\":${ROUND}}"
  exit 1
fi

echo "{\"status\":\"ok\",\"result_path\":\"${RESULT_PATH}\",\"round\":${ROUND},\"child_exit\":0}"
exit 0
