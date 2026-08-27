#!/usr/bin/env node
// doubao-gen.mjs — drive Doubao (豆包) image generation via CDP
//
// 单 tab 模式（兼容 v3.4）：
//   node doubao-gen.mjs --ref <image> --prompt "<text>" --theme "<text>" [--round N] [--auto-review]
//
// 双 tab 并行模式（V5.0 全自动）：
//   node doubao-gen.mjs --ref <image> --prompt-a "<极简>" --prompt-b "<标准>" --theme "<text>" [--round N] [--orig-ref <image>] [--auto-review]
//     --prompt-a   极简档 prompt（只主体描述+输出）
//     --prompt-b   标准档 prompt（v3.4 完整 9 字段）
//     --orig-ref   原始参考图（首轮用户给的那张）。迭代轮次里 --ref 通常是"上轮 winner"。
//                  V5.0 主流程挑 winner 时左/对照位用 ORIG_REF（保持原始参考图认知锚点稳定）
//
// V5.0 变更：移除 picker 浮窗，主流程接管挑 winner。
//   --auto-review        生成完后输出 next_action = main_pick_winner
//                        主流程并行 Read 3 张图（orig_ref + A + B）按宏观维度自主挑 winner
//                        强制输出：两张观察 + winner + 一句话原因
//                        挑完 rm 落选 + mv winner → 第N轮-winner.png，再 invoke 按图生-评审
//   --theme "<text>"     主题词（必填于 auto-review 时）
//   --round N            当前轮次（默认 1）
//   生成原图存到 /tmp/按图生-评审/{任务ID}/

import { chromium } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

// v8.4.4 豆包改版适配：输入框从 <textarea placeholder="发消息"> 换成 Tiptap/ProseMirror contenteditable div。
// 用逗号选择器同时兼容新旧两版（豆包若回滚，旧 textarea 仍能命中），.first() 取先匹配到的那个。
const INPUT_SEL = 'div.ProseMirror[contenteditable="true"], div.ProseMirror, textarea[placeholder*="发消息"]';

const argv = Object.fromEntries(
  process.argv.slice(2).reduce((acc, tok, i, arr) => {
    if (tok.startsWith("--")) acc.push([tok.slice(2), arr[i + 1] ?? true]);
    return acc;
  }, [])
);

const AUTO_REVIEW = "auto-review" in argv;
const THEME = argv.theme !== undefined && argv.theme !== true ? String(argv.theme) : null;
const ROUND = argv.round !== undefined && argv.round !== true ? parseInt(argv.round) : 1;
const DEBUG  = argv.debug ? true : false;
// v8.3.0：端口从全行业默认的 9222 挪到按图生专属的 9333。
// 病根：9222 是 Chrome DevTools 业界默认口，任何自动化工具（其它项目的 cp-nav 导航 headless、
// 手动开的调试 Chrome、别的 skill）都会抢它。谁先占谁得，按图生只探测"9222 有没有人在听"、
// 不校验听的是不是自己的豆包实例，于是盲连到别人的空白 headless 页 → 用户看不到窗口 →
// 永远等不到出图 → 150s 超时空转。挪到 9333 后物理隔离，不再撞车。
const DEBUG_PORT = argv.port !== undefined && argv.port !== true ? String(argv.port) : "9333";
const CDP    = argv.cdp ?? `http://localhost:${DEBUG_PORT}`;

// Mode detection: 单 tab vs 双 tab
const HAS_PROMPT_A = argv["prompt-a"] !== undefined && argv["prompt-a"] !== true;
const HAS_PROMPT_B = argv["prompt-b"] !== undefined && argv["prompt-b"] !== true;
const HAS_PROMPT   = argv.prompt   !== undefined && argv.prompt   !== true;
const MODE = (HAS_PROMPT_A && HAS_PROMPT_B) ? "dual" : "single";

// Validation
if (!argv.ref) {
  console.error("Usage: node doubao-gen.mjs --ref <image> [--prompt \"<text>\" | --prompt-a \"<极简>\" --prompt-b \"<标准>\"] --theme \"<text>\"");
  process.exit(1);
}
if (MODE === "single" && !HAS_PROMPT) {
  console.error("Single-tab mode needs --prompt");
  process.exit(1);
}
if (AUTO_REVIEW && !THEME) {
  console.error("--auto-review requires --theme \"<主题词>\"");
  process.exit(1);
}

const REF = resolve(argv.ref);
// --orig-ref：原始参考图（首轮用户给的那张）。
// 迭代轮次里 --ref 会变成"上轮 winner"，主流程挑 winner 时若用 --ref 当对照就成了
// 拿"上轮 winner"对比"本轮 A/B"，失去和原始参考图对比的认知锚点。
// 传入 --orig-ref 后主流程的 Read 三图始终用最原始那张当对照。
// 不传则回落 REF（首轮 / 重生成路径下 --ref 就是原始参考图，回落正确）。
const ORIG_REF = argv["orig-ref"] !== undefined && argv["orig-ref"] !== true
  ? resolve(String(argv["orig-ref"]))
  : REF;
// A 档前缀：主流程只写主体大白话（"一支铅笔"），脚本统一补上指令前缀再发给豆包。
// 放在脚本层而不是靠主流程自觉写，是为了让首轮 / 修订轮 / 重生成轮全自动生效、不会漏。
// 已带前缀的直接透传，避免重复拼接。
const A_PREFIX = "帮我按照参考图，生成";
const withAPrefix = (t) => (t.startsWith(A_PREFIX) ? t : A_PREFIX + t);

const PROMPTS = MODE === "dual"
  ? [
      { tag: "A", complexity: "极简", text: withAPrefix(String(argv["prompt-a"])) },
      { tag: "B", complexity: "标准", text: String(argv["prompt-b"]) },
    ]
  : [
      { tag: null, complexity: null, text: String(argv.prompt) },
    ];

// task_id 复用策略（V5.0.1 修复"一任务多目录"bug）：
// - 迭代修订轮：--ref 是上轮 winner（路径形如 /tmp/按图生-评审/<task_id>/第N轮-winner.png）→ 复用上轮 task_id
// - 首轮 / 重生成轮：--ref 是原始参考图（路径在用户本地），不在临时目录下 → 按时间戳新建 task_id
// 这样同一任务的所有轮次 winner + iteration-log.json 共享同一个 temp_dir，收敛性兜底才能工作
const TEMP_DIR_ROOT = "/tmp/按图生-评审";
const refTaskIdMatch = REF.match(new RegExp(`^${TEMP_DIR_ROOT}/([^/]+)/`));
const TASK_ID = refTaskIdMatch
  ? refTaskIdMatch[1]  // 复用上轮 task_id
  : `${Date.now()}-${THEME ?? "no-theme"}`.replace(/[^a-zA-Z0-9一-龥-]/g, "_");
const TEMP_DIR = `${TEMP_DIR_ROOT}/${TASK_ID}`;

if (!existsSync(REF)) { console.error(`reference not found: ${REF}`); process.exit(2); }
if (ORIG_REF !== REF && !existsSync(ORIG_REF)) { console.error(`original reference not found: ${ORIG_REF}`); process.exit(2); }
mkdirSync(TEMP_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const tlog = (tag, ...a) => log(tag ? `[${tag}]` : "    ", ...a);
const shot = async (page, tag, name) => {
  if (!DEBUG) return;
  const p = `/tmp/dg-${tag ?? "x"}-${name}.png`;
  await page.screenshot({ path: p });
  log(`  📸 ${p}`);
};

// Ensure Chrome CDP is running
async function ensureChromeOnCDP(cdpUrl) {
  const versionUrl = cdpUrl.replace(/\/$/, "") + "/json/version";
  const ping = async (timeout) => {
    try {
      const r = await fetch(versionUrl, { signal: AbortSignal.timeout(timeout) });
      return r.ok;
    } catch { return false; }
  };
  if (await ping(2000)) return;
  log(`CDP not reachable on :${DEBUG_PORT} — 启动【有头/可见】Chrome（用户要求：每次跑豆包必须能在浏览器里亲眼看到）`);
  const { spawn } = await import("node:child_process");
  const proc = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${process.env.HOME}/.chrome-automation`,
      // 显式反 headless：即便系统/环境残留 headless 偏好，也强制开可见窗口。
      "--new-window",
      "https://www.doubao.com/chat/",
    ],
    { detached: true, stdio: "ignore" }
  );
  proc.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await ping(1000)) { log("  Chrome ready"); return; }
  }
  throw new Error("Chrome failed to come up within 15s after launch");
}

await ensureChromeOnCDP(CDP);

// Chrome 149+ 对 http://.../json/version/ 返回 400，playwright-core 的 http 入口连不上；
// 先取出 webSocketDebuggerUrl 用 ws 直连可绕过。
async function resolveWsEndpoint(cdpUrl) {
  const versionUrl = cdpUrl.replace(/\/$/, "") + "/json/version";
  try {
    const r = await fetch(versionUrl, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
  } catch {}
  return cdpUrl; // 兜底：拿不到 ws 就退回原 http URL
}

async function connectWithSelfHeal(cdpUrl) {
  try {
    return await chromium.connectOverCDP(await resolveWsEndpoint(cdpUrl));
  } catch (e) {
    const msg = String(e);
    if (!/setDownloadBehavior|context management|not supported/i.test(msg)) throw e;
    const { execSync } = await import("node:child_process");
    // 并行保护（v6.3.0）：有其他 doubao-gen 进程在跑时禁止 pkill 共享 Chrome（会杀掉别的任务）
    let others = 0;
    try { others = parseInt(execSync(`pgrep -f doubao-gen.mjs | wc -l`).toString().trim(), 10) - 1; } catch {}
    if (others > 0) {
      throw new Error(`stale CDP session, but ${others} 个其他 doubao-gen 进程正在运行 — 拒绝 pkill 共享 Chrome。等其他任务结束后重试，或手动重启 Chrome。原始错误: ${msg}`);
    }
    log("stale CDP session detected — killing Chrome & restarting");
    try { execSync(`pkill -f "remote-debugging-port=${DEBUG_PORT}"`); } catch {}
    await new Promise(r => setTimeout(r, 2000));
    await ensureChromeOnCDP(cdpUrl);
    return await chromium.connectOverCDP(await resolveWsEndpoint(cdpUrl));
  }
}

log(`connecting to ${CDP} (mode=${MODE})`);
let browser = await connectWithSelfHeal(CDP);
let [ctx] = browser.contexts();

// v8.3.1 实例身份校验（轻量版）：连上后确认这是"我们自己的实例"，而不是别人占端口留下的隐形空壳。
// v8.3.0 教训：旧版用"新开 tab → goto 豆包 → 关掉"来探测，是错的重手段——(1) 脚本后面本来就要开豆包 tab
// 干活，探测 tab 纯属多开一个还白占加载时间；(2) 拿"一次 goto 超时"当"连错实例"判据太激进——豆包首次
// 加载偶发慢就会误判成连错，触发杀实例重启、再开 tab，于是"刚打开豆包却不用、非要另外再开俩"。
// 修法：不打开任何页面，只查两个零成本信号——① 这个 Chrome 是不是用我们自己的 user-data-dir 起的；
// ② 现有 tab 里有没有豆包域名的页。命中任一即我们的实例，直接放行（页面加载慢交给后面的 goto 重试）。
// 只有"既非我们的 profile、又一个豆包 tab 都没有"（典型的别人占端口的隐形空壳）才判连错、才重启。
const OUR_PROFILE = `${process.env.HOME}/.chrome-automation`;
async function isOurInstance() {
  // ① 现有 tab 命中豆包域名 → 一定是能干活的实例
  if (ctx.pages().some(pg => /doubao\.com/i.test(pg.url()))) return true;
  // ② 查 /json/version 的 userDataDir 是否为我们的 profile（拿不到就跳过此判据）
  try {
    const r = await fetch(CDP.replace(/\/$/, "") + "/json/version", { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    const udd = String(j["userDataDir"] || j["User Data Dir"] || "");
    if (udd && udd.includes(".chrome-automation")) return true;
  } catch {}
  return false;
}
if (!(await isOurInstance())) {
  const { execSync } = await import("node:child_process");
  let others = 0;
  try { others = parseInt(execSync(`pgrep -f doubao-gen.mjs | wc -l`).toString().trim(), 10) - 1; } catch {}
  if (others > 0) {
    console.error(`连到的实例不是按图生自己的（无豆包 tab、非本 profile），但有 ${others} 个其他 doubao-gen 进程在跑 — 拒绝 pkill 共享 Chrome。等其他任务结束后重试。`);
    process.exit(5);
  }
  log("  ⚠ 连到的实例不是按图生自己的（无豆包 tab、非 ~/.chrome-automation profile）— 杀掉重启【有头/可见】Chrome");
  try { execSync(`pkill -f "remote-debugging-port=${DEBUG_PORT}"`); } catch {}
  await new Promise(r => setTimeout(r, 2000));
  await ensureChromeOnCDP(CDP);
  browser = await connectWithSelfHeal(CDP);
  [ctx] = browser.contexts();
  // 重启后不再校验（ensureChromeOnCDP 是我们亲手用自己 profile 起的，必然是我们的实例）
}

// === tab 认领制（v6.3.0，多会话并行安全）===
// 病根：旧逻辑复用/关闭"任何 doubao tab"——两个 cc 会话并行时，后启动的会抢占
// （给别人正生成的对话贴图输入）甚至关闭前一个会话的 tab。
// 修法：豆包对话发出首条消息后 URL 变成唯一的 /chat/<会话id>；每轮跑完把本任务
// 各 tag 的对话 URL 登记进 TEMP_DIR/tabs.json。复用只认自己任务登记过的 URL，
// 其他 doubao tab 一律不碰、永不关闭。
// 代价：首轮不再白捡陌生 doubao tab（旧"省 8-12s"优化仅在同任务迭代轮保留）。
const TABS_FILE = `${TEMP_DIR}/tabs.json`;
const ownedTabs = (() => {
  try { return JSON.parse(readFileSync(TABS_FILE, "utf8")); } catch { return {}; }
})();
const findOwnedPage = (key) => {
  const url = ownedTabs[key];
  if (!url) return null;
  return ctx.pages().find(pg => pg.url().split("?")[0] === String(url).split("?")[0]) ?? null;
};
const openFreshDoubaoTab = async (label) => {
  const p = await ctx.newPage();
  log(`  ${label} goto doubao.com/chat (new tab)`);
  await p.goto("https://www.doubao.com/chat/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (/login|signin|登录/i.test(p.url())) {
    console.error("sign-in required — open Chrome and log in, then re-run");
    process.exit(4);
  }
  return p;
};

let pages = [];
if (MODE === "single") {
  let p = findOwnedPage("single");
  if (p) {
    log("reusing owned doubao tab:", p.url());
    await p.bringToFront().catch(() => {});
  } else {
    p = await openFreshDoubaoTab("");
  }
  pages.push(p);
} else {
  // 双 tab：只复用本任务 tabs.json 登记过的 tab，不够开新的
  // 串行处理：避免两个 React app 同时初始化时的资源争抢（之前并行 goto 时 A 经常 15s 内 textarea 没出现）
  log("opening 2 doubao tabs for parallel generation (only reuse tabs owned by this task)");

  for (let i = 0; i < 2; i++) {
    const tag = i === 0 ? "A" : "B";
    let p = findOwnedPage(tag);
    let isReused = p !== null;

    if (isReused) {
      log(`  [${tag}] reusing owned doubao tab: ${p.url()}`);
    } else {
      p = await openFreshDoubaoTab(`[${tag}]`);
    }

    // 等 textarea ready（复用的 tab 通常立即 ready；新 tab 等 React 初始化）
    // 注意必须用 waitFor：isVisible({timeout}) 的 timeout 被 playwright 忽略、立即返回 false（v8.x 长期误用导致新 tab 秒判失败 exit 5）
    log(`  [${tag}] waiting for textarea to be ready`);
    const inputReady = await p.locator(INPUT_SEL).first()
      .waitFor({ state: "visible", timeout: 45_000 }).then(() => true).catch(() => false);
    if (!inputReady) {
      console.error(`[${tag}] textarea did not appear within 45s${isReused ? " (reused tab may be in odd state)" : ""}`);
      process.exit(5);
    }
    log(`  [${tag}] textarea ready${isReused ? " (reused)" : ""}`);
    pages.push(p);
  }
}

// v8.3.2：关掉启动时那个"占位空首页"tab。
// 病根：为保证有头可见，启动 Chrome 时用 `--new-window https://www.doubao.com/chat/` 开了个首页 tab，
// 但它不参与生成（干活的是上面认领/新开的 A、B tab），停在首页白占一格，用户嫌"多开了一个杂的空首页"。
// 修法：干活 tab 备齐后，关掉所有"不在 pages 里、且 URL 仍停在豆包首页（chat/ 结尾无会话 id）"的 tab。
// 判据收紧到"精确等于首页"——进入对话的 URL 是 /chat/<id>，手动开的别的豆包对话 tab 不会被误关。
const isDoubaoHome = (u) => /^https?:\/\/(www\.)?doubao\.com\/chat\/?$/i.test(u.split(/[?#]/)[0]);
for (const pg of ctx.pages()) {
  if (pages.includes(pg)) continue;              // 干活 tab，跳过
  if (isDoubaoHome(pg.url())) {
    log(`  关闭占位空首页 tab: ${pg.url()}`);
    await pg.close().catch(() => {});
  }
}

// === runOneTab: 在指定 page 上执行完整生成 + 下载流程 ===
async function runOneTab(page, { tag, complexity, text: PROMPT }) {
  await shot(page, tag, "01-start");

  // Focus the input box
  // 双 tab 模式下页面已在主流程 pre-init 阶段等过 textarea ready，正常应即时可见
  // 仍保留 30s timeout 兜底（拉长以适应资源争抢偶发卡顿）
  tlog(tag, "waiting for input box");
  const inputBox = page.locator(INPUT_SEL).first();
  if (!(await inputBox.waitFor({ state: "visible", timeout: 30_000 }).then(() => true).catch(() => false))) {
    throw new Error(`[${tag}] input box not found`);
  }
  await inputBox.click();

  // Upload reference image
  tlog(tag, `uploading ${REF}`);
  let fileInput = page.locator('input[type="file"][accept*=".png"]').first();
  let fileInputCount = await fileInput.count();
  if (fileInputCount === 0) {
    tlog(tag, "  file input not in DOM, locating + button");
    const taBox = await inputBox.boundingBox();
    if (!taBox) throw new Error(`[${tag}] input box has no bounding box`);

    // 找 + 按钮坐标的辅助函数（避免拿 ElementHandle 后 React 重渲染导致 detached）
    const findPlusBtnCoord = async () =>
      page.evaluate(({ taX, taY, taW, taH }) => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          if (!btn.querySelector("svg")) continue;
          if ((btn.textContent || "").trim().length > 0) continue;
          const r = btn.getBoundingClientRect();
          if (r.width < 30 || r.width > 44 || r.height < 30 || r.height > 44) continue;
          if (Math.abs(r.y + r.height / 2 - (taY + taH + 18)) > 50) continue;
          if (r.x >= taX) continue;
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        return null;
      }, { taX: taBox.x, taY: taBox.y, taW: taBox.width, taH: taBox.height });

    // 整体重试：点 + 按钮 → poll file input；如果 popper 没出来（可能被另一 tab 干扰
    // 关掉 / 点击没触发 React state 更新），重新点 + 按钮再试
    // 最多 5 次尝试，每次包含一次 click + 最多 2s poll
    let success = false;
    for (let attempt = 0; attempt < 5 && !success; attempt++) {
      const coord = await findPlusBtnCoord();
      if (!coord) {
        tlog(tag, `  + button coord not found, waiting (attempt ${attempt + 1}/5)`);
        await page.waitForTimeout(800);
        continue;
      }

      // 注意：不需要 bringToFront —— playwright mouse 是 CDP 级，不依赖系统焦点
      await page.mouse.move(coord.x, coord.y);
      await page.waitForTimeout(80);
      await page.mouse.click(coord.x, coord.y);
      tlog(tag, `  clicked + button at (${coord.x.toFixed(0)},${coord.y.toFixed(0)}) attempt=${attempt + 1}`);

      // poll file input 出现（最多 2s）
      const pollStart = Date.now();
      while (Date.now() - pollStart < 2000) {
        await page.waitForTimeout(200);
        fileInput = page.locator('input[type="file"][accept*=".png"]').first();
        fileInputCount = await fileInput.count();
        if (fileInputCount > 0) { success = true; break; }
      }
      if (!success) {
        tlog(tag, `  file input not appeared after click, will retry`);
      }
    }
    if (!success) {
      throw new Error(`[${tag}] file input not in DOM after 5 click attempts`);
    }
  }
  await fileInput.setInputFiles(REF, { timeout: 15_000 });

  // Wait for thumbnail
  tlog(tag, "waiting for thumbnail");
  const thumbStart = Date.now();
  let thumbSeen = false;
  while (Date.now() - thumbStart < 60_000) {
    thumbSeen = await page.evaluate(() => {
      const imgs = document.querySelectorAll("img");
      for (const img of imgs) {
        if (!img.complete || img.naturalWidth < 30) continue;
        const rect = img.getBoundingClientRect();
        if (rect.width < 40 || rect.width > 150) continue;
        if (rect.height < 40 || rect.height > 150) continue;
        if (rect.bottom < window.innerHeight * 0.5) continue;
        return true;
      }
      return false;
    });
    if (thumbSeen) { tlog(tag, "  thumbnail detected"); break; }
    await page.waitForTimeout(1000);
  }
  if (!thumbSeen) {
    throw new Error(`[${tag}] thumbnail never appeared`);
  }
  await page.waitForTimeout(1500);
  await shot(page, tag, "02-uploaded");

  // Fill prompt
  tlog(tag, "filling prompt");
  await inputBox.click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.keyboard.press("Delete").catch(() => {});
  const promptLines = PROMPT.split("\n");
  for (let i = 0; i < promptLines.length; i++) {
    if (promptLines[i].length > 0) {
      await page.keyboard.type(promptLines[i], { delay: 0 });
    }
    if (i < promptLines.length - 1) {
      await page.keyboard.press("Shift+Enter");
    }
  }
  await page.waitForTimeout(500);
  await shot(page, tag, "03-prompt");

  // Click 图像生成 if visible
  tlog(tag, "checking for 图像生成 button");
  const imgGenBtn = page.getByRole("button", { name: /图像生成|图片生成|生成图/ }).first();
  if (await imgGenBtn.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false)) {
    await imgGenBtn.click();
    await page.waitForTimeout(1000);
    tlog(tag, "  clicked 图像生成");
  } else {
    tlog(tag, "  not found (already in image mode)");
  }

  // Snapshot existing images
  const existingUrls = await page.evaluate(() => {
    const urls = [];
    for (const el of document.querySelectorAll("img")) {
      const src = el.src || "";
      if (!/^https?:|^blob:/.test(src)) continue;
      if (el.naturalWidth >= 200) urls.push(src);
    }
    return urls;
  });
  tlog(tag, `existing images: ${existingUrls.length}`);

  // Submit
  tlog(tag, "submitting");
  let submitBtn = page.locator('button[type="submit"]').last();
  if (!(await submitBtn.waitFor({ state: "visible", timeout: 2000 }).then(() => true).catch(() => false))) {
    submitBtn = page.locator('button').filter({ hasText: /发送|提交|submit/i }).last();
  }
  if (!(await submitBtn.waitFor({ state: "visible", timeout: 2000 }).then(() => true).catch(() => false))) {
    submitBtn = page.locator('button').last();
  }
  if (!(await submitBtn.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false))) {
    throw new Error(`[${tag}] submit button not found`);
  }
  await submitBtn.click();
  await shot(page, tag, "04-submitted");

  // Wait for new images
  // 内部检测窗口 GEN_WAIT_MS（B 档 700 字 JSON 推理 + 排队常 >45s，拉长到 150s）；
  // 外层 page.evaluate 的 timeout 必须 > 内层窗口，否则 Playwright 默认 30s 会把内部 promise 腰斩
  // （历史 bug：内部想等 45s，但外层 evaluate 30s 先抛 "page.evaluate: Error: timeout"，出图了也判 0 图）。
  const GEN_WAIT_MS = 150_000;
  tlog(tag, `waiting for new images (up to ${Math.round(GEN_WAIT_MS / 1000)}s)`);
  const evalResult = await page.evaluate(({ existing, waitMs }) => {
    return new Promise((resolve) => {
      const ex = new Set(existing);
      const results = [];
      const watched = new WeakSet();
      const rejects = {};   // 诊断：记录 rc_gen_image 图各自被哪个条件拒掉
      let done = false;

      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timeoutHandle);
        clearInterval(pollHandle);
        try { observer.disconnect(); } catch {}
        // 统一 resolve（不再 reject）：带回 results + 诊断，外层据 ok 判超时
        resolve({ ok, results, rejects });
      };

      const timeoutHandle = setTimeout(() => finish(false), waitMs);

      // 白名单：识别豆包生成图 src
      // **只匹配 rc_gen_image 路径段**（+ blob:，部分场景用 blob URL 渲染生成图）——这是豆包生成图的稳定标识。
      // ⚠️ 绝不放宽到 byteimg/byteacctimg/tos- 等泛 CDN：豆包给用户上传的**参考图**也走这些 CDN，
      //    放宽会把参考图缩略错当生成图（实测回归：曾把 1209×330 参考图本身当"成品"下载）。参考图永不含 rc_gen_image。
      const isGenSrc = (src) =>
        (/rc_gen_image/i.test(src) || src.startsWith("blob:"))
        && /^https?:|^blob:/.test(src);

      const note = (src, reason) => {
        const k = src.slice(0, 70);
        rejects[k] = reason;
      };

      const tryRecord = (el) => {
        if (done) return;
        const src = el.src || "";
        if (!isGenSrc(src)) return;
        if (ex.has(src)) return note(src, "in-baseline");   // 已在基线里 = 生成前就有 = 不是新图
        if (!el.complete) return note(src, "not-complete");
        // 尺寸下限按 src 类型分档（v8.4.2 修，实测竖版图翻车）：
        //   豆包缩略图**高度固定 384、宽度随长宽比缩放**——竖版图（如 736×1308）缩略后是 216×384。
        //   旧阈值 256 是按当年横版/方版缩略宽度（~289×384）定的，遇竖版必然误杀，且它**不会自己长大**
        //   （实测观测 170s 无一次 naturalWidth 变化），等再久也没用 → 100% 复现的假失败。
        //   分档依据：rc_gen_image 路径段是**参考图永不具备**的可靠锚（见 isGenSrc 注释），
        //   既然已通过该白名单，尺寸阈值只剩「防 loading 占位小图标」这一个作用 → 降到 150 足够；
        //   blob: 没有这层保证（参考图上传预览就是 blob），仍保持 256 兜底。
        const minW = /rc_gen_image/i.test(src) ? 150 : 256;
        if (el.naturalWidth < minW) return note(src, `naturalW<${minW}(=${el.naturalWidth})`);
        // rect 门槛本意排除小图标/占位符，但横向 banner 缩略渲染高度可低至 ~99px（宽够高不够），
        // 旧的 width<100||height<100 会误伤（实测：真生成图 rect 361×99，height 差 1px 被拒、白等 150s）。
        // 改为「较长边 ≥ 100 且较短边 ≥ 60」——既排除真正的小图标（两边都小），又放行宽扁 banner。
        const rect = el.getBoundingClientRect();
        const longSide = Math.max(rect.width, rect.height);
        const shortSide = Math.min(rect.width, rect.height);
        if (longSide < 100 || shortSide < 60) return note(src, `rect-too-small(${Math.round(rect.width)}×${Math.round(rect.height)})`);
        if (results.some(r => r.src === src)) return;
        results.push({ src, w: el.naturalWidth, h: el.naturalHeight });
        delete rejects[src.slice(0, 70)];
        if (results.length >= 1) finish(true);
      };

      const checkImages = () => {
        for (const el of document.querySelectorAll("img")) {
          const src = el.src || "";
          if (!isGenSrc(src)) continue;
          if (el.loading === "lazy") el.loading = "eager";
          tryRecord(el);
          if (!watched.has(el) && (!el.complete || el.naturalWidth < (/rc_gen_image/i.test(src) ? 150 : 256))) {
            watched.add(el);
            el.addEventListener("load", () => tryRecord(el), { once: true });
          }
        }
      };

      const observer = new MutationObserver(checkImages);
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src']
      });
      const pollHandle = setInterval(checkImages, 1500);
      checkImages();
    });
  }, { existing: existingUrls, waitMs: GEN_WAIT_MS },
  ).catch(err => {
    tlog(tag, `  observer evaluate error: ${err.message}`);
    return { ok: false, results: [], rejects: {} };
  });
  const images = (evalResult && evalResult.results) || [];
  if (evalResult && !evalResult.ok) {
    tlog(tag, `  observer timeout (no image recorded in ${Math.round(GEN_WAIT_MS/1000)}s)`);
    const rj = evalResult.rejects || {};
    const rjKeys = Object.keys(rj);
    if (rjKeys.length) {
      tlog(tag, `  observer saw ${rjKeys.length} rc_gen_image(s) but rejected: ${JSON.stringify(rjKeys.map(k => `${rj[k]} :: ${k.slice(-40)}`))}`);
    } else {
      tlog(tag, `  observer saw NO rc_gen_image at all during window (生成图 src 可能不含 rc_gen_image / 渲染在别的容器)`);
    }
  }

  // 兜底回捞：内层若空手（超时/白名单没命中），退出前对页面做一次"最终快照扫描"——
  // 把当前所有 img 的 src + 尺寸 dump 出来，既能捞到"其实已渲染但没被 observer 记到"的图，
  // 又能在诊断日志里看清到底是"真没出图"还是"出了没抓到"。
  let finalImages = images;
  if (finalImages.length === 0) {
    tlog(tag, `  observer empty — running final rescan for already-rendered images`);
    const snapshot = await page.evaluate((existing) => {
      const ex = new Set(existing);
      const all = [];
      for (const el of document.querySelectorAll("img")) {
        const src = el.src || "";
        if (!/^https?:|^blob:/.test(src)) continue;
        all.push({ src, w: el.naturalWidth, h: el.naturalHeight, complete: el.complete, isNew: !ex.has(src) });
      }
      return all;
    }, existingUrls).catch(() => []);
    // 候选 = 新出现的、够大的、且带生成图稳定标识 rc_gen_image 的图。
    // ⚠️ 只认 rc_gen_image（或 blob:）——绝不放宽到 byteimg/tos- 等泛 CDN：
    //    豆包给用户上传的**参考图**也用 byteimg CDN，放宽会把参考图缩略错当生成图捞回
    //    （实测回归：rescan 曾捞回 1209×330 的参考图本身当"成品"）。参考图永不含 rc_gen_image 路径段，这是唯一可靠的判别锚。
    const rescued = snapshot
      .filter(x => x.isNew && x.complete && x.w >= (/rc_gen_image/i.test(x.src) ? 150 : 256))
      .filter(x => /rc_gen_image/i.test(x.src) || x.src.startsWith("blob:"))
      .sort((a, b) => (b.w * b.h) - (a.w * a.h));
    if (rescued.length > 0) {
      tlog(tag, `  rescued ${rescued.length} image(s) via final rescan (largest ${rescued[0].w}×${rescued[0].h})`);
      finalImages = [{ src: rescued[0].src, w: rescued[0].w, h: rescued[0].h }];
    } else {
      // 诊断：把快照里所有图列进日志，便于事后判断到底是没出图还是白名单漏判
      const diag = snapshot.slice(0, 12).map(x => `${x.w}×${x.h}${x.isNew ? "*" : ""} ${x.src.slice(0, 60)}`);
      tlog(tag, `  rescan found no candidate. page has ${snapshot.length} img(s): ${JSON.stringify(diag)}`);
    }
  }
  const capturedImages = finalImages;

  await shot(page, tag, "05-result");
  tlog(tag, `  captured ${capturedImages.length} images`);
  if (capturedImages.length === 0) {
    throw new Error(`[${tag}] no result images appeared within ${Math.round(GEN_WAIT_MS / 1000)}s`);
  }

  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const imgs = document.querySelectorAll("img");
    if (imgs.length > 0) {
      imgs[imgs.length - 1].scrollIntoView({ behavior: "instant", block: "center" });
    }
  });
  await page.waitForTimeout(1000);

  // ---- Download 2048 hi-res ----
  // 链路设计（V5）：
  //   1. 监听 page.request 收集所有「rc_gen_image + image_dld_watermark」高清 URL
  //   2. 鼠标移到生成图上 → 等悬浮工具条 → 点击下载图标
  //      点击会触发豆包前端去 fetch 一个高清原图 URL（带签名+水印参数），request listener 拦到这个 URL
  //   3. 用 Playwright 的 ctx.request.get(url) 在 Node 端直接 fetch（绕过页面 fetch 的跨域/blob 限制）
  //      可能附带浏览器原生下载（取决于 Content-Disposition），所以同时启动 ~/Downloads 监视
  //   4. 兜底：拿不到高清 URL → 用 thumb URL 落盘（保证不阻塞主流程）
  //   5. 不让浏览器写到 ~/Downloads：点完下载图标 5s 内监视 ~/Downloads，发现新文件就移走
  tlog(tag, `downloading generated image`);

  const fname = tag
    ? `第${ROUND}轮-候选${tag}-${complexity}.png`
    : `评审-第${ROUND}轮.png`;
  const path = join(TEMP_DIR, fname);

  // ---- 高清下载捕获（v8.4.0 重写）----
  // 根因（实战翻车 + 用户截图确认）：豆包右键「下载原图」走的是**浏览器原生下载**，
  // 直接落到 ~/Downloads（截图里 "2.2 MB · 完成"），**不经过 XHR**——所以旧逻辑
  // 监听 page.on("request") 抓 rc_gen_image URL 永远抓不到，30s 空等回落 384 缩略图；
  // 更坑：旧的 cleanupDownloads() 还会把这些原生下载的高清原图当垃圾误删。
  // 正解：监听 page.on("download") 事件 → download.saveAs(path)，Playwright 直接接管
  // 浏览器下载流、落到我们指定路径（不进 ~/Downloads），实测拿到 2048×2048 / 2.2MB 原图。
  //
  // 保留旧的 hiResUrls / onReq 作为**回退兜底**（万一某天豆包又改回 XHR 下载链路）。
  const hiResUrls = [];
  const onReq = (req) => {
    const u = req.url();
    if (/rc_gen_image/.test(u) && /image_dld_watermark/.test(u)) {
      hiResUrls.push(u);
    }
  };
  page.on("request", onReq);

  // download 事件监听：只保留「本函数点击『下载原图』之后」触发的最新一次下载
  let pendingDownload = null;
  const onDownload = (d) => { pendingDownload = d; };
  page.on("download", onDownload);

  const extractIdDl = (url) => {
    const m = String(url).match(/rc_gen_image\/([0-9a-f]+)\.jpeg/i);
    return m ? m[1] : null;
  };
  const targetId = extractIdDl(capturedImages[0].src);

  const rect = await page.evaluate((id) => {
    const re = new RegExp("rc_gen_image\\/" + id + "\\.jpeg", "i");
    const img = [...document.querySelectorAll("img")].find(el => re.test(el.src || ""));
    if (!img) return null;
    img.scrollIntoView({ block: "center", inline: "center" });
    const r = img.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, targetId);

  // 从字节流读图片尺寸（主路径 saveAs 后 + 回退路径落盘后共用；提前定义避免 TDZ）
  const dimFromBuffer = (buf) => {
    // PNG: bytes 16-23 = width/height (big-endian uint32)
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      // JPEG: 扫 SOF marker
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf)) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
    return { w: 0, h: 0 };
  };

  // ~/Downloads 监视前置（用于函数末尾清理）：
  // 浏览器原生下载在 click 后异步触发，PNG 6MB 落盘需 5-7s。
  // 之前清理跑在 click 后 150ms → 文件还没出现 → 清理无效，
  // 导致 ~/Downloads 长期堆积「生成XXX.png」。
  // 修复：在 click 前快照 beforeDownloads，等 fetchViaCtx 落完盘后再 readdir 对比清理。
  const homeDir = process.env.HOME;
  const downloadsDir = `${homeDir}/Downloads`;
  const _fs = await import("node:fs");
  const beforeDownloads = new Set();
  try {
    for (const f of _fs.readdirSync(downloadsDir)) beforeDownloads.add(f);
  } catch {}
  // 抽出清理逻辑：在 IMAGE_DOWNLOADED 之后 + return 之前调用一次
  const cleanupDownloads = async () => {
    // 浏览器原生下载可能比 fetchViaCtx 慢，给 2s 缓冲
    await page.waitForTimeout(2000);
    try {
      const after = _fs.readdirSync(downloadsDir);
      for (const f of after) {
        if (beforeDownloads.has(f)) continue;
        if (!/\.(png|jpe?g)$/i.test(f)) continue;
        const full = `${downloadsDir}/${f}`;
        try {
          const st = _fs.statSync(full);
          // 30s 内创建的（覆盖 fetchViaCtx 拉 6MB 的网络耗时 + 浏览器异步下载）
          if (Date.now() - st.birthtimeMs < 30_000) {
            _fs.unlinkSync(full);
            tlog(tag, `  cleaned ~/Downloads/${f}`);
          }
        } catch {}
      }
    } catch {}
  };

  let capturedUrl = null;
  const before = hiResUrls.length;

  // 等 hi-res URL 出现的小工具：click 触发后轮询 hiResUrls 是否增长（回退路径用）
  const waitHiRes = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && hiResUrls.length === before) {
      await page.waitForTimeout(150);
    }
    return hiResUrls.length > before;
  };
  // 等 download 事件出现的小工具：轮询 pendingDownload 是否被赋值
  const waitDownload = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && !pendingDownload) {
      await page.waitForTimeout(150);
    }
    return pendingDownload;
  };

  // hiResSaved：主路径（download 事件）成功落盘后置为 true，跳过后续所有 URL/thumb 回退
  let hiResSaved = false;
  let triggered = false; // 回退路径（XHR）是否抓到 URL

  // ---- 主路径：右键菜单「下载原图」→ page.on("download") 捕获 → saveAs ----
  // 右键「下载原图」走浏览器原生下载（用户实测截图 "2.2 MB · 完成" 确认），
  // 不经 XHR，必须靠 download 事件接住。实测稳定拿到 2048×2048 原图。
  if (rect) {
    try {
      // 找「下载原图」叶子节点：textContent 精确等于目标词、且无同文本子节点（排除整个菜单容器）
      const findMenu = () => page.evaluate(() => {
        const wants = ["下载原图", "下载高清", "保存原图", "下载图片"];
        const all = [...document.querySelectorAll("li,div,span,button,a,[role='menuitem']")];
        const hits = [];
        for (const el of all) {
          const txt = (el.textContent || "").trim();
          if (!wants.includes(txt)) continue;                    // 精确等于，不用 includes（避免匹配到含多项的容器）
          const hasChildSame = [...el.querySelectorAll("*")].some(c => (c.textContent || "").trim() === txt);
          if (hasChildSame) continue;                            // 有更内层同文本子节点 → 自己是容器，跳过
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4 || r.x < 0 || r.y < 0) continue;
          hits.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, txt, area: r.width * r.height });
        }
        if (!hits.length) return null;
        hits.sort((a, b) => a.area - b.area);                    // 取最小面积叶子（最贴近文字）
        return hits[0];
      });

      // 右键唤菜单，最多重试 3 次（菜单偶尔不弹）
      let menuCoord = null;
      for (let attempt = 1; attempt <= 3 && !menuCoord; attempt++) {
        await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
        await page.waitForTimeout(400);
        await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2, { button: "right" });
        await page.waitForTimeout(700);
        menuCoord = await findMenu();
        if (!menuCoord) {
          tlog(tag, `  右键尝试 ${attempt} 未见「下载原图」菜单，重试`);
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(300);
        }
      }

      if (menuCoord) {
        pendingDownload = null;                                  // 清掉任何早于本次点击的下载
        await page.mouse.click(menuCoord.x, menuCoord.y);
        tlog(tag, `  右键菜单命中「${menuCoord.txt}」`);
        const dl = await waitDownload(30_000);
        if (dl) {
          try {
            await dl.saveAs(path);
            const buf = readFileSync(path);
            const dim = dimFromBuffer(buf);
            hiResSaved = true;
            tlog(tag, `  ${path} (${buf.length} bytes, ${dim.w}×${dim.h} — 下载原图)`);
          } catch (e) {
            tlog(tag, `  download.saveAs 失败 (${e.message})，回退 XHR/thumb`);
          }
        } else {
          tlog(tag, `  「下载原图」点了但 30s 内没等到 download 事件，回退 XHR/thumb`);
        }
      } else {
        tlog(tag, `  右键 3 次都没找到「下载原图」项，回退悬停工具条`);
      }
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(200);
    } catch (e) {
      tlog(tag, `  右键下载原图路径异常 (${e.message})，回退悬停工具条`);
    }
  }

  // ---- 回退路径（仅当主路径没落盘）：悬停工具条 SVG → 抓 XHR hi-res URL ----
  if (!hiResSaved && !triggered && rect) {
    await page.mouse.move(rect.x + rect.w / 2, rect.y + rect.h / 2);
    await page.waitForTimeout(1200);

    const dlCoord = await page.evaluate((thumbRect) => {
      let best = null;
      for (const svg of document.querySelectorAll("svg")) {
        const r = svg.getBoundingClientRect();
        if (r.width < 12 || r.width > 24 || r.height < 12 || r.height > 24) continue;
        if (r.x < thumbRect.x - 5 || r.x > thumbRect.x + thumbRect.w + 5) continue;
        if (r.y < thumbRect.y || r.y > thumbRect.y + thumbRect.h + 5) continue;
        if (!best || r.x > best.x) best = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return best;
    }, rect);

    if (dlCoord) {
      await page.mouse.click(dlCoord.x, dlCoord.y);
      triggered = await waitHiRes(30_000);
      if (triggered) {
        capturedUrl = hiResUrls.find(u => u.includes(targetId)) || hiResUrls[before];
        tlog(tag, `  hi-res URL captured (via 悬停工具条)`);
      } else {
        tlog(tag, `  no hi-res URL captured within 30s, falling back to thumb URL`);
      }
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
    } else {
      tlog(tag, `  download icon not found, falling back to thumb URL`);
    }
  } else if (!rect) {
    tlog(tag, `  thumb not found in DOM, falling back to thumb URL`);
  }
  page.off("request", onReq);
  page.off("download", onDownload);

  // 用 Playwright Node 端 HTTP client 直接 fetch（绕过页面 fetch 的跨域/CSP）
  // 拿到的就是原始字节流，含完整高清像素
  const fetchViaCtx = async (url) => {
    const r = await ctx.request.get(url, { timeout: 120_000 });
    if (!r.ok()) throw new Error(`HTTP ${r.status()}`);
    const buf = await r.body();
    return buf;
  };

  // 主路径（右键下载原图 → download 事件 saveAs）已落盘 → 直接返回，不走任何回退
  if (hiResSaved) {
    const buf = readFileSync(path);
    const dim = dimFromBuffer(buf);
    return { tag, complexity, path, isHi: true, dim, url: page.url() };
  }

  // 优先用高清 URL；fetch 失败则回落 thumb URL
  if (capturedUrl) {
    try {
      const buf = await fetchViaCtx(capturedUrl);
      const dim = dimFromBuffer(buf);
      writeFileSync(path, buf);
      tlog(tag, `  ${path} (${buf.length} bytes, ${dim.w}×${dim.h})`);
      await cleanupDownloads();
      return { tag, complexity, path, isHi: true, dim, url: page.url() };
    } catch (e) {
      tlog(tag, `  hi-res fetch failed (${e.message}), falling back to thumb URL`);
    }
  }

  // Fallback: thumb URL
  try {
    const buf = await fetchViaCtx(capturedImages[0].src);
    const dim = dimFromBuffer(buf);
    writeFileSync(path, buf);
    tlog(tag, `  ${path} (${buf.length} bytes, ${dim.w}×${dim.h} — thumb fallback)`);
    await cleanupDownloads();
    return { tag, complexity, path, isHi: false, dim, url: page.url() };
  } catch (e) {
    await cleanupDownloads();  // 失败也清理（避免脏文件残留）
    throw new Error(`[${tag}] save failed (hi-res + thumb both failed): ${e.message}`);
  }
}

// === runOneTabWithRetry: 失败时新开一个 tab 用同一份 prompt 再跑一次 ===
// 触发场景：豆包 150s（GEN_WAIT_MS）没出图、且退出前的最终回捞扫描也没捞到（最常见原因是页面状态崩了 / 请求被服务端丢了）
// 重试策略：开新 tab、走完整的 textarea-ready → upload → prompt → submit → wait 流程
// 只重试 1 次（不无限循环），重试还失败就如实上抛
async function runOneTabWithRetry(page, prompt) {
  try {
    return await runOneTab(page, prompt);
  } catch (e) {
    const tag = prompt.tag;
    tlog(tag, `第一次失败 (${e.message})，新开 tab 重试`);
    let retryPage;
    try {
      retryPage = await ctx.newPage();
      tlog(tag, "  retry: goto doubao.com/chat (new tab)");
      await retryPage.goto("https://www.doubao.com/chat/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      if (/login|signin|登录/i.test(retryPage.url())) {
        throw new Error("sign-in required during retry");
      }
      tlog(tag, "  retry: waiting for textarea to be ready");
      const inputReady = await retryPage.locator(INPUT_SEL).first()
        .waitFor({ state: "visible", timeout: 45_000 }).then(() => true).catch(() => false);
      if (!inputReady) throw new Error("retry tab textarea did not appear within 45s");
      tlog(tag, "  retry: textarea ready");
      return await runOneTab(retryPage, prompt);
    } catch (e2) {
      throw new Error(`${e.message}; retry also failed: ${e2.message}`);
    }
  }
}

// === 并行 / 串行 跑所有 tab ===
let results = [];
let errors = [];
if (MODE === "dual") {
  log("running 2 tabs in parallel");
  const settled = await Promise.allSettled([
    runOneTabWithRetry(pages[0], PROMPTS[0]),
    runOneTabWithRetry(pages[1], PROMPTS[1]),
  ]);
  for (const s of settled) {
    if (s.status === "fulfilled") results.push(s.value);
    else errors.push(s.reason?.message ?? String(s.reason));
  }
} else {
  try {
    results.push(await runOneTabWithRetry(pages[0], PROMPTS[0]));
  } catch (e) {
    errors.push(e.message);
  }
}

if (results.length === 0) {
  console.error("all tabs failed:");
  for (const e of errors) console.error("  - " + e);
  process.exit(8);
}
if (errors.length > 0) {
  log(`warning: ${errors.length} tab(s) failed:`);
  for (const e of errors) log(`  - ${e}`);
}

log(`done — ${results.length} image(s) saved to ${TEMP_DIR}`);

// 登记本任务的 tab 归属（v6.3.0 tab 认领制）：下一轮只复用这里登记的对话 URL
try {
  const staleUrls = [];
  for (const r of results) {
    const key = MODE === "single" ? "single" : r.tag;
    if (r.url && r.url.includes("doubao.com")) {
      const newUrl = r.url.split("?")[0];
      const oldUrl = ownedTabs[key] ? String(ownedTabs[key]).split("?")[0] : null;
      if (oldUrl && oldUrl !== newUrl) staleUrls.push(oldUrl);
      ownedTabs[key] = newUrl;
    }
  }
  // v6.3.1 防孤儿 tab 累积：换绑后关闭本任务遗留的旧自有 tab
  // （只关自己 tabs.json 登记过的——别人任务的 tab 依旧永不碰）
  const currentUrls = new Set(Object.values(ownedTabs).map(u => String(u).split("?")[0]));
  for (const oldUrl of staleUrls) {
    if (currentUrls.has(oldUrl)) continue;
    const stalePage = ctx.pages().find(pg => pg.url().split("?")[0] === oldUrl);
    if (stalePage) {
      await stalePage.close().catch(() => {});
      log(`closed stale owned tab: ${oldUrl}`);
    }
  }
  writeFileSync(TABS_FILE, JSON.stringify(ownedTabs, null, 2));
  log(`tab ownership saved to ${TABS_FILE}`);
} catch (e) {
  log(`warning: failed to save tabs.json (${e.message}) — 下一轮将开新 tab，不影响本轮结果`);
}

// === Handoff JSON ===
// V5.0：不再调用 picker 浮窗。
//   - 双 tab 成功生成 2 张 → main_pick_winner（主流程并行 Read 3 张图 + 宏观挑 winner）
//   - 双 tab 只成功 1 张 → main_pick_winner（主流程直接把这张当 winner，无需挑）
//   - 单 tab + auto-review → main_pick_winner（同上）
//   - 没有 auto-review → await_user
const candidates = results.map(r => ({
  tag: r.tag,
  complexity: r.complexity,
  path: r.path,
}));

let nextAction = "await_user";
let pickPayload = null;

if (AUTO_REVIEW) {
  nextAction = "main_pick_winner";
  pickPayload = {
    ref_path: REF,
    orig_ref_path: ORIG_REF,
    candidates,
    theme: THEME,
    round: ROUND,
    temp_dir: TEMP_DIR,
    note: candidates.length >= 2
      ? "V5.0 主流程自主挑 winner：同回合内并行 Read 3 张图（orig_ref + A + B），按「风格贴合 + 主体形态 + 主题贴合 + 整体观感」宏观综合评判，强制输出两张观察 + winner + 一句话原因。挑完 rm 落选 + mv winner → 第N轮-winner.png，再 invoke 按图生-评审。"
      : "仅 1 张候选，直接当 winner 送评审。",
  };
}

// === Output ===
const handoff = {
  status: results.length === PROMPTS.length ? "generated" : "partial",
  mode: MODE,
  candidates,
  errors,
  temp_dir: TEMP_DIR,
  task_id: TASK_ID,
  round: ROUND,
  next_action: nextAction,
  pick_payload: pickPayload,
  original_ref_path: ORIG_REF,
};

console.log("\n" + JSON.stringify(handoff, null, 2));

if (AUTO_REVIEW) {
  if (nextAction === "main_pick_winner") {
    console.log("\nMAIN_PICK_WINNER: 主流程接管挑 winner（V5.0 全自动路径）");
    console.log(`  candidates=${candidates.map(c => c.path).join(",")}`);
    console.log(`  orig_ref=${ORIG_REF}`);
    console.log(`  ref=${REF}`);
    console.log(`  temp_dir=${TEMP_DIR}`);
    console.log(`  theme=${THEME}`);
    console.log(`  round=${ROUND}`);
  } else if (nextAction === "await_user") {
    console.log("\nAWAIT_USER: --auto-review 未启用");
  }
}

await browser.close().catch(() => {});
