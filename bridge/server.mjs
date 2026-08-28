#!/usr/bin/env node
/**
 * UX 自检桥 · 本地 HTTP 服务（零依赖，纯 node）
 *
 * 扩展"自检"tab 点按钮 → background fetch POST http://127.0.0.1:8765/audit
 *   → 本服务收到选中元素数据 → 调 `claude -p` 跑 UX 审查 → 返回结构化 JSON
 *
 * 事件驱动、按需调用：没有请求时服务空闲（不轮询、不烧 token），
 *   只有真的收到 /audit 请求才调一次 claude。
 *
 * 用法： node ~/ux-audit-bridge/server.mjs   （默认端口 8765）
 * 停止： Ctrl+C
 * 探活： curl http://127.0.0.1:8765/ping
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";

const BASE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8765);
const LOG_DIR = join(BASE, "log");
try { mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

// ============ 审查指令来源：优先读 ux-interaction-audit skill（唯一真源）============
// 直接读 skill 的 SKILL.md + references/ux-audit-framework.md 拼成审查指令，
// 这样改 skill 立即生效（每次请求重新读，见 buildPrompt）。skill 不存在时
// 回退到本目录自带的 audit-prompt.md（保底，保证分享出去也能跑）。
const HOME0 = process.env.HOME || homedir();
const SKILL_DIR = process.env.UX_SKILL_DIR
  || `${HOME0}/.claude/skills/ux-interaction-audit`;

// JSON 输出契约：skill 产出的是"给人读的报告结构"，bridge 需要"给程序读的 JSON"，
// 所以在 skill 规则之外，追加这段强制 JSON 输出契约。
const JSON_CONTRACT = `

---

## 输出契约（本次为程序化调用，务必严格遵守）

不要输出给人读的长报告，直接输出**一个 JSON 对象**（无解释文字、无 markdown 围栏）。

⚠️ JSON 合法性硬要求：字段值里**绝不使用英文双引号 \`"\`**（要引用词语用中文引号「」）；不要未转义的反斜杠/换行。

{
  "pageName": "页面名",
  "summary": "一句话总体结论 + 最该优先改的点",
  "score": 85,
  "level": "成熟|可用但需优化|一般|问题较多|高风险",
  "issues": [
    { "no": 1, "title": "问题标题", "severity": "P0|P1|P2|P3",
      "location": "问题在页面哪个位置的简短描述",
      "selector": "能唯一命中该问题对应子元素的 CSS 选择器",
      "impact": "为什么影响用户",
      "suggestion": "一句具体改法", "needVerify": false }
  ]
}

要求：先做 Step 0 上下文对齐（结合给到的页面名/上下文判断这是什么、用户目标、流程哪一步、多状态），再结合 9 大 UX 层面挑真问题、别套通用毛病；每个问题给严重程度/位置/影响/一句改法；HTML 看不出的（无障碍/焦点/状态）标 needVerify=true；通常 3-6 条，没明显问题就少给几条。

【selector 定位纪律（每条 issue 必给，极重要）】selector 用于在真实页面上 document.querySelector 把角标打到出问题的元素上。命中不到，角标就会飞/丢，所以宁可粗、绝不能编。

★★ 最高优先级铁律：selector 里出现的每一个 class 名、每一个标签名，都必须**逐字复制自上面给你的元素 HTML 原文**。禁止"推测""补全""按命名规范脑补"任何 class。写完每个 selector，回到 HTML 里用该 class 做一次字符串查找，查不到就不许用。

★★ 常见致命错误（绝对禁止）：看到卡片就臆想 BEM 风格 class（如 .card--entry-row、.card--policy__title、.card__desc、.item-mono__text 这类）。**这些几乎都是你编的、页面根本没有**。如果 HTML 里的元素其实没有语义化 class（只有 div 嵌套、或 class 是随机哈希、或压根没 class），你就**老老实实用标签+结构+nth-of-type 定位**（如 .pair-row > div:nth-of-type(2)），或**直接退回到被选中容器根元素的 selector**——这比编一个命中不到的漂亮 class 强一百倍。

定位步骤：① 优先用 HTML 里**真实出现过**的稳定 class 组合（如 .share_course_package_modal .footer button.primary）；② 一个 class 命中多个时，加父级/结构限定或 :nth-of-type 收窄到目标那一个；③ HTML 里没有可用的语义 class → 用 标签+结构+nth-of-type；④ 实在定位不到具体子元素（整体性/流程性问题）→ selector 设为被选中容器根元素的选择器；⑤ 任何情况都不要留空、不要编造。

【selector 语法硬规则，优先级高于中文引号要求】(1) selector 是 CSS 语法：属性选择器用英文写法或不写引号（input[type=text] 或 .footer button），绝不用中文引号「」（会让 querySelector 报错）。(2) 只用页面原生 class/标签，绝不用 data-label-id、data-selected、data-annotation 等扩展注入属性（页面没有，命中不到）。selector 越简单稳越好。`;

function buildPrompt() {
  // 优先：skill 真源
  try {
    let skillMd = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    // 剥掉开头的 YAML frontmatter（--- ... ---）：命令行里开头的 `---` 会被
    // claude CLI 当成选项分隔符导致解析失败，必须去掉。
    skillMd = skillMd.replace(/^---[\s\S]*?\n---\n/, "");
    const framework = readFileSync(join(SKILL_DIR, "references/ux-audit-framework.md"), "utf8");
    return `${skillMd}\n\n===== 参考框架 (references/ux-audit-framework.md) =====\n\n${framework}${JSON_CONTRACT}`;
  } catch (_) {
    // 回退：本目录自带的浓缩版（保证分享出去、无 skill 时也能跑）
    try { return readFileSync(join(BASE, "audit-prompt.md"), "utf8"); }
    catch (e2) { return `你是资深 UX 审查专家。${JSON_CONTRACT}`; }
  }
}

// claude CLI 定位（跨用户、跨安装方式，不硬编码用户名/路径）：
// launchd 环境 PATH 很干净，靠 PATH 会 ENOENT，所以尽量解析出绝对路径。
// 优先级：环境变量 CLAUDE_BIN > 常见安装位置逐个探测 > `which claude` > 回退裸 "claude"。
const HOME = process.env.HOME || homedir();
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const candidates = [
    `${HOME}/.npm-global/bin/claude`,
    `${HOME}/.local/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${HOME}/.bun/bin/claude`,
    `${HOME}/.volta/bin/claude`,
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  // 兜底：用登录 shell 解析（能拿到 nvm/asdf 等自定义路径）
  try {
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-lic", "command -v claude"], { encoding: "utf8" }).trim();
    if (out && existsSync(out)) return out;
  } catch (_) {}
  return "claude"; // 最后回退，靠 PATH
}
const CLAUDE_BIN = resolveClaudeBin();
const CHILD_ENV = {
  ...process.env,
  PATH: `${HOME}/.npm-global/bin:${HOME}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin${process.env.PATH ? ":" + process.env.PATH : ""}`,
  HOME,
};

function log(...a) { console.log(new Date().toLocaleTimeString(), ...a); }

// 两段式任务表：/audit/start 立即返回 taskId 并后台跑审查；/audit/result 轮询取结果。
// 这样扩展每次都是「秒回的短请求」，MV3 background service worker 无需长时间存活、
// 不会被 30s 空闲回收（长等待拆成多次短轮询）。
const tasks = new Map(); // taskId -> { status:'running'|'done'|'error', out?, ts }
let taskSeq = 0;
function newTaskId() { return `t${Date.now()}_${++taskSeq}`; }
// 清理超过 10 分钟的旧任务
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tasks) if (now - t.ts > 600000) tasks.delete(id);
}, 120000).unref?.();

// 从模型输出里尽力抠出 JSON 主体。返回 {ok, value} —— ok=false 表示解析失败（触发重试）。
function extractJson(text) {
  const t = (text || "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : t;
  const s = body.indexOf("{");
  const e = body.lastIndexOf("}");
  if (s >= 0 && e > s) {
    const candidate = body.slice(s, e + 1);
    try { return { ok: true, value: JSON.parse(candidate) }; } catch (_) {}
    return { ok: false, value: { _raw: candidate, _parseError: true } };
  }
  return { ok: false, value: { _raw: body, _parseError: true } };
}

// 调一次 claude -p，返回 {ok, stdout/error}
function callClaude(prompt) {
  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN,
      ["-p", prompt],
      { maxBuffer: 20 * 1024 * 1024, timeout: 150000, cwd: BASE, env: CHILD_ENV },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: err.message, stderr: (stderr || "").slice(0, 800) });
        else resolve({ ok: true, stdout });
      }
    );
  });
}

// 把扩展传来的 dataURL 截图落成临时 JPEG，返回绝对路径（失败返回 null）。
// claude -p 的 prompt 文本里带上这个绝对路径，CLI 会自动读图 → 让审查看到视觉，
// 不只是啃 HTML 文本。审查结束后由调用方删掉临时文件。
function saveScreenshot(dataUrl) {
  try {
    if (typeof dataUrl !== "string") return null;
    const m = dataUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
    if (!m) return null;
    const ext = m[1] === "png" ? "png" : "jpg";
    const buf = Buffer.from(m[2], "base64");
    if (!buf.length || buf.length > 15 * 1024 * 1024) return null;
    const p = join(tmpdir(), `ux-audit-shot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
    writeFileSync(p, buf);
    return p;
  } catch (_) { return null; }
}

// 跑审查：解析失败自动重试一次（提示模型上次 JSON 非法）
async function runAudit(req) {
  const shotPath = saveScreenshot(req.screenshot);

  const userContent = [
    `【页面名】${req.pageName || "未命名"}`,
    req.context ? `【上下文/项目背景】${req.context}` : "",
    shotPath
      ? `【选中元素截图】图片文件：${shotPath}\n（这是选中元素的纯净截图，无扩展标注线。请优先看图做视觉审查——层级/对齐/留白/对比/状态呈现，HTML 只作结构参考。）`
      : "",
    `【选中元素 HTML】\n${req.elementHtml || "(未提供)"}`,
    req.extra ? `【补充信息】${req.extra}` : "",
  ].filter(Boolean).join("\n\n");

  const basePrompt = `${buildPrompt()}\n\n---\n下面是本次要审查的元素：\n\n${userContent}`;
  const t0 = Date.now();
  log("▶ 收到审查请求：", req.pageName || "(未命名)", shotPath ? "[含截图]" : "[仅 HTML]");

  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = attempt === 1
        ? basePrompt
        : basePrompt + "\n\n⚠️ 上次输出的 JSON 无法解析（多半是值里出现了英文双引号）。请重新输出，字段值里绝不使用英文双引号（用「」代替），确保整体是一个可被 JSON.parse 的合法对象。";
      const r = await callClaude(prompt);
      if (!r.ok) {
        const ms = Date.now() - t0;
        log("✗ 审查失败：", r.error, `(${ms}ms)`);
        return { ok: false, error: r.error, stderr: r.stderr };
      }
      const parsed = extractJson(r.stdout);
      if (parsed.ok) {
        const ms = Date.now() - t0;
        const n = Array.isArray(parsed.value.issues) ? parsed.value.issues.length : 0;
        log("✓ 审查完成", `(${ms}ms)`, `${n} 条问题`, attempt > 1 ? "(重试后成功)" : "");
        return { ok: true, result: parsed.value };
      }
      log(`⚠ 第 ${attempt} 次 JSON 解析失败${attempt < 2 ? "，重试…" : ""}`);
      if (attempt === 2) {
        const ms = Date.now() - t0;
        log("✗ 两次均解析失败", `(${ms}ms)`);
        return { ok: true, result: parsed.value }; // 仍返回 _raw，前端显示解析失败提示
      }
    }
  } finally {
    if (shotPath) { try { unlinkSync(shotPath); } catch (_) {} }
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    // 允许扩展跨源调用
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

const server = createServer((req, res) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // 妙想「发散」：落盘截图 → 拉起 Playwright 驱动 Variant
  if (req.method === "POST" && req.url === "/variant/dispatch") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 24_000_000) req.destroy(); });
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(raw || "{}"); }
      catch (e) { return sendJson(res, 400, { ok: false, error: "bad json" }); }
      const dataUrl = String(payload.screenshot || "");
      const prompt = String(payload.prompt || "").trim() || "帮我优化一下这个地方";
      const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl);
      if (!m) return sendJson(res, 400, { ok: false, error: "截图格式不对（需要 data URL）" });
      const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
      const dir = join(BASE, "tmp-shots");
      try { mkdirSync(dir, { recursive: true }); } catch (_) {}
      const file = join(dir, `diverge-${Date.now()}.${ext}`);
      try { writeFileSync(file, Buffer.from(m[2], "base64")); }
      catch (e) { return sendJson(res, 500, { ok: false, error: "截图落盘失败：" + String(e && e.message || e) }); }
      // 只保留最近 30 张，便于排查又不涨盘
      try {
        const olds = readdirSync(dir).filter((f) => f.startsWith("diverge-")).sort();
        while (olds.length > 30) { try { unlinkSync(join(dir, olds.shift())); } catch (_) {} }
      } catch (_) {}
      execFile(process.execPath, [join(BASE, "variant-diverge.mjs"), file, prompt],
        { timeout: 180_000 }, (err, stdout, stderr) => {
          try { writeFileSync(join(LOG_DIR, `diverge-${Date.now()}.log`),
            `file=${file}\nprompt=${prompt}\n--- stdout ---\n${stdout || ""}\n--- stderr ---\n${stderr || ""}`); } catch (_) {}
          if (err) sendJson(res, 200, { ok: false, error: (String(stderr || "").trim().split("\n").pop()) || ("驱动失败：" + String(err.message || err)) });
          else sendJson(res, 200, { ok: true, file });
        });
    });
    return;
  }

  // 探活。managed 字段告诉扩展「这台机器是不是通过安装器分发的」——
  // 作者本机走源码、没有 ~/.miaoxiang，据此豁免错装检测，避免误报。
  if (req.method === "GET" && req.url === "/ping") {
    sendJson(res, 200, {
      ok: true, service: "ux-audit-bridge", port: PORT,
      managed: existsSync(join(homedir(), ".miaoxiang", "update.command")),
    });
    return;
  }

  // 妙想「立即更新」：更新弹窗上的按钮调这里，替用户跑一次 update.command。
  // 用户永远不需要知道 ~/.miaoxiang 的存在，也不用记任何命令——这是自动更新
  // 之外唯一的自救入口，故意只在弹窗里出现。
  if (req.method === "POST" && req.url === "/self-update") {
    const updater = join(homedir(), ".miaoxiang", "update.command");
    if (!existsSync(updater)) {
      return sendJson(res, 200, { ok: false, error: "未找到更新程序，请联系分发者重新安装" });
    }
    execFile("/bin/bash", [updater], { timeout: 600_000 }, (err, stdout, stderr) => {
      const tail = String(stdout || "").trim().split("\n").pop() || "";
      if (err) {
        sendJson(res, 200, { ok: false, error: (String(stderr || "").trim().split("\n").pop()) || String(err.message || err) });
      } else {
        sendJson(res, 200, { ok: true, message: tail || "已是最新版本" });
      }
    });
    return;
  }

  // 两段式 · 发起：立即返回 taskId，后台异步跑审查
  if (req.method === "POST" && req.url === "/audit/start") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 12_000_000) req.destroy(); });
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(raw || "{}"); }
      catch (e) { return sendJson(res, 400, { ok: false, error: "bad json" }); }
      const taskId = newTaskId();
      tasks.set(taskId, { status: "running", ts: Date.now() });
      // 后台跑，不阻塞响应
      runAudit(payload).then((out) => {
        tasks.set(taskId, { status: "done", out, ts: Date.now() });
        try { writeFileSync(join(LOG_DIR, `audit-${Date.now()}.json`), JSON.stringify({ req: payload, out }, null, 2)); } catch (_) {}
      }).catch((e) => {
        tasks.set(taskId, { status: "error", out: { ok: false, error: String(e && e.message || e) }, ts: Date.now() });
      });
      sendJson(res, 200, { ok: true, taskId });
    });
    return;
  }

  // 两段式 · 轮询取结果
  if (req.method === "GET" && req.url.startsWith("/audit/result")) {
    const u = new URL(req.url, "http://x");
    const taskId = u.searchParams.get("taskId") || "";
    const t = tasks.get(taskId);
    if (!t) { sendJson(res, 200, { ok: true, status: "unknown" }); return; }
    if (t.status === "running") { sendJson(res, 200, { ok: true, status: "running" }); return; }
    // done / error
    sendJson(res, 200, { ok: true, status: t.status, ...(t.out || {}) });
    return;
  }

  // 审查
  if (req.method === "POST" && req.url === "/audit") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 12_000_000) req.destroy(); });
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(raw || "{}"); }
      catch (e) { return sendJson(res, 400, { ok: false, error: "bad json" }); }
      const out = await runAudit(payload);
      // 留档便于排查
      try {
        writeFileSync(join(LOG_DIR, `audit-${Date.now()}.json`),
          JSON.stringify({ req: payload, out }, null, 2));
      } catch (_) {}
      sendJson(res, out.ok ? 200 : 500, out);
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`UX 自检桥已启动 → http://127.0.0.1:${PORT}`);
  log("探活: curl http://127.0.0.1:" + PORT + "/ping");
  log("停止: Ctrl+C");
});
