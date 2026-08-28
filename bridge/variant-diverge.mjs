#!/usr/bin/env node
/**
 * 妙想「发散」· Variant 自动化投递
 *
 * 用法：node variant-diverge.mjs <图片绝对路径> <提示词>
 * 退出码：0 成功；非 0 失败（stderr 有原因）
 *
 * 流程（对应用户描述的七步）：
 *   连上专属调试端口的 Chrome → 开 variant.com/community → 点 + 号
 *   → 用 filechooser 直接 setFiles（等价于系统选择器选文件+打开，但稳定得多）
 *   → 等输入框出现图片缩略图 → focus 输入区 → 键入提示词 → 回车提交
 *
 * 端口/profile 独立于按图生（豆包用 9333），避免互抢：见 DEBUG_PORT。
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

const IMG = process.argv[2];
const PROMPT = process.argv[3] || "帮我优化一下这个地方";
const URL_TARGET = "https://variant.com/community";
const DEBUG_PORT = Number(process.env.VARIANT_DEBUG_PORT || 9334);
const PROFILE = process.env.VARIANT_PROFILE
  || join(homedir(), ".liaison-variant-profile");
const HEADLESS_TIMEOUT = 45_000;
// 缩略图出现后再等多久才回车：预览是本地 blob 立刻渲染的，真正上传还在后台，
// 太早提交附件会被当成未就绪而丢掉。可用 VARIANT_SETTLE_MS 覆盖。
const SETTLE_MS = Number(process.env.VARIANT_SETTLE_MS || 3000);

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

if (!IMG || !existsSync(IMG)) die(`找不到截图文件：${IMG}`, 2);

// playwright-core 复用按图生 skill 已装好的那份，避免重复安装 11MB
const PW_CANDIDATES = [
  join(homedir(), ".claude/skills/按图生/node_modules/playwright-core/index.js"),
  join(homedir(), ".claude/skills/按图生/node_modules/playwright-core"),
];
let chromium = null;
for (const p of PW_CANDIDATES) {
  try {
    const require0 = createRequire(import.meta.url);
    ({ chromium } = require0(p));
    if (chromium) break;
  } catch (_) {}
}
if (!chromium) {
  // 面向最终用户的自救指引：这类缺失几乎都是安装时 npm 装依赖失败（网络），
  // 重跑一次更新程序即可补装，不该让用户去研究 node_modules 是什么。
  die("运行环境缺少组件（依赖未装好，通常是安装时网络不稳）。\n" +
      "修复：终端执行 bash ~/.miaoxiang/update.command 后重试。", 3);
}

// Chrome 可执行文件：按平台探测，允许环境变量覆盖
const chromePath = () => {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cands = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ];
  return cands.find((p) => existsSync(p)) || null;
};

const wsEndpoint = async () => {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const j = await res.json();
  return j.webSocketDebuggerUrl;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 各步耗时打点，走 stderr（stdout 要留给结果 JSON）。
// server.mjs 会把 stderr 一起写进 log/diverge-*.log，慢在哪一步一目了然。
const T0 = Date.now();
const step = (label, t0) =>
  console.error(`[t+${String(Date.now() - T0).padStart(6)}ms] ${label} 用时 ${Date.now() - t0}ms`);

async function ensureBrowser() {
  // 已有实例就直接连
  try { return await chromium.connectOverCDP(await wsEndpoint()); } catch (_) {}

  const exe = chromePath();
  if (!exe) die("找不到 Chrome，可用 CHROME_PATH 环境变量指定。", 4);
  try { mkdirSync(PROFILE, { recursive: true }); } catch (_) {}

  spawn(exe, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { detached: true, stdio: "ignore" }).unref();

  // 等调试端口起来
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(400);
    try { return await chromium.connectOverCDP(await wsEndpoint()); } catch (_) {}
  }
  die("Chrome 调试端口起不来，请手动关掉已有的 Variant 调试窗口后重试。", 5);
}

(async () => {
  const tB = Date.now();
  const browser = await ensureBrowser();
  step("⓪ 连上浏览器", tB);
  const ctx = browser.contexts()[0];
  if (!ctx) die("没有可用的浏览器上下文", 6);

  // 复用已在 variant 的页面，否则新开
  const pages = ctx.pages();
  let page = pages.find((p) => (p.url() || "").includes("variant.com"))
    || pages.find((p) => /^(about:blank|chrome:\/\/newtab)/.test(p.url() || ""))
    || pages[0];
  if (!page) {
    page = await ctx.newPage();
    await page.goto(URL_TARGET, { waitUntil: "domcontentloaded", timeout: HEADLESS_TIMEOUT });
  } else {
    await page.bringToFront();
    if (!(page.url() || "").includes("/community")) {
      await page.goto(URL_TARGET, { waitUntil: "domcontentloaded", timeout: HEADLESS_TIMEOUT });
    }
  }

  // 单 tab 语义：除工作 tab 外的空白页一律关掉（历史遗留的多余 tab 也一并清理）
  for (const p of pages) {
    if (p === page) continue;
    if (/^(about:blank|chrome:\/\/newtab)/.test(p.url() || "")) {
      try { await p.close(); } catch (_) {}
    }
  }

  step("⓪ 页面就绪", tB);

  // 未登录检测：community 会跳登录页
  await sleep(1200);
  const url = page.url() || "";
  if (/login|signin|auth/i.test(url)) {
    die("Variant 未登录。请在弹出的浏览器窗口里登录一次，之后会记住登录态。", 7);
  }

  // 上传预览的硬指标：<img src> 是 blob:/data: 开头。
  // 不依赖 class 命名（Variant 是混淆类名，猜不准），也不看文本
  //（页面别处常有 xxx.png 字样，会 8ms 误判成上传完成）。
  // 页面既有图片都是 http(s) URL，因此 blob:/data: 计数一涨就是新挂的附件。
  const countBlobImgs = () => page.evaluate(() => {
    const all = [...document.querySelectorAll("img")];
    return all.filter((i) => /^(blob:|data:)/.test(i.src || "")).length;
  }).catch(() => 0);
  const before = await countBlobImgs();

  // ① 投文件。
  //    先试隐藏的 input[type=file]：setInputFiles 不要求元素可见，命中即瞬间完成，
  //    且 Playwright 会自动派发 change 事件，前端上传逻辑照常被触发。
  //    原先是反过来的——先 plus.click()，而 'button:has-text("+")' 这类选择器在
  //    Variant 上常常一个都匹配不到，click() 会一路重试到 15s 超时才走 fallback，
  //    整段流程凭空多出十几秒。现在把稳的那条放前面，点 + 号退为兜底。
  let fed = false;
  const t1 = Date.now();
  try {
    const inp = page.locator('input[type="file"]').first();
    await inp.waitFor({ state: "attached", timeout: 3_000 });
    await inp.setInputFiles(IMG);
    fed = true;
    step("① 直接投 file input", t1);
  } catch (_) {
    step("① file input 未命中，退回点 + 号", t1);
  }

  if (!fed) {
    const t1b = Date.now();
    const plus = page.locator(
      'button:has-text("+"), [aria-label*="attach" i], [aria-label*="upload" i], [data-testid*="attach" i]'
    ).first();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 15_000 }).catch(() => null),
      plus.click({ timeout: 15_000 }).catch(() => null),
    ]);
    if (chooser) await chooser.setFiles(IMG);
    step("① 点 + 号 + filechooser", t1b);
  }

  // ② 等缩略图真的挂进输入框。
  //    原来用 text=/\.(png|jpe?g|webp)$/i 在整页找，页面别处早有同类文本，
  //    8ms 就匹配到无关元素直接放行——图片没传上去也照发。
  //    改用 blob:/data: 图片计数：上传预览必是这两种协议，页面既有图都是 http，
  //    计数一涨就是新挂的附件，不会误判。
  const t2 = Date.now();
  let ok2 = false;
  const deadline2 = Date.now() + 30_000;
  while (Date.now() < deadline2) {
    if ((await countBlobImgs()) > before) { ok2 = true; break; }
    await sleep(250);
  }
  if (!ok2) {
    die("等待图片上传超时：输入框里没出现缩略图（未提交，可重试）。", 8);
  }
  step(`② 缩略图已挂上(基线 ${before})`, t2);

  // ③ 缩略图出现 ≠ 上传完成：前端会先用本地 blob 立刻渲染预览，
  //    真正的上传还在后台跑。此时回车，附件会被当成未就绪而丢掉，
  //    只发出文字——正是「图没发出去」的成因。这里留一段缓冲等它落地。
  const t2b = Date.now();
  await sleep(SETTLE_MS);
  step(`③ 上传落地缓冲 ${SETTLE_MS}ms`, t2b);

  // ④ focus 输入区 → 键入 → 提交
  const t3 = Date.now();
  const input = page.locator(
    'textarea, [contenteditable="true"], input[type="text"]'
  ).last();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.click();
  // 必须用 type 而不是 fill：fill 会先清空目标元素，而 Variant 把附件芯片和
  // 文字放在同一个编辑容器里，清空会把已上传的图片芯片一起抹掉——实测就是
  // 「芯片在，一输入文字就没了」。type 只追加不清空。delay:0 保证不慢。
  await input.type(PROMPT, { delay: 0 });
  await sleep(200);
  // 回车前复核附件还在：输入动作若把芯片挤掉，宁可报错也不要发一条没图的消息
  if ((await countBlobImgs()) <= before) {
    die("输入文字后附件消失了（未提交，可重试）。", 10);
  }
  await input.press("Enter");
  step("④ 输入并提交", t3);

  await sleep(1500);
  console.error(`[总计] ${Date.now() - T0}ms`);
  console.log(JSON.stringify({ ok: true, prompt: PROMPT, image: IMG }));
  // 浏览器窗口留给用户看结果：只断开 CDP 连接，不关窗口
  try { if (typeof browser.disconnect === "function") await browser.disconnect(); } catch (_) {}
  process.exit(0);
})().catch((e) => {
  die(`发散投递失败：${String((e && e.message) || e)}`, 9);
});
