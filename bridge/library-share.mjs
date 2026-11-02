// ============================================================================
// 团队共享灵感库：把 ~/妙想灵感库 作为 git 工作区，与远端（Gitee 私有仓库）同步。
//
// 数据格式沿用本地镜像（一条快照一个 json + 一张图，删除留墓碑），天然适合多人：
// 条目 id 随机不撞名，每人只改自己的条目 → git 几乎不会有内容冲突。
//
// 权限模型（对齐面板「别人的条目只读」）：
//   - 写盘只写作者是自己的条目（别人的条目在扩展里是只读副本，不回写）
//   - 墓碑带作者 id，只有作者本人的删除才生效
//
// 配置（不存在 share.json = 未启用共享，所有接口安静返回 not-configured）：
//   ~/Library/Application Support/miaoxiang/share.json   { remote, user?, branch? }
//   ~/Library/Application Support/miaoxiang/gitee-token  令牌（远端为 https 时用）
// 远端也可以是本地裸仓库路径（开发自测用），此时不需要令牌。
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";

export const CONFIG_DIR = process.env.MIAOXIANG_CONFIG_DIR || join(homedir(), "Library", "Application Support", "miaoxiang");
export const DEFAULT_ROOT = join(homedir(), "妙想灵感库");

const GITIGNORE = [
  ".DS_Store",
  "*.command",
  "liaison-library-*.json",
  ".legacy-tombstones/",
  "",
].join("\n");

// ---- 作者身份（整台机器一个 ID，多个 Chrome profile 共用）------------------
// 没登记飞书时不猜名字（显示名留空，界面显示「同事·ID 前 4 位」）。试过的自动来源
// 都不可靠：公司配发的 Mac 用户名 / 账户全名大多相同（如 iflytek），电脑名可能是
// 上一任使用者留下的（实测作者机就叫「Niki的MacBook Pro」）——重名只是分不清，
// 错名会把条目记到别人头上，更糟。
export function readAuthor({ name } = {}) {
  const file = join(CONFIG_DIR, "author.json");
  let author = null;
  try { author = JSON.parse(readFileSync(file, "utf8")); } catch (_) {}
  let dirty = false;
  if (!author || typeof author.id !== "string" || !author.id) {
    author = { id: randomUUID(), name: "", createdAt: Date.now() };
    dirty = true;
  }
  const n = typeof name === "string" ? name.trim().slice(0, 40) : "";
  if (n && n !== author.name) { author.name = n; dirty = true; }
  if (dirty) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(author, null, 2));
  }
  return author;
}

// ---- 配置 --------------------------------------------------------------------
export function readShareConfig() {
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(join(CONFIG_DIR, "share.json"), "utf8")); } catch (_) { return null; }
  if (!cfg || typeof cfg.remote !== "string" || !cfg.remote) return null;
  let token = "";
  try { token = readFileSync(join(CONFIG_DIR, "gitee-token"), "utf8").trim(); } catch (_) {}
  return { remote: cfg.remote, user: cfg.user || "", branch: cfg.branch || "main", token };
}

// ---- 截图压缩：同步前把大图压小，控制仓库体积 ------------------------------
// 用 macOS 自带 sips，不引入依赖。失败就保留原图（压缩是优化，不是前提）。
// 返回最终文件路径：png/webp 压缩后会变成同名 .jpg（原文件删除）。
const SHOT_MAX_BYTES = 300 * 1024;
export function compressShot(path) {
  const tmp = path + ".tmp.jpg";
  try {
    if (statSync(path).size <= SHOT_MAX_BYTES) return path;
    execFileSync("/usr/bin/sips", ["-Z", "1600", "-s", "format", "jpeg", "-s", "formatOptions", "72", path, "--out", tmp], { stdio: "ignore", timeout: 30000 });
    if (!existsSync(tmp) || statSync(tmp).size >= statSync(path).size) return path;
    const out = path.replace(/\.\w+$/, ".jpg");
    renameSync(tmp, out);
    if (out !== path) unlinkSync(path);
    return out;
  } catch (_) {
    return path;
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch (_) {}
  }
}

// ---- git 基础 ------------------------------------------------------------------
function git(root, args, cfg) {
  const pre = [];
  if (cfg && cfg.token && /^https?:/i.test(cfg.remote)) {
    const basic = Buffer.from(`${cfg.user || "oauth2"}:${cfg.token}`).toString("base64");
    pre.push("-c", `http.extraHeader=Authorization: Basic ${basic}`);
  }
  return new Promise((resolve, reject) => {
    execFile("git", [...pre, "-C", root, ...args], {
      timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ""); reject(err); }
      else resolve(String(stdout || ""));
    });
  });
}
const gitOk = (root, args, cfg) => git(root, args, cfg).then(() => true, () => false);

// 同一个桥进程里串行化所有 git 操作：两个 Chrome 同时触发同步时避免 index.lock 冲突
let chain = Promise.resolve();
function locked(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function ensureRepo(root, cfg, author) {
  mkdirSync(join(root, "snapshots"), { recursive: true });
  mkdirSync(join(root, "tombstones"), { recursive: true });
  const fresh = !existsSync(join(root, ".git"));
  if (fresh) {
    await git(root, ["init", "-b", cfg.branch]);
    // 共享前的旧墓碑没有作者、多数还是误判（另一 Chrome 实例按差集推断的），
    // 不能带进共享库；挪进被忽略的目录留档，不删除。
    const legacy = join(root, ".legacy-tombstones");
    for (const f of readdirSync(join(root, "tombstones"))) {
      if (!f.endsWith(".json")) continue;
      let t = null;
      try { t = JSON.parse(readFileSync(join(root, "tombstones", f), "utf8")); } catch (_) {}
      if (t && t.author) continue;
      mkdirSync(legacy, { recursive: true });
      renameSync(join(root, "tombstones", f), join(legacy, f));
    }
    // 共享前落盘的镜像文件没有作者字段（作者字段是共享功能才加的）。这些文件只可能
    // 由本机扩展写入，记到本机作者名下；否则推上去后别人导入时会因无作者而跳过，
    // 已不在本机库里的那部分更会成为永远没人认领的垃圾。
    for (const f of readdirSync(join(root, "snapshots"))) {
      if (!f.endsWith(".json")) continue;
      const p = join(root, "snapshots", f);
      try {
        const snap = JSON.parse(readFileSync(p, "utf8"));
        if (snap && snap.author && snap.author.id) continue;
        snap.author = { id: author.id, name: author.name || "" };
        writeFileSync(p, JSON.stringify(snap, null, 2));
      } catch (_) {}
    }
  }
  writeFileSync(join(root, ".gitignore"), GITIGNORE);
  await git(root, ["config", "user.name", author.name || "miaoxiang"]);
  await git(root, ["config", "user.email", `${author.id}@miaoxiang.local`]);
  const cur = await git(root, ["remote", "get-url", "origin"]).then((s) => s.trim(), () => "");
  if (!cur) await git(root, ["remote", "add", "origin", cfg.remote]);
  else if (cur !== cfg.remote) await git(root, ["remote", "set-url", "origin", cfg.remote]);
}

function tombstonedIds(root) {
  const ids = new Set();
  try { for (const f of readdirSync(join(root, "tombstones"))) if (f.endsWith(".json")) ids.add(f.slice(0, -5)); } catch (_) {}
  return ids;
}

// 兜底合并：rebase 走不通（无共同历史 / 意外冲突）时，以远端为基、本地文件覆盖其上。
// 工作区里「远端有、本地没有」的文件要从远端恢复——除非本地有对应墓碑（那是真删除）。
async function adoptRemote(root, cfg) {
  const ref = `origin/${cfg.branch}`;
  await git(root, ["reset", "--mixed", ref]);
  const tombs = tombstonedIds(root);
  const missing = (await git(root, ["ls-files", "-d", "-z"])).split("\0").filter(Boolean)
    .filter((p) => { const m = /^snapshots\/(.+)\.\w+$/.exec(p); return !(m && tombs.has(m[1])); });
  for (let i = 0; i < missing.length; i += 200) {
    await git(root, ["checkout", ref, "--", ...missing.slice(i, i + 200)]);
  }
}

async function commitAll(root, message) {
  await git(root, ["add", "-A"]);
  const st = await git(root, ["status", "--porcelain"]);
  if (!st.trim()) return false;
  await git(root, ["commit", "-q", "-m", message]);
  return true;
}

// ---- 一次完整同步 ------------------------------------------------------------
export function shareSync(root = DEFAULT_ROOT) {
  return locked(async () => {
    const cfg = readShareConfig();
    if (!cfg) return { ok: false, notConfigured: true };
    const author = readAuthor();
    await ensureRepo(root, cfg, author);
    const before = await git(root, ["rev-parse", "--verify", "-q", `origin/${cfg.branch}`]).then((s) => s.trim(), () => "");
    const committed = await commitAll(root, `sync: ${author.name || author.id}`);

    for (let attempt = 0; attempt < 3; attempt++) {
      await git(root, ["fetch", "-q", "origin"], cfg);
      const remoteHead = await git(root, ["rev-parse", "--verify", "-q", `origin/${cfg.branch}`]).then((s) => s.trim(), () => "");
      const hasHead = await gitOk(root, ["rev-parse", "--verify", "-q", "HEAD"]);
      if (remoteHead) {
        const related = hasHead && await gitOk(root, ["merge-base", "HEAD", `origin/${cfg.branch}`]);
        // rebase 时 -X theirs = 被重放的本地提交胜出（与 merge 语义相反）
        const rebased = related && await gitOk(root, ["rebase", "-q", "-X", "theirs", `origin/${cfg.branch}`]);
        if (!rebased) {
          if (related) await gitOk(root, ["rebase", "--abort"]);
          await adoptRemote(root, cfg);
          await commitAll(root, `merge: ${author.name || author.id}`);
        }
      }
      if (!await gitOk(root, ["rev-parse", "--verify", "-q", "HEAD"])) {
        return { ok: true, committed: false, pushed: false, pulled: !!remoteHead && remoteHead !== before };
      }
      const ahead = remoteHead
        ? (await git(root, ["rev-list", "--count", `origin/${cfg.branch}..HEAD`])).trim() !== "0"
        : true;
      if (!ahead) return { ok: true, committed, pushed: false, pulled: !!remoteHead && remoteHead !== before };
      if (await gitOk(root, ["push", "-q", "origin", `HEAD:${cfg.branch}`], cfg)) {
        return { ok: true, committed, pushed: true, pulled: !!remoteHead && remoteHead !== before };
      }
      // 被拒（别人刚推过）：下一轮重新 fetch + rebase
    }
    return { ok: false, error: "push rejected after retries" };
  }).catch((e) => ({ ok: false, error: String((e && e.stderr) || (e && e.message) || e).slice(0, 500) }));
}

// ---- 给扩展的读取接口 --------------------------------------------------------
// 清单：每条的 id / 作者 / 是否在回收站 / 内容指纹（扩展据此判断要不要拉取）
export function listManifest(root = DEFAULT_ROOT) {
  const snapDir = join(root, "snapshots");
  const items = [];
  try {
    for (const f of readdirSync(snapDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(snapDir, f), "utf8");
        const s = JSON.parse(raw);
        let h = createHash("sha1").update(raw);
        if (s.thumbnailFile && existsSync(join(snapDir, s.thumbnailFile))) {
          h = h.update(String(statSync(join(snapDir, s.thumbnailFile)).size));
        }
        items.push({ id: s.id, author: s.author && s.author.id || "", deleted: !!s.deleted, h: h.digest("hex").slice(0, 16) });
      } catch (_) {}
    }
  } catch (_) {}
  const tombstones = [];
  try {
    for (const f of readdirSync(join(root, "tombstones"))) {
      if (!f.endsWith(".json")) continue;
      try { const t = JSON.parse(readFileSync(join(root, "tombstones", f), "utf8")); if (t && t.id && t.author) tombstones.push({ id: t.id, author: t.author }); } catch (_) {}
    }
  } catch (_) {}
  return { items, tombstones };
}

const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
export function readItems(root = DEFAULT_ROOT, ids = []) {
  const snapDir = join(root, "snapshots");
  const out = [];
  for (const id of ids) {
    if (typeof id !== "string" || !/^[\w-]{1,80}$/.test(id)) continue;
    try {
      const s = JSON.parse(readFileSync(join(snapDir, `${id}.json`), "utf8"));
      if (s.thumbnailFile && existsSync(join(snapDir, s.thumbnailFile))) {
        const ext = s.thumbnailFile.split(".").pop().toLowerCase();
        s.thumbnailUrl = `data:${MIME[ext] || "image/jpeg"};base64,${readFileSync(join(snapDir, s.thumbnailFile)).toString("base64")}`;
      }
      delete s.thumbnailFile;
      out.push(s);
    } catch (_) {}
  }
  return out;
}
