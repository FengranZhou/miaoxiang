// Swallow harmless "Could not establish connection" rejections from sendMessage
// when no content script is present in the active tab. These are benign in this
// extension's design and only clutter the error surface of chrome://extensions.
self.addEventListener('unhandledrejection', e => {
  const msg = e.reason && e.reason.message || ''
  if (msg.includes('Could not establish connection') ||
      msg.includes('Receiving end does not exist')) {
    e.preventDefault()
  }
})

const state = {
  loaded:   {},
  injected: {},
}

var platform = typeof browser === 'undefined'
  ? chrome
  : browser

// 开屏动画只在「扩展本次加载」内播一次：storage.session 在扩展被重新加载
// （chrome://extensions 刷新 / 更新 / 浏览器重启）时清空，正好对应
// "首次展示，reload 扩展后再展示一次" 的语义。SW 空闲被杀不影响（session 仍在）。
// 门闩判定完成后再走 next()，保证 splash 始终先于 restore/inject 注入。
// 门闩必须在 splash 注入「确认成功之后」才写：首次安装时，安装前就已打开的
// 标签页拿不到 host 权限，executeScript 会被拒（rejection 原本被 swallow 静默
// 吞掉）。若先乐观置位再注入，这一次性机会就被一次没播成的注入白白吃掉——
// 同事首装点图标看不到开场，之后永远走 fadein 分支。注入失败时不写标记，
// 把机会留给下一次唤起。
const withSplashGate = (tab_id, swallow, next) => {
  const playAndNext = () => {
    const p = platform.scripting.executeScript({
      target: {tabId: tab_id},
      files: ['toolbar/splash.js'],
    })
    if (p && typeof p.then === 'function') {
      p.then(
        () => { swallow(platform.storage.session.set({ liaisonSplashShown: true })) },
        () => {},   // 注入被拒：门闩不落，下次唤起仍可播
      )
    }
    next()
  }
  try {
    platform.storage.session.get('liaisonSplashShown').then(r => {
      if (r && r.liaisonSplashShown) {
        // 跳过 splash 时改注入渐显脚本，工具条以 0.35s 过渡入场
        swallow(platform.scripting.executeScript({
          target: {tabId: tab_id},
          files: ['toolbar/fadein.js'],
        }))
        next()
        return
      }
      playAndNext()   // 门闩改由 playAndNext 在注入成功后写
    }, playAndNext)
  } catch (_) { playAndNext() }
}

const toggleIn = ({id:tab_id}) => {
  const swallow = p => { if (p && typeof p.catch === 'function') p.catch(() => {}) }

  // toggle out: it's currently loaded and injected
  if (state.loaded[tab_id] && state.injected[tab_id]) {
    swallow(platform.scripting.executeScript({
      target: {tabId: tab_id},
      files: ['toolbar/eject.js'],
    }))
    state.injected[tab_id] = false
  }

  // toggle in: it's loaded and needs injected
  else if (state.loaded[tab_id] && !state.injected[tab_id]) {
    withSplashGate(tab_id, swallow, () => {
      swallow(platform.scripting.executeScript({
        target: {tabId: tab_id},
        files: ['toolbar/restore.js'],
      }))
      swallow(platform.scripting.executeScript({
        target: {tabId: tab_id},
        files: ['toolbar/fullscreen.js'],
      }))
      swallow(platform.scripting.executeScript({
        target: {tabId: tab_id},
        files: ['toolbar/update-modal.js'],
      }))
    })
    state.injected[tab_id] = true
  }

  // fresh start in tab
  else {
    withSplashGate(tab_id, swallow, () => {
      // ⚠️ Shadow DOM 劫持必须最早执行，在宿主创建 liaison-style-panel 之前
      swallow(platform.scripting.executeScript({
        target: {tabId: tab_id},
        files: ['toolbar/shadow-dom-hijack.js'],
        world: 'MAIN', // 注入到主世界，早于宿主代码
      }))
      swallow(platform.scripting.insertCSS({
        target: {tabId: tab_id},
        files: ['toolbar/bundle.css' ],
      }))
      swallow(platform.scripting.executeScript({
        target: {tabId: tab_id},
        files: ['toolbar/inject.js'],
      }))
      swallow(platform.scripting.executeScript({
        target: {tabId: tab_id},
        files: ['toolbar/fullscreen.js'],
      }))
      // 强提醒：本地版本落后于 gist 门槛线时弹更新弹窗（自带一天一次 / 跳过
      // 此版本等门闸，绝大多数注入什么都不做就退出）
      swallow(platform.scripting.executeScript({
        target: {tabId: tab_id},
        files: ['toolbar/update-modal.js'],
      }))
    })

    state.loaded[tab_id]    = true
    state.injected[tab_id]  = true
  }

  platform.tabs.onUpdated.addListener(function(tabId) {
    if (tabId === tab_id)
      state.loaded[tabId] = false
  })
}

platform.action.onClicked.addListener(toggleIn)

// ---------------------------------------------------------------------------
// Inspiration Library storage — IndexedDB in the extension's own origin.
//
// Why here (background service worker) and not in inject.js: the content script
// runs in the page's origin, so its IndexedDB would be per-site (a library on
// aigc.baidu.com wouldn't be visible on another site). The old backend used
// chrome.storage.local, which is extension-global (cross-site). To keep that
// cross-site "one shared library" semantic while escaping the ~10MB quota, the
// DB lives in the SW origin and is reached via runtime messaging.
//
// The record shape is unchanged: one key ("liaison.inspiration.library") maps to
// the whole {version, snapshots:[…]} object. bundle.min.js's get/set contract is
// untouched — only the persistence layer moved. Later phases can split snapshots
// into per-row storage; for now this is a drop-in, zero-risk backend swap that
// removes the quota ceiling.
// ---------------------------------------------------------------------------
const LIAISON_DB_NAME = 'liaison-asset-library'
const LIAISON_DB_STORE = 'kv'
const LIAISON_LIB_KEY = 'liaison.inspiration.library'

function liaisonOpenDb() {
  return new Promise((resolve, reject) => {
    let req
    try {
      req = indexedDB.open(LIAISON_DB_NAME, 1)
    } catch (e) {
      reject(e)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(LIAISON_DB_STORE)) {
        db.createObjectStore(LIAISON_DB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'))
  })
}

function liaisonDbGet(key) {
  return liaisonOpenDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(LIAISON_DB_STORE, 'readonly')
    const req = tx.objectStore(LIAISON_DB_STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('idb get failed'))
  }))
}

function liaisonDbSet(key, value) {
  return liaisonOpenDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(LIAISON_DB_STORE, 'readwrite')
    tx.objectStore(LIAISON_DB_STORE).put(value, key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error || new Error('idb set failed'))
    tx.onabort = () => reject(tx.error || new Error('idb set aborted'))
  }))
}

// ---------------------------------------------------------------------------
// 采集库镜像备份（意外丢失的补救层）。
//
// 每次主库写入成功后，把新值与备份按 snapshot.id 做并集写入同库的独立 key：
//   - 新采集/编辑实时进入备份 —— 备份永远跟着最新进度走
//   - 并集策略下备份只增不减：即使某次写入把主库"写少了"（含未来任何绕过
//     守门员的误清空路径），已进过备份的条目也不会从备份里消失
// 代价是用户主动删除的条目会留在备份里 —— 对救灾场景这是 feature 不是 bug。
// 恢复：发 {action:'liaisonInspBackupRestore'} 或在 SW 控制台直接调
// liaisonDbGet(LIAISON_LIB_BACKUP_KEY)。备份写失败只告警，绝不拖累主流程。
const LIAISON_LIB_BACKUP_KEY = 'liaison.inspiration.library.backup'
const LIAISON_BACKUP_CAP = 6000 // 主库上限 5000，备份留冗余；超限截掉最老的备份独有条目

function liaisonBackupMerge(incoming) {
  return liaisonDbGet(LIAISON_LIB_BACKUP_KEY).then(backup => {
    const inSnaps = (incoming && Array.isArray(incoming.snapshots)) ? incoming.snapshots : []
    const bakSnaps = (backup && Array.isArray(backup.snapshots)) ? backup.snapshots : []
    const seen = new Set()
    for (const s of inSnaps) { if (s && s.id != null) seen.add(s.id) }
    const extras = bakSnaps.filter(s => s && s.id != null && !seen.has(s.id))
    const merged = Object.assign({}, incoming, {
      snapshots: inSnaps.concat(extras).slice(0, LIAISON_BACKUP_CAP),
      __backupUpdatedAt: Date.now(),
    })
    return liaisonDbSet(LIAISON_LIB_BACKUP_KEY, merged)
  })
}

// One-time migration: if IndexedDB has no library yet but the legacy
// chrome.storage.local copy exists, move it over. Runs on the first get().
function liaisonMigrateFromLocal() {
  return liaisonDbGet(LIAISON_LIB_KEY).then(existing => {
    if (existing !== undefined && existing !== null) return existing
    return new Promise((resolve) => {
      platform.storage.local.get([LIAISON_LIB_KEY], (o) => {
        const legacy = o && o[LIAISON_LIB_KEY]
        if (legacy && typeof legacy === 'object') {
          liaisonDbSet(LIAISON_LIB_KEY, legacy)
            .then(() => resolve(legacy))
            .catch(() => resolve(legacy))
        } else {
          resolve(undefined)
        }
      })
    })
  })
}

// ---------------------------------------------------------------------------
// CDP-backed collection infrastructure (hover-state harvesting, and a reusable
// base for future CDP capabilities: matched-style provenance, pseudo-element
// rules, platform fonts, box model, live @media rules).
//
// Why CDP: some visual state can't be read from the page world at all. CSS
// `:hover` is one — it can only be triggered by a real pointer or by CDP's
// `CSS.forcePseudoState`; JS `dispatchEvent(mouseenter)` does NOT fire it
// (verified). And cross-origin `.cssRules` throw SecurityError. CDP sits at the
// DevTools layer and sidesteps both.
//
// `withCdpSession` owns the attach → enable(DOM,CSS) → work → detach lifecycle
// and GUARANTEES detach + pseudo-cleanup in a finally, so every capability
// (present and future) shares one debugging banner and one cleanup path. hover
// is just the first consumer; add more by appending capability units inside
// `collectViaCdp` — no new attach, no new bridge action, no new permission.
// ---------------------------------------------------------------------------
async function withCdpSession(tabId, worker) {
  const target = { tabId }
  const cmd = (method, params) => new Promise((res, rej) => {
    platform.debugger.sendCommand(target, method, params || {}, r => {
      const e = platform.runtime.lastError
      if (e) rej(new Error(e.message)); else res(r)
    })
  })

  // attach may reject: user declined the banner, or DevTools already owns this
  // tab (one debugger client per tab). Reject bubbles to the caller → graceful
  // degrade. No detach needed here — we never attached.
  await new Promise((res, rej) => {
    platform.debugger.attach(target, '1.3', () => {
      const e = platform.runtime.lastError
      if (e) rej(new Error(e.message)); else res()
    })
  })

  // Collect CDP events for this session. Some capabilities need events, not just
  // command replies — e.g. CSS.enable replays a styleSheetAdded event per sheet,
  // which is how we enumerate ALL stylesheets (to find a component's state-class
  // rules even when the target isn't currently in that state). Detached in finally.
  const styleSheetIds = []
  const onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return
    if (method === 'CSS.styleSheetAdded' && params && params.header) styleSheetIds.push(params.header.styleSheetId)
  }
  platform.debugger.onEvent.addListener(onEvent)

  const session = {
    cmd,
    styleSheetIds,
    forcedNodeIds: new Set(),
    async forcePseudo(nodeId, classes) {
      await cmd('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes })
      if (classes && classes.length) this.forcedNodeIds.add(nodeId)
      else this.forcedNodeIds.delete(nodeId)
    },
    _rootId: null,
    async selectedNodeId() {
      if (!this._rootId) {
        const doc = await cmd('DOM.getDocument', { depth: -1 })
        this._rootId = doc.root.nodeId
      }
      const sel = await cmd('DOM.querySelector', { nodeId: this._rootId, selector: '[data-selected="true"]' })
      if (!sel || !sel.nodeId) throw new Error('no data-selected node')
      return sel.nodeId
    }
  }

  try {
    await cmd('DOM.enable')
    await cmd('CSS.enable')
    return await worker(session)
  } finally {
    // Unconditional cleanup. Detach FIRST so the "is debugging this browser"
    // banner disappears the instant collection finishes — detach tears down the
    // whole CDP session, which auto-clears every forced pseudo-state (no per-node
    // reset needed; the old reset loop only delayed the detach by N round-trips).
    try { platform.debugger.onEvent.removeListener(onEvent) } catch (_) {}
    await new Promise(res => {
      try { platform.debugger.detach(target, () => { void platform.runtime.lastError; res() }) }
      catch (_) { res() }
    })
    session.forcedNodeIds.clear()
  }
}

// One capability unit: force each pseudo (:hover / :focus / :active) on the
// target in turn, diff computed style (target + descendants) against the default
// state. `session` owns attach/detach; this only forces pseudos (recorded for
// cleanup) and reads/diffs. Returns { self:{pseudo:{prop:val}}, descendants:[] }.
async function collectHover(session, targetNodeId, whitelist, pseudos) {
  const wl = whitelist && whitelist.length ? whitelist : null
  const readComputed = async (nid) => {
    const r = await session.cmd('CSS.getComputedStyleForNode', { nodeId: nid })
    const m = {}
    const arr = (r && r.computedStyle) || []
    for (let i = 0; i < arr.length; i++) {
      const name = arr[i].name
      if (!wl || wl.indexOf(name) >= 0) m[name] = arr[i].value
    }
    return m
  }
  const diffMap = (base, hov) => {
    const out = {}
    Object.keys(hov).forEach(k => { if (base[k] !== hov[k]) out[k] = hov[k] })
    return out
  }

  // descendants (cap to avoid runaway on huge subtrees; linkage is tiny)
  let descIds = []
  try {
    const qa = await session.cmd('DOM.querySelectorAll', { nodeId: targetNodeId, selector: '*' })
    descIds = ((qa && qa.nodeIds) || []).slice(0, 200)
  } catch (_) { descIds = [] }
  const allIds = [targetNodeId].concat(descIds)

  // baseline (default state, before forcing any pseudo)
  const base = {}
  for (const nid of allIds) base[nid] = await readComputed(nid)

  // cache node label (tag/class) once per node, reused across pseudo states
  const labelCache = {}
  const labelOf = async (nid) => {
    if (labelCache[nid]) return labelCache[nid]
    let tag = '', cls = ''
    try {
      const dn = await session.cmd('DOM.describeNode', { nodeId: nid })
      const node = dn && dn.node
      tag = (node && node.localName) || ''
      const attrs = (node && node.attributes) || []
      for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'class') { cls = String(attrs[i + 1] || '').trim(); break }
    } catch (_) {}
    const firstClass = cls ? cls.split(/\s+/)[0] : ''
    return (labelCache[nid] = { tag, cls, descSel: firstClass ? '.' + firstClass : (tag || '*') })
  }

  // Baseline pseudo-elements (::before/::after) BEFORE forcing any state — used
  // to diff against the hover/focus/active state below. getComputedStyleForNode
  // (used for element nodes above) CANNOT read a pseudo-element, so the only way
  // to catch "hover expands ::before width 0→100%" style animations is to
  // re-collect matched pseudo rules under forcePseudoState and diff. Historic
  // blind spot: pseudo-elements were only ever collected in the default state,
  // so a hover-driven decoration (top divider line, underline slide-in, badge
  // fade) silently vanished from the replica.
  const basePseudo = await collectPseudoElements(session, targetNodeId)
  // key by nid (stable within the session) not nodeDesc — two distinct nodes can
  // share a nodeDesc (e.g. two div.x), which would cross-wire the baseline diff.
  const pseudoKey = (p) => p.nid + '|' + p.pseudo
  const baseP = {}
  basePseudo.forEach(p => { baseP[pseudoKey(p)] = p.decls || {} })

  // For each requested pseudo: force it → wait for transition → read → diff vs
  // baseline → restore. Serial (one pseudo at a time) so states don't stack.
  const self = {}                 // { hover:{prop:val}, focus:{...}, active:{...} }
  const descendants = []          // [{pseudo, descSel, decls, matchCount, sample}]
  const selfPseudo = []           // [{pseudo, nodeDesc, on:'::before', changed:{width:'100%'}}]
  const list = (pseudos && pseudos.length) ? pseudos : ['hover']
  for (const ps of list) {
    await session.forcePseudo(targetNodeId, [ps])
    // Wait for CSS transitions to settle (e.g. hover overlay opacity 0→1 over
    // 0.4s), so we read the final state not a mid-animation frame.
    await new Promise(res => setTimeout(res, 450))

    const stateComputed = {}
    for (const nid of allIds) stateComputed[nid] = await readComputed(nid)

    const sd = diffMap(base[targetNodeId], stateComputed[targetNodeId])
    if (Object.keys(sd).length) self[ps] = sd

    for (const nid of descIds) {
      const d = diffMap(base[nid], stateComputed[nid])
      if (!Object.keys(d).length) continue
      const lb = await labelOf(nid)
      descendants.push({ pseudo: ps, descSel: lb.descSel, decls: d, matchCount: 1, sample: { tag: lb.tag, cls: lb.cls.slice(0, 80), text: '' } })
    }

    // Re-collect ::before/::after under the forced state; diff vs baseline to
    // surface state-driven pseudo changes (width/opacity/transform/--var/…).
    //
    // CRITICAL: the decoration whose :hover changes the pseudo may live on a
    // DESCENDANT, not the selected element. forcePseudo(targetNodeId) only
    // activates the selected node's own :hover — so `.btn:hover::before` never
    // fires when the user selected the button's WRAPPER div. We must force each
    // pseudo-OWNING node's OWN hover too. (Same blind spot class as descendant
    // self-hover, but on the pseudo-diff path — this is how the vzan login
    // button's `:hover::before{--size:150px}` glow was silently dropped.)
    try {
      // owners = every distinct node that has a ::before/::after (from baseline).
      // Force each one's own [ps], re-collect just its pseudos, diff vs baseline.
      const ownerNids = Array.from(new Set(basePseudo.map(p => p.nid).filter(n => n != null)))
      for (const ownNid of ownerNids) {
        // target already forced above; others need their own pseudo forced
        if (ownNid !== targetNodeId) await session.forcePseudo(ownNid, [ps])
        let statePseudo = []
        try { statePseudo = await collectPseudoElements(session, ownNid, true) } catch (_) {}
        for (const sp of statePseudo) {
          const bd = baseP[pseudoKey(sp)] || {}
          const changed = {}
          Object.keys(sp.decls || {}).forEach(k => { if (bd[k] !== sp.decls[k]) changed[k] = sp.decls[k] })
          if (Object.keys(changed).length) {
            // de-dupe: same node+pseudo+state may surface from multiple passes
            const dup = selfPseudo.some(e => e.pseudo === ps && e.nodeDesc === sp.nodeDesc && e.on === sp.pseudo)
            if (!dup) selfPseudo.push({ pseudo: ps, nodeDesc: sp.nodeDesc, on: sp.pseudo, changed })
          }
        }
        if (ownNid !== targetNodeId) await session.forcePseudo(ownNid, [])  // restore this owner
      }
    } catch (_) {}

    await session.forcePseudo(targetNodeId, [])   // restore before next pseudo
  }

  return { self, descendants, selfPseudo }
}

// Capability unit: style provenance via CSS.getMatchedStylesForNode.
//
// Why: the page-world path only ever sees FINAL computed values — it can't tell
// which rule produced a value or whether a value was overridden. That's the root
// of two recurring replication bugs: "read source-code value ≠ final value" and
// "read the wrong cascade layer". This surfaces, for the target + its text-bearing
// descendants, only the KEY properties that are genuinely CONTESTED (≥2 rules
// declaring different values) — final winner + who it overrode. Pure formatting
// differences (whitespace, quotes, 0 vs 0px) are normalized away to cut noise.
const MATCH_KEYPROPS = ['font-size', 'font-weight', 'color', 'line-height', 'font-family',
  'background-color', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-radius', 'text-align', 'letter-spacing']

function __normCssVal(v) {
  let s = String(v).trim().toLowerCase()
  s = s.replace(/\s*,\s*/g, ',')
  s = s.replace(/["']/g, '')
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/\b0\.(\d)/g, '.$1')
  if (/^0([a-z%]*)?$/.test(s)) s = '0'
  return s
}

function __analyzeConflicts(matchedCSSRules) {
  const byProp = {}
  ;(matchedCSSRules || []).forEach((mr, order) => {
    const rule = mr.rule
    const sel = (rule.selectorList && rule.selectorList.text) || '?'
    const origin = rule.origin
    ;((rule.style && rule.style.cssProperties) || []).forEach(p => {
      if (!p.value || p.disabled) return
      const name = String(p.name).toLowerCase()
      if (MATCH_KEYPROPS.indexOf(name) < 0) return
      ;(byProp[name] = byProp[name] || []).push({ sel, origin, value: p.value, norm: __normCssVal(p.value), important: !!p.important, order })
    })
  })
  const conflicts = []
  Object.keys(byProp).forEach(name => {
    const decls = byProp[name]
    const imp = decls.filter(d => d.important)
    const winner = imp.length ? imp[imp.length - 1] : decls[decls.length - 1]
    const losers = []
    const seen = {}
    decls.forEach(d => {
      if (d === winner || d.norm === winner.norm || seen[d.norm]) return
      seen[d.norm] = 1
      losers.push({ value: d.value, origin: d.origin, sel: d.sel })
    })
    if (losers.length) conflicts.push({ prop: name, winner: { value: winner.value, sel: winner.sel }, losers })
  })
  return conflicts
}

async function collectMatchedStyles(session, targetNodeId) {
  // node set: target + text-bearing descendants (h1-6/p/span/a/label/div with direct text).
  // We keep it small — provenance noise scales badly. querySelectorAll a focused set.
  let nodeIds = [targetNodeId]
  try {
    const q = await session.cmd('DOM.querySelectorAll', { nodeId: targetNodeId, selector: 'h1,h2,h3,h4,h5,h6,p,span,a,label,button' })
    nodeIds = nodeIds.concat((q.nodeIds || []).slice(0, 30))
  } catch (_) {}

  const conflictsOut = []
  for (let idx = 0; idx < nodeIds.length; idx++) {
    const nid = nodeIds[idx]
    let matched
    try {
      const r = await session.cmd('CSS.getMatchedStylesForNode', { nodeId: nid })
      matched = r.matchedCSSRules
    } catch (_) { continue }
    // label the node
    let tag = '', cls = ''
    try {
      const dn = await session.cmd('DOM.describeNode', { nodeId: nid })
      const node = dn && dn.node
      tag = (node && node.localName) || ''
      const attrs = (node && node.attributes) || []
      for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'class') { cls = String(attrs[i + 1] || '').trim(); break }
    } catch (_) {}

    const conflicts = __analyzeConflicts(matched)
    if (!conflicts.length) continue
    const firstClass = cls ? cls.split(/\s+/)[0] : ''
    const nodeDesc = firstClass ? (tag + '.' + firstClass) : (tag || '节点')
    conflictsOut.push({ nodeDesc, conflicts })
  }
  return conflictsOut  // [{nodeDesc, conflicts:[...]}]
}

const STATE_CLASS_RE = /(^|[-_])(selected|active|checked|current|open|opened|expanded|collapsed|disabled|highlight|highlighted|focused|pressed|on|activated|chosen|toggled)([-_]|$)/i

// Capability unit: state-class styling via WHOLE-PAGE CSS scan.
//
// The key improvement over reading the target's currently-matched rules: this
// finds a component's state styles (selected/active/checked/...) EVEN WHEN THE
// TARGET IS IN ITS DEFAULT STATE. forcePseudoState can't help — a state class
// (e.g. `.selected-N7LViq`) is a real class, not a pseudo, and its hashed name
// isn't knowable up front. So instead: take the target's non-state "component
// base" class(es), enumerate every stylesheet (CSS.enable replays a
// styleSheetAdded event per sheet → session.styleSheetIds), and pull any rule
// whose selector combines a base class with a state class. Now you can grab a
// default-state card and still learn what it looks like when selected.
async function collectStateStyles(session, targetNodeId) {
  // 1. target's class list → component base classes (non-state, class-Modules-ish)
  let cls = ''
  try {
    const dn = await session.cmd('DOM.describeNode', { nodeId: targetNodeId })
    const attrs = (dn && dn.node && dn.node.attributes) || []
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'class') { cls = String(attrs[i + 1] || '').trim(); break }
  } catch (_) {}
  const classes = cls.split(/\s+/).filter(Boolean)
  // base classes = the ones that are NOT state classes; pick those that look like
  // stable component identifiers (has a hyphen/hash or is reasonably long).
  const baseClasses = classes.filter(c => !STATE_CLASS_RE.test(c)).filter(c => c.length >= 4)
  if (!baseClasses.length) return []

  // 2. enumerate all stylesheets (need a beat for styleSheetAdded events to land)
  await new Promise(res => setTimeout(res, 300))
  const sheetIds = (session.styleSheetIds || []).slice()
  if (!sheetIds.length) return []

  // 3. scan each sheet text for rules combining a base class + a state class
  const found = {}  // stateKey -> {classes:Set, decls:{}, sel}
  for (const sid of sheetIds) {
    let text
    try { const r = await session.cmd('CSS.getStyleSheetText', { styleSheetId: sid }); text = r.text } catch (_) { continue }
    if (!text) continue
    if (!baseClasses.some(b => text.indexOf(b) >= 0)) continue
    // crude rule split (good enough: we only need selector + flat declarations)
    const chunks = text.split('}')
    for (const chunk of chunks) {
      const bi = chunk.indexOf('{')
      if (bi < 0) continue
      const sel = chunk.slice(0, bi).trim()
      if (!sel) continue
      // must reference one of our base classes AND a state class token
      if (!baseClasses.some(b => sel.indexOf('.' + b) >= 0)) continue
      const stateMatch = sel.match(/\.[\w-]*(selected|active|checked|current|open|opened|expanded|collapsed|disabled|highlight|highlighted|focused|pressed|activated|chosen|toggled)[\w-]*/i)
      if (!stateMatch) continue
      const stateCls = stateMatch[0].slice(1)  // strip leading dot
      const body = chunk.slice(bi + 1)
      const decls = __parseFlatDecls(body)
      if (!Object.keys(decls).length) continue
      const key = stateCls
      if (!found[key]) found[key] = { stateClass: stateCls, decls: {}, sel: sel.slice(0, 100) }
      Object.assign(found[key].decls, decls)
    }
  }
  return Object.keys(found).map(k => found[k])  // [{stateClass, decls:{prop:val}, sel}]
}

// flat declaration parser: "background:#f6f6ff;border-color:#352eff" -> {...}
function __parseFlatDecls(body) {
  const out = {}
  String(body).split(';').forEach(seg => {
    const ci = seg.indexOf(':')
    if (ci < 0) return
    const prop = seg.slice(0, ci).trim().toLowerCase()
    let val = seg.slice(ci + 1).trim()
    if (!prop || !val) return
    // drop background longhand noise so we surface the meaningful shorthand
    if (/^background-(position|size|repeat|origin|clip|attachment|image)/.test(prop)) return
    out[prop] = val
  })
  return out
}

// Capability unit: ::before / ::after pseudo-element rules.
//
// Why: decorative badges / dividers / dots are often drawn purely with
// ::before/::after. getComputedStyle can't tell you a pseudo-element's rule
// source or its `content`, so replication silently drops them. CDP's
// getMatchedStylesForNode returns a `pseudoElements` array — we pull before/after
// (NOT scrollbar/selection/etc.) and surface `content` + key visual props so the
// replica can recreate the decoration.
// Was a whitelist (PSEUDO_KEYPROPS) — replaced by a tiny denylist. A pseudo-element
// matched-rule declaration is hand-authored, so every declared prop is meaningful;
// whitelisting kept silently dropping un-listed ones (clip-path / filter / height /
// letter-spacing …). We now keep every declared prop and only drop these genuine
// noise props (redundant longhands of a shorthand we already surface, or values
// that carry no replication signal on their own).
// UNCONDITIONAL noise — never a decoration signal on any site, drop always.
const PSEUDO_SKIP = new Set([
  // global reset noise — sites ship `*::before,*::after{box-sizing:border-box}`,
  // so EVERY pseudo would otherwise surface a lone box-sizing line (20+ empty
  // "div.x ::before → box-sizing" sections drowning the one real decoration).
  'box-sizing',
  // background longhands — the `background` shorthand already carries these
  'background-position', 'background-size', 'background-repeat', 'background-origin',
  'background-clip', 'background-attachment',
  // shorthand default-value echoes — the `transition` shorthand already carries
  // the signal; these split longhands just repeat defaults (normal/none)
  'transition-behavior',
  'animation-name', 'animation-duration', 'animation-timing-function',
  'transition-timing-function', 'transition-delay'
])

// CONDITIONAL noise — font/typography props. On a PURELY GEOMETRIC pseudo
// (content is empty "" / none — a line, block, dot) these are just inherited
// echoes of the host and carry no decoration signal, so drop them. But when the
// pseudo's `content` is an actual glyph (content:"★", an icon-font char, attr()),
// font-family/etc ARE the decoration (icon-font glyphs render wrong without the
// right family) — so we KEEP them. Site-agnostic: keyed on content, not on any
// particular site's reset.
const PSEUDO_TYPO_SKIP = new Set([
  'font-family', 'font-variant-numeric', 'font-feature-settings', 'word-break',
  'text-decoration-color', 'text-decoration-thickness', '-webkit-text-fill-color'
])
// content that renders NO glyph → typography props are inert echoes
function __pseudoContentIsEmpty(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase()
  return s === '' || s === '""' || s === "''" || s === 'none' || s === 'normal'
}
async function collectPseudoElements(session, targetNodeId, selfOnly) {
  // selfOnly: collect ONLY the given node's ::before/::after, skip descendants.
  // Used by the hover-diff loop which forces one owner's :hover at a time and
  // must read just that owner's pseudos (not re-scan the whole subtree per owner).
  let nodeIds = [targetNodeId]
  if (!selfOnly) {
    try {
      const q = await session.cmd('DOM.querySelectorAll', { nodeId: targetNodeId, selector: '*' })
      nodeIds = nodeIds.concat((q.nodeIds || []).slice(0, 60))
    } catch (_) {}
  }

  const out = []
  for (const nid of nodeIds) {
    let pe
    try {
      const r = await session.cmd('CSS.getMatchedStylesForNode', { nodeId: nid })
      pe = r.pseudoElements
    } catch (_) { continue }
    if (!pe || !pe.length) continue
    // only ::before / ::after (skip scrollbar / selection / marker / etc.)
    const decorPe = pe.filter(x => x.pseudoType === 'before' || x.pseudoType === 'after')
    if (!decorPe.length) continue

    // label the owning node
    let tag = '', cls = ''
    try {
      const dn = await session.cmd('DOM.describeNode', { nodeId: nid })
      const node = dn && dn.node
      tag = (node && node.localName) || ''
      const attrs = (node && node.attributes) || []
      for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'class') { cls = String(attrs[i + 1] || '').trim(); break }
    } catch (_) {}
    const firstClass = cls ? cls.split(/\s+/)[0] : ''
    const nodeDesc = firstClass ? (tag + '.' + firstClass) : (tag || '节点')

    for (const x of decorPe) {
      const decls = {}
      ;(x.matches || []).forEach(m => {
        ;((m.rule && m.rule.style && m.rule.style.cssProperties) || []).forEach(p => {
          if (!p.value || p.disabled) return
          const name = String(p.name).toLowerCase()
          // NO whitelist: a pseudo-element rule is hand-authored, every declared
          // property is intentional (unlike computed style which is full of
          // derived noise). Whitelisting silently dropped whatever wasn't listed
          // — e.g. clip-path underlines, filter glows, letter-spacing, height
          // (vertical expand) all vanished until someone hit them and patched the
          // list. Take every declared prop; only drop the handful of genuine
          // noise below so accuracy is unchanged while coverage becomes complete.
          if (PSEUDO_SKIP.has(name)) return
          decls[name] = p.value + (p.important ? ' !important' : '')
        })
      })
      // Conditional typography drop — done AFTER full collect because `content`
      // may appear at any point in the rule list and we need its final value to
      // decide. Empty content (geometric pseudo) → font props are inert echoes,
      // drop. Glyph content (icon font / quote char) → font props are the
      // decoration, keep.
      if (__pseudoContentIsEmpty(decls.content)) {
        Object.keys(decls).forEach(name => { if (PSEUDO_TYPO_SKIP.has(name)) delete decls[name] })
      }
      // Drop vendor-prefixed dups of a standard prop we already captured. Done
      // AFTER the full collect (not inline) — CDP can emit `-webkit-transform`
      // BEFORE `transform`, so an order-dependent inline check would keep the
      // prefix and miss the standard one. Also drop a prefixed dup whose bare
      // form is in either denylist.
      Object.keys(decls).forEach(name => {
        const mm = /^-(webkit|moz|ms|o)-(.+)$/.exec(name)
        if (mm && (decls[mm[2]] !== undefined || PSEUDO_SKIP.has(mm[2]) || PSEUDO_TYPO_SKIP.has(mm[2]))) delete decls[name]
      })
      // a pseudo-element that has neither content nor any visual prop is noise
      if (!Object.keys(decls).length) continue
      // guard against reset-only pseudos slipping through: if the ONLY thing left
      // is an empty content (content:"" / none) with no geometry/paint, it's inert
      const keys = Object.keys(decls)
      const inertContent = keys.length === 1 && keys[0] === 'content' &&
        /^("")|(none)$/.test(String(decls.content).trim())
      if (inertContent) continue
      out.push({ nid, nodeDesc, pseudo: '::' + x.pseudoType, decls })
    }
  }
  return out  // [{nid, nodeDesc, pseudo:'::before'|'::after', decls:{content,...}}]
}

// Capability unit: real rendered fonts via CSS.getPlatformFontsForNode.
//
// Why: font-family is a fallback LIST (e.g. -apple-system, "system-ui", ...,
// "PingFang SC", "Microsoft YaHei", SimSun). computed style only echoes the
// declaration — it never tells you which font actually rendered, which matters
// most for CJK where the fallback that wins varies by OS. This reports the
// ACTUAL family + PostScript name (e.g. PingFangSC-Semibold) per text node.
async function collectFonts(session, targetNodeId) {
  // text-bearing nodes: target + descendants that hold text (title/body/label)
  let nodeIds = [targetNodeId]
  try {
    const q = await session.cmd('DOM.querySelectorAll', { nodeId: targetNodeId, selector: 'h1,h2,h3,h4,h5,h6,p,span,a,label,div,button' })
    nodeIds = nodeIds.concat((q.nodeIds || []).slice(0, 40))
  } catch (_) {}

  const seen = {}   // familyName|postScript -> the node that first showed it
  const out = []
  for (const nid of nodeIds) {
    let fonts
    try {
      const r = await session.cmd('CSS.getPlatformFontsForNode', { nodeId: nid })
      fonts = r.fonts
    } catch (_) { continue }
    if (!fonts || !fonts.length) continue
    // node has no rendered text glyphs → skip (glyphCount 0)
    const real = fonts.filter(f => f.glyphCount > 0 && f.familyName)
    if (!real.length) continue

    let tag = '', cls = ''
    try {
      const dn = await session.cmd('DOM.describeNode', { nodeId: nid })
      const node = dn && dn.node
      tag = (node && node.localName) || ''
      const attrs = (node && node.attributes) || []
      for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'class') { cls = String(attrs[i + 1] || '').trim(); break }
    } catch (_) {}
    const firstClass = cls ? cls.split(/\s+/)[0] : ''
    const nodeDesc = firstClass ? (tag + '.' + firstClass) : (tag || '节点')

    real.forEach(f => {
      const key = f.familyName + '|' + (f.postScriptName || '')
      if (seen[key]) return   // dedup identical family across nodes
      seen[key] = 1
      out.push({ nodeDesc, familyName: f.familyName, postScriptName: f.postScriptName || '', isCustom: !!f.isCustomFont, glyphCount: f.glyphCount })
    })
  }
  return out  // [{nodeDesc, familyName, postScriptName, isCustom, glyphCount}]
}

// Capability unit: precise decoration rectangles via DOM.getBoxModel.
//
// Not a dump of every element's box (computed style already has width/padding/
// margin). The real value: for ABSOLUTELY/FIXED-positioned decorative children
// (badges, ribbons, underline bars, floating icons), compute their occupied
// rectangle RELATIVE TO THE PARENT (left/top/width/height) — the automated,
// sub-pixel-accurate version of "reverse the decoration rect from the child's
// top/right/bottom/left offsets" (a hand-calc replication step, easy to get
// wrong). Only absolute/fixed children are reported; normal-flow ones are noise.
async function collectBoxModel(session, targetNodeId) {
  const q2r = (q) => ({ x: q[0], y: q[1], w: q[2] - q[0], h: q[5] - q[1] })

  // parent content rect (reference frame)
  let parentRect
  try {
    const pb = await session.cmd('DOM.getBoxModel', { nodeId: targetNodeId })
    parentRect = q2r(pb.model.content)
  } catch (_) { return [] }

  // descendants
  let descIds = []
  try {
    const q = await session.cmd('DOM.querySelectorAll', { nodeId: targetNodeId, selector: '*' })
    descIds = (q.nodeIds || []).slice(0, 80)
  } catch (_) { return [] }

  const out = []
  for (const nid of descIds) {
    // only absolute/fixed positioned children
    let position = ''
    try {
      const cs = await session.cmd('CSS.getComputedStyleForNode', { nodeId: nid })
      const pp = (cs.computedStyle || []).find(x => x.name === 'position')
      position = pp ? pp.value : ''
    } catch (_) { continue }
    if (position !== 'absolute' && position !== 'fixed') continue

    let childRect
    try {
      const cb = await session.cmd('DOM.getBoxModel', { nodeId: nid })
      childRect = q2r(cb.model.border)
    } catch (_) { continue }
    // degenerate / offscreen boxes → skip
    if (childRect.w <= 0 || childRect.h <= 0) continue

    let tag = '', cls = ''
    try {
      const dn = await session.cmd('DOM.describeNode', { nodeId: nid })
      const node = dn && dn.node
      tag = (node && node.localName) || ''
      const attrs = (node && node.attributes) || []
      for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'class') { cls = String(attrs[i + 1] || '').trim(); break }
    } catch (_) {}
    const firstClass = cls ? cls.split(/\s+/)[0] : ''
    const nodeDesc = firstClass ? (tag + '.' + firstClass) : (tag || '节点')

    const round = (n) => Math.round(n * 10) / 10
    out.push({
      nodeDesc, position,
      rel: { left: round(childRect.x - parentRect.x), top: round(childRect.y - parentRect.y), width: round(childRect.w), height: round(childRect.h) },
      parent: { width: round(parentRect.w), height: round(parentRect.h) }
    })
  }
  return out  // [{nodeDesc, position, rel:{left,top,width,height}, parent:{width,height}}]
}

// Capability dispatcher: one attach, run every requested capability unit,
// return results keyed by capability name. Add future units here.
async function collectViaCdp(session, req) {
  const caps = (req && req.capabilities) || ['hover']
  const whitelist = (req && req.whitelist) || []
  const out = {}
  // read-only capabilities first, so hover's forcePseudoState doesn't pollute them
  if (caps.indexOf('matchedStyles') >= 0) {
    const targetNodeId = await session.selectedNodeId()
    out.matchedStyles = await collectMatchedStyles(session, targetNodeId)
  }
  if (caps.indexOf('stateStyles') >= 0) {
    const targetNodeId = await session.selectedNodeId()
    out.stateStyles = await collectStateStyles(session, targetNodeId)
  }
  if (caps.indexOf('pseudoElements') >= 0) {
    const targetNodeId = await session.selectedNodeId()
    out.pseudoElements = await collectPseudoElements(session, targetNodeId)
  }
  if (caps.indexOf('fonts') >= 0) {
    const targetNodeId = await session.selectedNodeId()
    out.fonts = await collectFonts(session, targetNodeId)
  }
  if (caps.indexOf('boxModel') >= 0) {
    const targetNodeId = await session.selectedNodeId()
    out.boxModel = await collectBoxModel(session, targetNodeId)
  }
  if (caps.indexOf('hover') >= 0) {
    const targetNodeId = await session.selectedNodeId()
    // which pseudo states to probe; defaults to hover only (back-compat)
    const pseudos = (req && req.pseudoStates && req.pseudoStates.length) ? req.pseudoStates : ['hover']
    out.hover = await collectHover(session, targetNodeId, whitelist, pseudos)
  }
  // Future (not yet implemented) — same session, same attach:
  //   if (caps.indexOf('boxModel') >= 0) out.boxModel = await collectBoxModel(session, ...)
  return out
}

// Screenshot bridge for Liaison Inspiration Library: content-script asks for
// a viewport PNG/JPEG, background captures via activeTab, returns data URL.
// ---- 参考图下载的静默化（落点收拢 + 记录清理 + UI 抑制）----------------------
//
// 参考图落点：收进下载目录下的专属子目录，别和用户自己下的文件混在一起。
// 同名覆盖，所以这个目录里始终只有 1 个文件。
const REF_DIR = '妙想参考图'

// 抹掉下载列表里的记录（磁盘文件保留）。CC 仍按 search 到的路径读图。
// 失败不影响主流程——最坏情况只是列表里多留一条记录。
function eraseDownloadRecord (id) {
  try {
    platform.downloads.erase({ id }, () => { void platform.runtime.lastError })
  } catch (e) { /* noop */ }
}

// 下载期间临时关掉下载气泡/托盘。Chrome 用 setUiOptions（需 downloads.ui 权限，
// 权限名和老 API setShelfEnabled 的 downloads.shelf 不是一个）；Firefox 只有
// setShelfEnabled。两者都可能因为「别的扩展也在关 UI」而报错，静默吞掉即可。
//
// 关掉是全局的：它同时挡住用户自己下载别的文件的气泡。所以必须保证一定会恢复——
// 除了各失败分支显式恢复，再挂一个兜底定时器，防 service worker 在恢复前被回收
// 或某条分支漏掉，导致用户的下载气泡被永久关掉。
let uiRestoreTimer = null
function setDownloadUiEnabled (enabled) {
  try {
    if (uiRestoreTimer) { clearTimeout(uiRestoreTimer); uiRestoreTimer = null }
    if (typeof platform.downloads.setUiOptions === 'function') {
      const r = platform.downloads.setUiOptions({ enabled })
      if (r && typeof r.catch === 'function') r.catch(() => {})
      void platform.runtime.lastError
    } else if (typeof platform.downloads.setShelfEnabled === 'function') {
      platform.downloads.setShelfEnabled(enabled)
      void platform.runtime.lastError
    }
    if (!enabled) {
      uiRestoreTimer = setTimeout(() => { uiRestoreTimer = null; setDownloadUiEnabled(true) }, 30000)
    }
  } catch (e) { /* noop */ }
}

// service worker 每次启动都把下载 UI 恢复一次：如果上个生命周期在关闭状态下被
// 回收，用户的下载气泡会一直是关的，这里兜住。
setDownloadUiEnabled(true)

platform.runtime.onMessage.addListener((req, sender, sendResponse) => {
  // 「自检」tab · 两段式短轮询：background 用扩展权限 fetch 本地服务（不受页面 CSP）。
  // start / poll 都秒回，service worker 无需长存活、不会被 30s 空闲回收。
  if (req && req.action === 'liaisonSelfAuditStart') {
    (async () => {
      try {
        const resp = await fetch('http://127.0.0.1:8765/audit/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.payload || {}),
        })
        if (!resp.ok) { sendResponse({ ok: false, error: '本地服务 HTTP ' + resp.status }); return }
        const data = await resp.json()
        sendResponse(data && data.taskId ? { ok: true, taskId: data.taskId } : { ok: false, error: (data && data.error) || '发起失败' })
      } catch (e) {
        sendResponse({ ok: false, error: '无法连接本地自检服务，请先跑 ux-audit-bridge/install.sh 安装启动：' + String(e && e.message || e) })
      }
    })()
    return true
  }
  // 「发散」：把截图 + 提示词交给本地桥，由它落盘并驱动 Variant。
  // 走 background 是因为页面 CSP 会拦 content script 直连 127.0.0.1。
  if (req && req.action === 'liaisonDivergeDispatch') {
    (async () => {
      try {
        const resp = await fetch('http://127.0.0.1:8765/variant/dispatch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.payload || {}),
        })
        if (!resp.ok) { sendResponse({ ok: false, error: '本地服务 HTTP ' + resp.status }); return }
        sendResponse(await resp.json())
      } catch (e) {
        sendResponse({ ok: false, error: '无法连接本地服务，请先跑 ux-audit-bridge/install.sh：' + String(e && e.message || e) })
      }
    })()
    return true
  }
  if (req && req.action === 'liaisonSelfAuditPoll') {
    (async () => {
      try {
        const resp = await fetch('http://127.0.0.1:8765/audit/result?taskId=' + encodeURIComponent(req.taskId || ''))
        if (!resp.ok) { sendResponse({ ok: false, error: '本地服务 HTTP ' + resp.status }); return }
        const data = await resp.json()
        sendResponse(data || { ok: false, error: '空响应' })
      } catch (e) {
        sendResponse({ ok: false, error: '轮询失败：' + String(e && e.message || e) })
      }
    })()
    return true
  }
  // 通用 kv get/set：与采集库共用同一个 IndexedDB store，但按调用方传入的 key
  // 存取，互不干扰、不做跨标签页广播。自检结果（liaison.selfaudit.last）用这对。
  if (req && req.action === 'liaisonKvGet') {
    liaisonDbGet(String(req.key || ''))
      .then(value => sendResponse({ ok: true, value }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }))
    return true
  }
  if (req && req.action === 'liaisonKvSet') {
    liaisonDbSet(String(req.key || ''), req.value)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }))
    return true
  }
  // IndexedDB-backed library get (with one-time migration from chrome.storage).
  if (req && req.action === 'liaisonInspDbGet') {
    liaisonMigrateFromLocal()
      .then(value => sendResponse({ ok: true, value }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }))
    return true
  }
  // IndexedDB-backed library set.
  if (req && req.action === 'liaisonInspDbSet') {
    // 数据最后守门员：拦截「把非空整库覆盖成空」的可疑写入。
    // 前端读全库失败时会静默降级成空库，若此空库被拿去覆盖磁盘会清空用户所有快照。
    // 只有源自一次成功读取的写（verified）才被允许把 snapshots 清到 0（用户真实删空）。
    // 未验证 + 新值 snapshots 为空 + 磁盘现有 snapshots 非空 → 拒绝，保住磁盘全量。
    const __incoming = req.value
    const __incomingSnaps = __incoming && Array.isArray(__incoming.snapshots) ? __incoming.snapshots : null
    const __verified = req.verified === true
    const __guard = (!__verified && (!__incomingSnaps || __incomingSnaps.length === 0))
      ? liaisonDbGet(LIAISON_LIB_KEY).then(cur => {
          const curLen = cur && Array.isArray(cur.snapshots) ? cur.snapshots.length : 0
          if (curLen > 0) {
            console.warn('[liaison-insp BG] 拒绝空覆盖：magic snapshots=0 (unverified) 但磁盘现有', curLen, '条，保留原数据')
            throw new Error('refuse empty overwrite: disk has ' + curLen + ' snapshots')
          }
          return true
        })
      : Promise.resolve(true)
    __guard
      .then(() => liaisonDbSet(LIAISON_LIB_KEY, req.value))
      .then(() => {
        // 镜像备份：主库落盘成功后并集更新备份。失败只告警（主库已安全写入）。
        liaisonBackupMerge(req.value).catch(e =>
          console.warn('[liaison-insp BG] 备份更新失败（主库已写入）:', String(e && e.message || e)))
        // 本地落地：把库镜像成磁盘文件（~/妙想灵感库），让数据不再只活在浏览器里。
        // 防抖 + 失败静默：这是旁路增强，绝不能拖累或阻断主库写入。
        liaisonScheduleLibraryMirror(req.value, __verified)
        sendResponse({ ok: true })
        // 跨标签页同步：写入成功后广播给其它标签页刷新采集库缓存。
        // 主通道：往 chrome.storage.local 写一个「版本信号」（只是个自增戳，不是整库）。
        //   storage.onChanged 对所有已注入内容脚本的页面可靠广播，不依赖点对点连接建立，
        //   比 tabs.sendMessage 稳（后者对未激活/跨源页面常报 no receiver）。
        // 兜底通道：仍对各 tab 发一次 tabs.sendMessage（对已激活页能即时送达）。
        try {
          const originTabId = sender && sender.tab && sender.tab.id
          const signal = { t: Date.now(), r: Math.random(), origin: originTabId == null ? null : originTabId }
          platform.storage.local.set({ liaisonInspLibVersion: signal }, () => {
            if (platform.runtime.lastError) console.warn('[liaison-sync BG] storage signal err', platform.runtime.lastError.message)
          })
        } catch (e) { console.warn('[liaison-sync BG] storage signal throw', e) }
        try {
          const originTabId = sender && sender.tab && sender.tab.id
          platform.tabs.query({}, (tabs) => {
            if (platform.runtime.lastError) return
            for (const t of tabs || []) {
              if (!t || t.id == null || t.id === originTabId) continue
              try {
                platform.tabs.sendMessage(t.id, { action: 'liaisonInspLibChanged' }, () => { void platform.runtime.lastError })
              } catch (e) {}
            }
          })
        } catch (e) {}
      })
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }))
    return true
  }
  // 镜像备份读取（救援/巡检用）。
  if (req && req.action === 'liaisonInspBackupGet') {
    liaisonDbGet(LIAISON_LIB_BACKUP_KEY)
      .then(value => sendResponse({ ok: true, value }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }))
    return true
  }
  // 从镜像备份整库还原主库（主库意外清空时的补救）。备份为空时拒绝，避免二次事故。
  if (req && req.action === 'liaisonInspBackupRestore') {
    liaisonDbGet(LIAISON_LIB_BACKUP_KEY)
      .then(bak => {
        if (!bak || !Array.isArray(bak.snapshots) || bak.snapshots.length === 0) {
          throw new Error('备份为空，无可恢复数据')
        }
        const clean = Object.assign({}, bak)
        delete clean.__backupUpdatedAt
        return liaisonDbSet(LIAISON_LIB_KEY, clean).then(() => bak.snapshots.length)
      })
      .then(n => sendResponse({ ok: true, restored: n }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }))
    return true
  }
  // Cross-origin CSS text bridge (A′ scheme for hover-state harvesting).
  //
  // Why: the content script harvests :hover / :focus rules by walking
  // document.styleSheets[].cssRules. For cross-origin stylesheets (e.g. a CDN
  // .css on hogee.baidu.com) the page's JS can't read .cssRules — the browser
  // throws SecurityError and the rules are silently skipped, so hover-state
  // interaction rules never reach the prompt. The background service worker,
  // however, can fetch() those URLs with the extension's host permissions
  // (<all_urls>), bypassing the page CORS restriction. Content script sends the
  // stylesheet href here, we return the raw CSS text for it to parse locally.
  // 手动触发一次全量落盘（首次启用、或想立刻同步时用）。
  // 手动全量落盘。正式入口是扩展图标的右键菜单「立即备份灵感库」（见下方
  // contextMenus 注册）——SW 控制台既发不了消息给自己、也调不到模块内的函数
  // （本文件是 ES module），别再往那条路上走。
  if (req && req.action === 'liaisonMirrorNow') {
    liaisonDbGet(LIAISON_LIB_KEY)
      .then(lib => liaisonMirrorLibrary(lib || { snapshots: [] }, true))
      .then(() => platform.storage.local.get(['liaisonLibraryMirrorRoot', 'liaisonLibraryMirrorCount']))
      .then(r => sendResponse({ ok: true, root: r && r.liaisonLibraryMirrorRoot, count: r && r.liaisonLibraryMirrorCount }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }))
    return true
  }

  // 更新弹窗的「立即更新」：转发到本地桥执行 ~/.miaoxiang/update.command。
  // 走 background 而非 content script 直连：页面 CSP 会挡 localhost 请求。
  // 更新耗时可达数分钟（拉取 + 依赖同步），这里给 10 分钟上限。
  if (req && req.action === 'liaisonSelfUpdate') {
    (async () => {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 600000)
        const resp = await fetch('http://127.0.0.1:8765/self-update', {
          method: 'POST', signal: ctrl.signal,
        })
        clearTimeout(timer)
        if (!resp.ok) { sendResponse({ ok: false, error: 'http ' + resp.status }); return }
        const data = await resp.json()
        if (data && data.ok) {
          // 关键：unpacked 扩展的文件只在「加载/重新加载」时读取，重启浏览器
          // 并不会重读磁盘。所以更新落盘后必须自己 reload，新版本才真正生效——
          // 否则用户得手动去 chrome://extensions 点刷新。
          // 先回响应再重载（reload 会立刻销毁 SW，消息通道随之断开）。
          sendResponse({ ok: true, message: data.message || '', reloading: true })
          setTimeout(() => { try { platform.runtime.reload() } catch (_) {} }, 600)
        } else {
          sendResponse({ ok: false, error: (data && data.error) || '更新失败' })
        }
      } catch (e) {
        const msg = String(e && e.message || e)
        // 区分「更新真失败」和「本地桥根本没跑」：后者是同事侧最常见的情况，
        // 笼统报「更新失败」会让人以为新版本有问题，其实只是缺个本地服务。
        // bridgeDown 让弹窗改说人话并给出可复制的自救命令。
        if (/abort/i.test(msg)) {
          sendResponse({ ok: false, error: '更新超时' })
        } else {
          sendResponse({ ok: false, bridgeDown: true, error: msg })
        }
      }
    })()
    return true
  }

  if (req && req.action === 'liaisonFetchCss') {
    (async () => {
      try {
        const url = String(req.url || '')
        console.log('[liaison-hover BG] fetch request url=', url)
        if (!/^https?:\/\//i.test(url)) {
          console.warn('[liaison-hover BG] bad url', url)
          sendResponse({ ok: false, error: 'bad url' })
          return
        }
        const resp = await fetch(url, { credentials: 'omit', redirect: 'follow' })
        if (!resp.ok) {
          console.warn('[liaison-hover BG] http', resp.status, url)
          sendResponse({ ok: false, error: 'http ' + resp.status })
          return
        }
        let text = await resp.text()
        // Cap to keep messaging payload sane; hover rules live early in most
        // sheets and this is a best-effort enrichment, not a full mirror.
        const MAX = 2_000_000
        if (text.length > MAX) text = text.slice(0, MAX)
        console.log('[liaison-hover BG] fetch OK len=', text.length, url)
        sendResponse({ ok: true, text })
      } catch (e) {
        console.warn('[liaison-hover BG] fetch threw', String(e && e.message || e), url)
        sendResponse({ ok: false, error: String(e && e.message || e) })
      }
    })()
    return true
  }
  // CDP collection bridge (hover state now; future capabilities via same action).
  // Page-world bundle can't reach chrome.debugger; content script forwards here.
  if (req && req.action === 'liaisonCdpCollect') {
    const tabId = sender && sender.tab && sender.tab.id
    ;(async () => {
      if (typeof tabId !== 'number') { sendResponse({ ok: false, error: 'no tabId' }); return }
      try {
        const result = await Promise.race([
          withCdpSession(tabId, s => collectViaCdp(s, req)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout')), 8000))
        ])
        console.log('[liaison-hover BG] cdpCollect ok', JSON.stringify(result).length, 'bytes')
        sendResponse({ ok: true, result })
      } catch (e) {
        // Idempotent safety detach: if the timeout race won, withCdpSession's
        // finally still detaches asynchronously; this second detach is a no-op
        // guard against any leak (already-detached → lastError, swallowed).
        try { platform.debugger.detach({ tabId }, () => { void platform.runtime.lastError }) } catch (_) {}
        console.warn('[liaison-hover BG] cdpCollect fail:', String(e && e.message || e))
        sendResponse({ ok: false, error: String(e && e.message || e) })
      }
    })()
    return true
  }
  if (req && req.action === 'liaisonInspCaptureVisibleTab') {
    try {
      platform.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 95 }, (dataUrl) => {
        const err = platform.runtime.lastError
        if (err || !dataUrl) {
          sendResponse({ ok: false, error: err ? err.message : 'empty dataUrl' })
          return
        }
        sendResponse({ ok: true, dataUrl })
      })
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) })
    }
    return true
  }
  // Download bridge: save the ref JPEG to disk and return the absolute path.
  // Lets the copied prompt reference the file by path instead of embedding a
  // ~100KB base64 heredoc that would otherwise dominate the prompt prefill.
  //
  // 用户体感：这个下载纯属实现细节（同名覆盖，磁盘上永远只有 1 个文件），但默认
  // 会弹下载气泡 + 在下载列表里堆历史条目，看起来像「模仿一次就存一张图」。所以
  // 落点收进 REF_DIR 子目录（B），下载完成后 erase 掉列表记录（A，文件保留），
  // 并在下载期间临时关掉下载 UI（A，需要 downloads.shelf 权限）。
  if (req && req.action === 'liaisonInspDownload') {
    try {
      const safeFilename = (typeof req.filename === 'string' && /^[A-Za-z0-9._-]+\.(jpe?g|png)$/i.test(req.filename))
        ? req.filename
        : 'liaison-ref.jpg'
      setDownloadUiEnabled(false)

      // 走一次下载并把结果回给调用方。withDir=false 是降级路径：某些平台会拒掉
      // 带非 ASCII 目录的 filename，那时宁可退回下载根目录，也不能让「模仿」整个
      // 失败——子目录只是整洁度，拿到 ref 路径才是功能本身。
      const start = (withDir) => {
        platform.downloads.download({
          url: req.dataUrl,
          filename: withDir ? (REF_DIR + '/' + safeFilename) : safeFilename,
          conflictAction: 'overwrite',
          saveAs: false
        }, (id) => {
          const err = platform.runtime.lastError
          if (err || typeof id !== 'number') {
            if (withDir) { start(false); return }
            setDownloadUiEnabled(true)
            sendResponse({ ok: false, error: err ? err.message : 'download start failed' })
            return
          }
          const onChanged = (delta) => {
            if (delta.id !== id) return
            if (delta.error && delta.error.current) {
              platform.downloads.onChanged.removeListener(onChanged)
              eraseDownloadRecord(id)
              if (withDir) { start(false); return }
              setDownloadUiEnabled(true)
              sendResponse({ ok: false, error: delta.error.current })
              return
            }
            if (delta.state && delta.state.current === 'complete') {
              platform.downloads.onChanged.removeListener(onChanged)
              // 顺序要紧：先 search 取到磁盘路径，再 erase 抹记录——反过来记录没了
              // 就查不到 filename，prompt 就拿不到 ref 路径。
              platform.downloads.search({ id }, (items) => {
                const path = items && items[0] && items[0].filename
                eraseDownloadRecord(id)
                setDownloadUiEnabled(true)
                if (path) {
                  sendResponse({ ok: true, path })
                } else {
                  sendResponse({ ok: false, error: 'no filename after complete' })
                }
              })
            }
          }
          platform.downloads.onChanged.addListener(onChanged)
        })
      }
      start(true)
    } catch (e) {
      setDownloadUiEnabled(true)
      sendResponse({ ok: false, error: String(e && e.message || e) })
    }
    return true
  }
})

// ---------------------------------------------------------------------------
// 采集库本地落地（镜像到 ~/妙想灵感库）
//
// 动机：库此前只活在扩展的 IndexedDB 里——卸载扩展、清浏览器数据、换电脑都会
// 丢光。镜像到磁盘后数据有了浏览器之外的载体；文件格式（一条快照一个 json +
// 一张图）同时是将来做团队同步的基础，届时只需换传输层。
//
// 纪律：整条链路是旁路增强，任何失败都只告警——绝不能影响采集本身。
// 防抖 5s：连续采集/编辑时合并成一次写盘，避免反复全量刷新文件 mtime。
// ---------------------------------------------------------------------------
let liaisonMirrorTimer = null
let liaisonMirrorPending = null

function liaisonScheduleLibraryMirror(lib, verified) {
  liaisonMirrorPending = { lib, verified: verified === true }
  if (liaisonMirrorTimer) clearTimeout(liaisonMirrorTimer)
  liaisonMirrorTimer = setTimeout(() => {
    liaisonMirrorTimer = null
    const job = liaisonMirrorPending
    liaisonMirrorPending = null
    if (!job || !job.lib) return
    liaisonMirrorLibrary(job.lib, job.verified).catch(() => {})
  }, 5000)
}

// 启动兜底：只靠「写库时触发」的话，老用户不采集新东西就永远不会落盘。
// 这里在扩展启动/安装时补一次判断——距上次落盘超过一天（或从未落过）就跑一次。
// 延迟 20s 执行：避开启动高峰，也给本地桥留出被 launchd 拉起来的时间。
async function liaisonMirrorOnStartup() {
  try {
    const r = await platform.storage.local.get('liaisonLibraryMirrorAt')
    const last = Number(r && r.liaisonLibraryMirrorAt) || 0
    if (Date.now() - last < 86400000) return // 一天内落过盘，不重复
    setTimeout(() => {
      liaisonDbGet(LIAISON_LIB_KEY)
        .then(lib => {
          const n = lib && Array.isArray(lib.snapshots) ? lib.snapshots.length : 0
          if (!n) return // 空库不写盘，避免在磁盘上留下无意义的空目录
          return liaisonMirrorLibrary(lib, true)
        })
        .catch(() => {})
    }, 20000)
  } catch (_) {}
}
platform.runtime.onStartup.addListener(liaisonMirrorOnStartup)
platform.runtime.onInstalled.addListener(liaisonMirrorOnStartup)

// 手动触发入口：扩展图标右键 →「立即备份灵感库」。
// 首次启用、或想立刻把库刷到磁盘时用；平时靠写库后的自动镜像即可。
function liaisonRunManualMirror() {
  liaisonDbGet(LIAISON_LIB_KEY)
    .then(lib => {
      const n = lib && Array.isArray(lib.snapshots) ? lib.snapshots.length : 0
      platform.action.setBadgeText({ text: '···' })
      platform.action.setBadgeBackgroundColor({ color: '#4D9FFF' })
      return liaisonMirrorLibrary(lib || { snapshots: [] }, true).then(() => n)
    })
    .then(async (n) => {
      const r = await platform.storage.local.get(['liaisonLibraryMirrorRoot', 'liaisonLibraryMirrorAt'])
      const ok = r && r.liaisonLibraryMirrorAt && Date.now() - r.liaisonLibraryMirrorAt < 180000
      platform.action.setBadgeText({ text: ok ? '✓' : '×' })
      platform.action.setBadgeBackgroundColor({ color: ok ? '#65FFB6' : '#FF6B6B' })
      platform.action.setTitle({
        title: ok ? `妙想：已备份 ${n} 条灵感到 ${r.liaisonLibraryMirrorRoot}`
                  : '妙想：备份失败——请确认本地服务在运行',
      })
      setTimeout(() => {
        platform.action.setBadgeText({ text: '' })
        platform.action.setTitle({ title: '点击或按 Alt+Shift+D 启动妙想' })
      }, 6000)
    })
    .catch(() => {
      platform.action.setBadgeText({ text: '×' })
      platform.action.setBadgeBackgroundColor({ color: '#FF6B6B' })
      setTimeout(() => platform.action.setBadgeText({ text: '' }), 6000)
    })
}

try {
  platform.runtime.onInstalled.addListener(() => {
    try {
      platform.contextMenus.removeAll(() => {
        platform.contextMenus.create({
          id: 'liaison-mirror-now',
          title: '立即备份灵感库到本地',
          contexts: ['action'],
        })
      })
    } catch (_) {}
  })
  platform.contextMenus.onClicked.addListener((info) => {
    if (info && info.menuItemId === 'liaison-mirror-now') liaisonRunManualMirror()
  })
} catch (_) {}

async function liaisonMirrorLibrary(lib, verified) {
  const snapshots = lib && Array.isArray(lib.snapshots) ? lib.snapshots : []
  if (!snapshots.length && !verified) return // 空且未验证：不碰磁盘
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 120000)
    const resp = await fetch('http://127.0.0.1:8765/library/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshots, verified }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) return
    const data = await resp.json()
    if (data && data.ok) {
      console.log('[liaison-mirror BG] 已落盘', data.root, '写入', data.written, '张图', data.shots, '墓碑', data.tombed)
      platform.storage.local.set({
        liaisonLibraryMirrorAt: Date.now(),
        liaisonLibraryMirrorRoot: data.root,
        liaisonLibraryMirrorCount: data.total,
      })
    }
  } catch (_) {} // 桥没跑 / 超时：静默，下次写库再试
}

// ---------------------------------------------------------------------------
// 版本更新检查（gist 广播源）
//
// 内部分发不走应用商店，没有自动更新。一个 public gist 上的 version.json
// 充当版本广播：background 定期拉取，与本地 manifest.version 比对，把结论
// 写进 chrome.storage.local；弱提醒是扩展图标上的 NEW 角标（本文件直接控制），
// 强提醒是工具栏注入时弹的更新弹窗（toolbar/update-modal.js 消费这里写的 key）。
//
// gist 字段：{ version, notifyFloor?, notes?, downloadUrl? }
//   - version:     最新版本号；远端 > 本地 → 亮角标
//   - notifyFloor: 弹窗门槛线；本地 < 门槛线 → 弹强提醒（缺失则只亮角标）
//   - notes:       弹窗要点列表（数组或换行字符串）
//   - downloadUrl: 「去更新」跳转的下载页（缺失则弹窗里提示找分发者要包）
//
// URL 由 scripts/update-version-gist.sh --init 建 gist 后自动回填（脚本与
// 本常量互相指认，换归属时两处一起改）。占位符未替换时整个检查静默跳过。
// ---------------------------------------------------------------------------
const LIAISON_VERSION_CHECK_URL = 'https://gist.githubusercontent.com/FengranZhou/8188dcc922649779087e924bf7f487a0/raw/version.json'

// 逐段数字比较，段数不齐按 0 补位。latest 严格大于 current 才算新。
// （字符串比较会把 "0.10.0" 判得比 "0.9.0" 小，必须转数字。）
function liaisonIsNewerVersion(latest, current) {
  const a = String(latest).split('.').map(Number)
  const b = String(current).split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0
    if (x !== y) return x > y
  }
  return false
}

function liaisonApplyUpdateBadge(available) {
  try {
    platform.action.setBadgeText({ text: available ? 'NEW' : '' })
    if (available) {
      platform.action.setBadgeBackgroundColor({ color: '#F53B3B' })
      if (platform.action.setBadgeTextColor) platform.action.setBadgeTextColor({ color: '#FFFFFF' })
    }
  } catch (_) {}
}

async function liaisonCheckForUpdate() {
  if (!LIAISON_VERSION_CHECK_URL.startsWith('https://')) return // --init 尚未回填
  try {
    // 时间戳绕 gist raw 的 ~5 分钟 CDN 缓存；直连不通（同事无代理的国内网络）
    // 时自动换 gh-proxy 镜像重试，保证角标/弹窗兜底信号不失效
    const url = `${LIAISON_VERSION_CHECK_URL}?t=${Date.now()}`
    let resp = null
    try { resp = await fetch(url, { cache: 'no-store' }) } catch (_) {}
    if (!resp || !resp.ok) {
      try { resp = await fetch(`https://gh-proxy.com/${url}`, { cache: 'no-store' }) } catch (_) { return }
    }
    if (!resp || !resp.ok) return
    const data = await resp.json()
    const latest = data && data.version
    if (!latest) return
    const current = platform.runtime.getManifest().version
    const available = liaisonIsNewerVersion(latest, current)
    const floor = (data && data.notifyFloor) || null
    await platform.storage.local.set({
      liaisonUpdateLatest: latest,
      liaisonUpdateAvailable: available,
      liaisonUpdateNotifyFloor: floor,
      // 弹窗资格在这里算掉（本地 < 门槛线），content 侧只做 storage 门闸，
      // 免得两边各养一份 isNewerVersion 漂移
      liaisonUpdateModalEligible: !!(available && floor && liaisonIsNewerVersion(floor, current)),
      liaisonUpdateNotes: (data && data.notes) || null,
      liaisonUpdateDownloadUrl: (data && data.downloadUrl) || null,
      liaisonUpdateLastCheckAt: Date.now(),
    })
    liaisonApplyUpdateBadge(available)
  } catch (_) {} // 网络失败静默，绝不影响主功能
}

// 点扩展图标时顺带查一次，30s 节流防连击
const LIAISON_UPDATE_THROTTLE_MS = 30 * 1000
async function liaisonMaybeCheckForUpdate() {
  try {
    const { liaisonUpdateLastCheckAt } = await platform.storage.local.get('liaisonUpdateLastCheckAt')
    if (Date.now() - (Number(liaisonUpdateLastCheckAt) || 0) < LIAISON_UPDATE_THROTTLE_MS) return
  } catch (_) {}
  return liaisonCheckForUpdate()
}

// ⚠️ MV3 service worker 会反复休眠唤醒，顶层无条件 alarms.create 等于每次唤醒
// 都取消重建、把每日周期清零重排，对活跃用户永远到不了触发点。先 get 再 create。
async function liaisonEnsureUpdateAlarm() {
  try {
    const existing = await platform.alarms.get('liaison-update-check')
    if (!existing) platform.alarms.create('liaison-update-check', { periodInMinutes: 1440 })
  } catch (_) {}
}

platform.runtime.onStartup.addListener(() => { liaisonCheckForUpdate(); liaisonEnsureUpdateAlarm() })
platform.runtime.onInstalled.addListener(() => { liaisonCheckForUpdate(); liaisonEnsureUpdateAlarm() })
platform.alarms.onAlarm.addListener((a) => {
  if (a.name === 'liaison-update-check') liaisonCheckForUpdate()
})
platform.action.onClicked.addListener(() => { liaisonMaybeCheckForUpdate() })

// 装错目录的防呆：用户容易直接从下载文件夹（miaoxiang-main/extension）加载扩展，
// 那份不受更新器管理，会永远停在下载当时的版本——「立即更新」看着成功实则不生效。
//
// 判定办法：更新器每次同步后会在受管目录写 install-tag.json（内含当前版本号）。
// 扩展用 runtime.getURL 读自己目录里的这个文件：
//   - 读不到           → 不是受管副本（下载文件夹那份没有该文件）→ 警告
//   - 版本对不上 manifest → 文件是旧的拷贝 → 同样警告
// 桥不在（没装/未启动）时不判定，避免误报。
async function liaisonCheckInstallPath() {
  try {
    const bridge = await fetch('http://127.0.0.1:8765/ping').catch(() => null)
    if (!bridge || !bridge.ok) return // 桥没跑，无从判定
    // 只在「这台机器确实通过安装器分发过」时才判定：作者机走源码、没有
    // ~/.miaoxiang，桥会回 managed:false，据此豁免（否则会把作者误判成错装）。
    const ping = await bridge.json().catch(() => null)
    if (!ping || ping.managed !== true) return

    const current = platform.runtime.getManifest().version
    let managed = false
    try {
      const tagResp = await fetch(platform.runtime.getURL('install-tag.json'))
      if (tagResp.ok) {
        const tag = await tagResp.json()
        managed = !!(tag && tag.managed)
      }
    } catch (_) {}

    await platform.storage.local.set({ liaisonInstallUnmanaged: !managed })
    if (!managed) {
      platform.action.setBadgeText({ text: '!' })
      platform.action.setBadgeBackgroundColor({ color: '#FFB84D' })
      platform.action.setTitle({
        title: '妙想：当前扩展是从下载文件夹加载的，不会自动更新。\n' +
               '请到 chrome://extensions 移除后，改从 ~/.miaoxiang/extension 重新加载。',
      })
    } else {
      // 复位：曾误报或用户已改正时，把告警痕迹清掉（角标交还给版本更新逻辑）
      platform.action.setTitle({ title: '点击或按 Alt+Shift+D 启动妙想' })
      const r = await platform.storage.local.get('liaisonUpdateAvailable')
      liaisonApplyUpdateBadge(!!(r && r.liaisonUpdateAvailable))
    }
    void current
  } catch (_) {}
}
liaisonCheckInstallPath()

// SW 唤醒时同步一次角标（badge 不跨 SW 生命周期持久，读 storage 恢复）
platform.storage.local.get('liaisonUpdateAvailable').then(
  (r) => liaisonApplyUpdateBadge(!!(r && r.liaisonUpdateAvailable)),
  () => {}
)
