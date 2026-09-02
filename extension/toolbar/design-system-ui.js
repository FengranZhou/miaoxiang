// ============================================================================
// 设计系统 · 组件面板（xiaoya3.0 设计规范）
// ----------------------------------------------------------------------------
// 面板「组件」tab 的全部渲染与交互。用户在真实页面上选好插入点位、从列表里挑
// 一个组件并填好配置 → 拼成一段 prompt → 复制 → 粘贴进下游项目的 CC 窗口 →
// 下游 CC 按设计规范落地。
//
// 架构（沿用 asset-library-ui.js 的模式，避免在 bundle.min.js 里手写大块 UI）：
// bundle 的 renderDesignPanel() 返回一个空挂载容器 `<div id="liaison-ds-root">`，
// 然后调用 window.__liaisonDesignUI.mount(rootEl, ctx)。本模块接管容器内的一切。
//
// 数据源：组件目录（catalog）随本文件内联（见 CATALOG）。它是 xiaoya 仓库
// scripts/component-catalog.mjs 的镜像——那边是给 node 脚本用的源头，这边是给
// 浏览器扩展用的投影。**改了源头要回来同步**，否则会长出"规范说 A、面板说 B"
// 的裂缝。将来接上本地桥服务后可改为运行时拉取，届时本内联副本即可退役。
//
// 交互要点：
//  - 三步流程（选组件 → 选点位 → 填配置），用返回箭头回退，不做多层弹窗。
//  - 点位拾取复用页面 hover 高亮：鼠标移动时实时描边候选容器 + 画插入指示线。
//  - 配置表单字段来自 catalog 的 fields，不是 EP 全量 props——只问"必须当场决定"的。
//  - 中文输入法：搜索框监听 composition 事件，组合中不触发重绘（吸取资产库教训）。
// ============================================================================

;(function () {
  if (typeof window === 'undefined' || window.__liaisonDesignUI) return

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))

  // ══════════════════════════════════════════════════════════════════════════
  // 组件目录（xiaoya scripts/component-catalog.mjs 的镜像，改源头需同步）
  // ══════════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════════
  // 组件目录：从 GitHub 拉取，不再内联副本
  // --------------------------------------------------------------------------
  // 之前这里内联了一份 catalog 手抄副本，改了源头不改它两边就漂——正是设计系统
  // 「改一处 = 扫全部引用」纪律要防的裂缝。现在改为运行时拉取：
  //
  //   仓库跑 build-catalog.mjs → catalog.json → push → 扩展 fetch raw URL
  //
  // 这样同事装了扩展就能用最新版，**不需要本地有这个仓库**（他们也不可能有）。
  // 拉取走 background（扩展 host 权限，不受页面 CSP 约束），结果存 chrome.storage，
  // 面板打开时自动后台更新一次；拉不到就用上次缓存，首次且无网络则给出提示。
  // ══════════════════════════════════════════════════════════════════════════

  const CATALOG_URL =
    'https://raw.githubusercontent.com/FengranZhou/design-system/main/scripts/catalog.json'
  const TOKENS_URL =
    'https://raw.githubusercontent.com/FengranZhou/design-system/main/scripts/design-tokens.json'

  let GROUPS = []
  let CATALOG = []
  let TOKENS = null  // 设计令牌：{ semanticColors, fontScale, spacing, radius }

  /**
   * snippet 在 JSON 里是源码字符串（函数没法 JSON 序列化），这里还原成函数。
   * 用 Function 构造而非 eval：作用域干净，拿不到本模块的闭包变量。
   * 还原失败不阻断——该组件仍可用，只是复制出的 prompt 少一段代码骨架。
   */
  function reviveSnippet(src) {
    if (!src) return null
    try {
      return new Function('return (' + src + ')')()
    } catch (e) {
      return null
    }
  }

  function applyCatalog(data) {
    if (!data || !Array.isArray(data.components)) return false
    GROUPS = data.groups || []
    CATALOG = data.components.map(function (c) {
      return {
        id: c.id, name: c.name, group: c.group, desc: c.desc,
        keywords: c.keywords || [], fields: c.fields || [],
        readRefs: c.readRefs || [], mustRules: c.mustRules || [],
        snippet: reviveSnippet(c.snippetSrc),
        // snippet 的兜底取值：snippet 读得到、但**不进配置面板**的那些 key
        // （如 Button 的 type、Tag 的语义）。不铺这层，未填的键会渲染成
        // `type="undefined"` —— 不报错、粘到下游照样编译，只有逐字看才发现。
        snippetDefaults: c.snippetDefaults || {},
        // 组件示意图（base64 webp，随 catalog 一起下发）。
        // ⚠️ 这里是逐字段重建对象，不是浅拷贝 —— 新增字段必须在这里显式
        // 列出来，否则它到不了渲染层（曾漏掉这行，列表里全是灰色占位图）。
        shot: c.shot || null,
        // 变体的父组件 anchor（如「文本域」的 variantOf 是 input）。
        // 变体在 demo 导航里没有自己的行，靠这个字段溯源到父组件。
        variantOf: c.variantOf || null,
      }
    })
    return true
  }

  /** 经 background 读写扩展 storage（page world 拿不到 chrome.*） */
  function bridge(action, payload) {
    return new Promise(function (resolve) {
      const id = 'ds-' + action + '-' + Math.random().toString(36).slice(2)
      const onMsg = function (ev) {
        const d = ev.data
        if (!d || d._liaisonInspBridgeReply !== true || d.id !== id) return
        window.removeEventListener('message', onMsg)
        resolve(d.ok ? d.result : null)
      }
      window.addEventListener('message', onMsg)
      window.postMessage({ _liaisonInspBridge: true, id: id, action: action, payload: payload || {} }, '*')
      setTimeout(function () { window.removeEventListener('message', onMsg); resolve(null) }, 8000)
    })
  }

  /** 拉最新 catalog；失败返回 null（调用方决定用缓存还是报错） */
  async function fetchCatalog() {
    const text = await bridge('fetchCss', { url: CATALOG_URL + '?t=' + Date.now() })
    if (!text) return null
    try { return JSON.parse(text) } catch (e) { return null }
  }

  /** 拉最新 design tokens；失败返回 null */
  async function fetchTokens() {
    const text = await bridge('fetchCss', { url: TOKENS_URL + '?t=' + Date.now() })
    if (!text) return null
    try { return JSON.parse(text) } catch (e) { return null }
  }

  /**
   * 载入目录：先用缓存立即渲染（不阻塞界面），再后台拉最新。
   * 缓存也没有时才等网络——那是首次使用的情况。
   */
  async function loadCatalog() {
    const cached = await bridge('kvGet', { key: 'liaison.ds.catalog' })
    let hasData = false
    if (cached) { hasData = applyCatalog(cached); if (hasData) render() }

    const fresh = await fetchCatalog()
    if (fresh && applyCatalog(fresh)) {
      state.syncedAt = Date.now()
      state.syncError = ''
      bridge('kvSet', { key: 'liaison.ds.catalog', value: fresh })
      render()
    } else if (!hasData) {
      state.syncError = '无法获取组件库（检查网络）'
      render()
    } else {
      state.syncError = ''
    }
  }

  /** 载入设计令牌（同 catalog 策略：先用缓存，后台拉最新） */
  async function loadTokens() {
    const cached = await bridge('kvGet', { key: 'liaison.ds.tokens' })
    if (cached) {
      TOKENS = cached
      // 加载缓存后立即触发一次输入框增强
      enhanceStylePanelInputs()
    }

    const fresh = await fetchTokens()
    if (fresh) {
      TOKENS = fresh
      bridge('kvSet', { key: 'liaison.ds.tokens', value: fresh })
      // 拉取最新数据后再触发一次
      enhanceStylePanelInputs()
    }
  }

  /**
   * 对当前样式面板的输入框执行一次增强（注入 token 按钮）
   */
  /**
   * 全量重扫：清掉旧按钮 → 按当前面板里的输入框重新长一批。
   *
   * 为什么是「清空重建」而不是「只补新的」：宿主 renderPanel() 每次选中新元素
   * 都把整个 shadow 重写一遍，旧 input 全成孤儿节点。靠 data-* 标记去增量识别
   * 是行不通的 —— 标记随节点一起没了，而我们的按钮活在自己的浮层里不会自动消失。
   * 面板里的输入框满打满算二十来个，全量重建的开销可以忽略。
   */
  function enhanceStylePanelInputs() {
    if (!TOKENS) return

    // 面板不存在时无事可做：按钮长在面板 shadow 里，随面板一起消失
    const panel = document.querySelector('liaison-style-panel')
    if (!panel) {
      // 样式面板整个没了，开着的选择面板不该留成孤魂
      if (activePicker) {
        activePicker.remove()
        hideSceneTip()
        activePicker = null
      }
      return
    }

    const root = panel.shadowRoot || panel
    if (!root) return

    const wanted = []
    root.querySelectorAll('input').forEach(function (input) {
      const type = detectInputType(input)
      if (type) wanted.push({ input: input, type: type })
    })

    // 语义字阶的统一入口：挂在「字体」区块的标题行（不是某个输入框）。
    // 语义字阶是复合令牌，选一条要同步写字重/字号/行高/字族四个字段，
    // 归属整个字体区块而非任何单项。
    const fontTitle = findFontSectionTitle(root)
    if (fontTitle) wanted.push({ input: fontTitle, type: 'fontComposite' })

    // 输入框集合没变就什么都不做 —— 按钮在容器里随布局走，位置不需要维护。
    // 宿主面板的 mutation 远多于「输入框真的换了」（hover 信息行、面包屑都在变），
    // 无差别清空重建会让按钮消失一帧再出现，表现为闪动。
    const existing = Array.prototype.slice.call(
      root.querySelectorAll('.liaison-ds-token-btn'))
    const same = existing.length === wanted.length &&
      existing.every(function (b, i) { return b.__dsInput === wanted[i].input })
    if (same) {
      restoreActivePicker(root)
      return
    }

    clearTokenBtns(root)
    wanted.forEach(function (w) { injectTokenButton(w.input, w.type) })
    restoreActivePicker(root)
  }

  /**
   * 把被宿主重写「误杀」的选择面板捞回来。
   *
   * 宿主 hover / 选中元素时会整段重写 shadow（见 enhanceStylePanel 注释），
   * 挂在 shadow 顶层的选择面板会连带被销毁 —— 表现为鼠标从入口按钮移向
   * 面板的途中面板突然消失，hover 宽限（250ms）根本没轮到生效。
   *
   * 本函数在每次重扫（microtask，渲染前）里执行：只要面板不是用户主动关的
   * （doClose / 选中值都会清 activePicker），且原锚点位置上还长着同一颗
   * 触发按钮（说明面板内容没换成别的元素），就把它 re-append 回去，并把
   * hover 生命周期监听补到新一代按钮上（旧按钮已随重写销毁，监听跟着没了）。
   * 锚点上找不到按钮 = 宿主真的换了内容（选中了别的元素），此时放它走。
   */
  function restoreActivePicker(root) {
    if (!activePicker) return
    const trig = activePicker.__dsTrigger
    if (activePicker.isConnected && trig && trig.isConnected) return

    const anchor = activePicker.__dsAnchorRect
    let newTrig = null
    if (anchor) {
      root.querySelectorAll('.liaison-ds-token-btn').forEach(function (b) {
        const r = b.getBoundingClientRect()
        if (Math.abs(r.left - anchor.left) < 2 &&
            Math.abs(r.top - anchor.top) < 2) newTrig = b
      })
    }
    if (!newTrig) {
      activePicker.remove()
      hideSceneTip()
      activePicker = null
      return
    }
    if (!activePicker.isConnected) root.appendChild(activePicker)
    if (newTrig !== trig) {
      activePicker.__dsTrigger = newTrig
      newTrig.addEventListener('mouseenter', activePicker.__dsCancelClose)
      newTrig.addEventListener('mouseleave', activePicker.__dsScheduleClose)
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Prompt 拼装（xiaoya scripts/build-prompt.mjs 的镜像）
  // ══════════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════════
  // 落点拾取：在真实页面上选插入位置
  // ══════════════════════════════════════════════════════════════════════════

  // 页面上的高亮层（描边候选元素 + 画插入指示线）。用 fixed 定位的独立 DOM，
  // 不进宿主页布局流，避免影响页面本身。
  let pickLayer = null
  let pickOutline = null
  let pickLine = null
  let pickLabel = null

  function ensurePickLayer() {
    if (pickLayer && pickLayer.isConnected) return
    pickLayer = document.createElement('div')
    pickLayer.setAttribute('data-liaison-ds-pick', '')
    pickLayer.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;'
    pickOutline = document.createElement('div')
    pickOutline.style.cssText =
      'position:absolute;border:1px solid rgba(35,178,131,.9);background:rgba(35,178,131,.06);' +
      'border-radius:4px;transition:all .08s ease;display:none;'
    pickLine = document.createElement('div')
    pickLine.style.cssText =
      'position:absolute;height:2px;background:#23b283;border-radius:2px;display:none;' +
      'box-shadow:0 0 0 2px rgba(35,178,131,.2);'
    pickLabel = document.createElement('div')
    pickLabel.style.cssText =
      'position:absolute;padding:5px 12px;background:#0F1B26;color:#fff;font-size:14px;' +
      'line-height:20px;border-radius:999px;white-space:nowrap;display:none;' +
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;'
    pickLayer.appendChild(pickOutline)
    pickLayer.appendChild(pickLine)
    pickLayer.appendChild(pickLabel)
    document.documentElement.appendChild(pickLayer)
  }

  // ── 抑制宿主的 hover 反馈 ──────────────────────────────────────────────
  //
  // 打点态下鼠标扫过页面时，宿主 selectorEngine 会给候选元素套一层
  // <liaison-hover>（紫色描边，--neon-purple）+ <liaison-label>。它服务的是
  // 「选中元素改样式」那套流程，而组件模式只记坐标、不认 DOM 元素
  // （见 startPicking 上方注释），那圈紫框指着的东西跟标记结果无关，
  // 纯属噪音 —— 用户以为自己在选那个元素，实际点下去只记了个坐标。
  //
  // 为什么用 CSS 藏而不去关它：hover 由宿主 mousemove 在
  // workspace_mode==='design' 时创建，而组件模式只换了 _featureTab、
  // workspace_mode 仍是 design。要从根上关掉得改 bundle.min.js 里的
  // selectorEngine —— 那是宿主的既有行为，别的模式还在用。挂一个带
  // 打点态标志的 html class 藏掉即可：退出打点自动恢复，宿主逻辑一行不动。
  const HIDE_HOST_HOVER_CLASS = 'liaison-ds-nohover'
  let hostHoverStyleEl = null

  function ensureHostHoverStyle() {
    if (hostHoverStyleEl && hostHoverStyleEl.isConnected) return
    hostHoverStyleEl = document.createElement('style')
    hostHoverStyleEl.setAttribute('data-liaison-ds-nohover', '')
    // liaison-label 一起藏：它是那圈框上的标签（元素名 + 尺寸），同一套反馈。
    // 排除带 liaison-drag-container 的 —— 那是拖拽边界，不是 hover 反馈。
    hostHoverStyleEl.textContent =
      'html.' + HIDE_HOST_HOVER_CLASS + ' liaison-hover:not([liaison-drag-container]),' +
      'html.' + HIDE_HOST_HOVER_CLASS + ' liaison-label[data-label-id="hover"]' +
      '{display:none !important;}'
    document.documentElement.appendChild(hostHoverStyleEl)
  }

  function hideHostHover() {
    ensureHostHoverStyle()
    document.documentElement.classList.add(HIDE_HOST_HOVER_CLASS)
  }

  function showHostHover() {
    document.documentElement.classList.remove(HIDE_HOST_HOVER_CLASS)
  }

  function removePickLayer() {
    if (pickLayer && pickLayer.parentNode) pickLayer.parentNode.removeChild(pickLayer)
    pickLayer = null; pickOutline = null; pickLine = null; pickLabel = null
  }

  /** 元素的可见文本（截断，用于给 CC 描述"上方是什么、下方是什么"） */
  function visibleText(el) {
    if (!el) return ''
    let t = ''
    try { t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() } catch (e) {}
    return t.length > 24 ? t.slice(0, 24) + '…' : t
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 就地浮层：打完点在原地选组件、配参数
  // --------------------------------------------------------------------------
  // 为什么不放侧边栏：打点时眼睛盯着页面，跑去侧边栏选组件要来回跳视线，
  // 而且选完还得再回页面确认位置对不对。就地弹层让整个动作在一处完成。
  // 配置项多的组件（Input 5 项、Dialog 6 项）靠最大高度 + 内部滚动兜住，
  // 不做「回面板配置」的分支——多一条路径就多一份认知负担。
  // ══════════════════════════════════════════════════════════════════════════

  let popEl = null
  let popPin = null
  let popQuery = ''
  let popComposing = false

  /**
   * 这次按键是不是正落在输入法的合成过程里？
   *
   * 中文输入法开着候选窗时，Enter / 数字 / 方向键全都是**给输入法用的**：
   * Enter 是「就要第一个候选」，方向键是翻页。此时我们再去 preventDefault
   * 把它当成「确认选中的组件」，用户打「/tab」想选「tab」这个词，结果直接
   * 跳进了组件配置视图，文本框里还留着没上屏的拼音。
   *
   * 判据取三个来源的并集，单独任何一个都不够可靠：
   *   - e.isComposing：标准字段，但 Safari 的部分输入法路径不给
   *   - popComposing：我们自己在 compositionstart/end 之间维护的标记
   *   - keyCode === 229：合成期间浏览器统一上报的「处理中」键码，
   *     某些输入法（如 macOS 拼音）在 isComposing 之外只留这一个线索
   */
  function isComposingKey(e) {
    return !!(e && (e.isComposing || popComposing || e.keyCode === 229))
  }

  // 垃圾桶图标：给「删除」按钮用。有了图形，这个按钮就不必靠边框来表明
  // 自己是按钮，从而能跟右边两个实心框在形状上区分开（见 .dsp-foot .del）。
  const ICON_TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2.5 4.5h11M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5"/>' +
    '<path d="M4 4.5l.6 8a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8"/>' +
    '<path d="M6.6 7v4M9.4 7v4"/></svg>'

  // 面板样式：全部走 ui-tokens.js 的 CSS 变量（--lz-*），不写裸值。
  // 变量的供给端是 ensurePopStyle() 里的 __liaisonUITokens.ensure()——它把令牌铺成
  // :root 上的自定义属性。**这里每加一个 var(--lz-x) 都要确认 ui-tokens.js 导出了 x**，
  // 否则 CSS 静默失效（整条声明被丢弃，浮层会裸成没底色没描边的样子）。
  // 改令牌 → 这里跟着变，规范和实现不会漂移。
  const POP_CSS = `
    .dsp{position:absolute;z-index:var(--lz-z-panel);width:340px;
      border-radius:var(--lz-r-lg);
      background:var(--lz-c-surface);border:1px solid var(--lz-c-line);
      box-shadow:var(--lz-sh-lg);color:var(--lz-c-text);
      font:var(--lz-f-body);
      display:flex;flex-direction:column;max-height:min(460px,74vh);overflow:hidden;}
    /* 底部内边距用 sm 而不是 xs：xs(4px) 是「图标贴文字」那一档，
       标题与下方输入框是两个层级，4px 会读成粘在一起。 */
    .dsp-head{flex:0 0 auto;display:flex;align-items:center;gap:var(--lz-s-sm);
      padding:var(--lz-s-sm) var(--lz-s-md);}
    /* .dsp-n（编号徽标）已删：标题不再重复编号 —— 页面上的蓝色标记本身带着 ①，
       面板正指着它，同一个数字在相距 20px 的两处出现两遍没有信息量。 */
    .dsp-title{flex:1 1 auto;font:var(--lz-f-title);overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap;}
    .dsp-x{flex:0 0 auto;width:18px;height:18px;line-height:17px;text-align:center;
      border-radius:var(--lz-r-sm);color:var(--lz-c-text-weak);cursor:pointer;font-size:14px;
      transition:background var(--lz-m-fast),color var(--lz-m-fast);}
    .dsp-x:hover{background:var(--lz-c-line);color:var(--lz-c-text);}

    /* 描述输入区：contenteditable 而非 textarea —— 组件芯片要内联在文字中间 */
    .dsp-ed{flex:0 0 auto;margin:0 var(--lz-s-md);
      padding:var(--lz-s-sm) var(--lz-s-sm);min-height:64px;max-height:150px;
      overflow-y:auto;overscroll-behavior:contain;border-radius:var(--lz-r-md);border:1px solid var(--lz-c-line);
      background:var(--lz-c-surface-raised);font:var(--lz-f-body);line-height:1.85;
      color:var(--lz-c-text);outline:none;white-space:pre-wrap;word-break:break-word;
      transition:border-color var(--lz-m-fast),background var(--lz-m-fast);}
    /* focus 走 line-strong（白描边提亮一档）而不是 primary —— 聚焦只是「光标在这」，
       不是操作按钮。薄荷绿框太抢眼，且会与真正的主操作（复制到 CC）撞语义。 */
    .dsp-ed:focus{border-color:var(--lz-c-line-strong);}
    /* placeholder 不用 :empty —— contenteditable 里把字删光后 DOM 常残留一个
       <br> 或空文本节点，:empty 就不再成立，暗提示回不来（用户报的现象）。
       改由 syncEditor 按「纯文本是否为空」打 data-empty，判据与 popPin.text 一致。 */
    .dsp-ed[data-empty]::before{content:attr(data-ph);color:var(--lz-c-text-disabled);
      pointer-events:none;}
    /* 组件芯片：不可编辑的整体，退格键一次删掉整个 */
    /* 高度钉死 28px = 页脚按钮（.dsp-foot button）同高。芯片是这个面板里
       真正被操作的对象，不该比按钮矮一截；height 显式给，否则它的高度会被
       .dsp-ed 的 line-height:1.85 牵着走，字号一变高度就漂。
       vertical-align 改 middle：28px 的块按 baseline 对齐会压低整行行高。
       右内边距仍比左小一档：右端那枚齿轮自带 20px 命中盒（内含留白），
       左右给一样的 8px 会让右边看着空出一块、文字偏左。 */
    .dsp-chip{display:inline-flex;align-items:center;gap:var(--lz-s-xxs);
      height:28px;box-sizing:border-box;
      vertical-align:middle;padding:0 var(--lz-s-xs) 0 var(--lz-s-sm);margin:0 1px;
      border-radius:var(--lz-r-md);background:var(--lz-c-primary-weak);
      border:1px solid var(--lz-c-primary);color:var(--lz-c-text);
      font:var(--lz-f-body);line-height:1;white-space:nowrap;user-select:none;}
    .dsp-chip[data-on]{background:var(--lz-c-primary);border-color:var(--lz-c-primary);
      color:var(--lz-c-primary-ink);}
    /* 芯片上的齿轮。字号 17px、命中盒 20×20。
       盒是 20 的话字形得留一点余量，line-height:1 下字号等于盒高会把
       ⚙ 的轮廓顶到边界外（这类符号字形本身偏满）。
       opacity .85：图标比原来大，.72 的虚在大面积上更显灰。
       × 已从 chipHtml() 去掉，.dsp-chip-g[data-chip-del] 同时删。 */
    .dsp-chip-g{opacity:.85;cursor:pointer;font-size:17px;line-height:1;
      width:20px;height:20px;flex:0 0 auto;
      display:inline-flex;align-items:center;justify-content:center;
      border-radius:var(--lz-r-sm);
      transition:opacity var(--lz-m-fast),background var(--lz-m-fast);}
    .dsp-chip-g:hover{opacity:1;background:rgba(255,255,255,.16);}

    /* .dsp-bar / .dsp-bar-hint 已删：输入框下面那条「输入 / 可插入设计系统组件」
       与标题讲的是同一件事，而且蹲在视线最后才到的右下角。说明并进了标题。
       .dsp-add（虚线「＋ 插入组件」按钮）在更早一轮就没有使用者了，一并清掉。 */

    /* 组件选择 / 配置：从底部滑出的抽屉，盖住输入区 */
    .dsp-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
      padding:var(--lz-s-xs) var(--lz-s-md) var(--lz-s-md);}
    .dsp-search{flex:0 0 auto;padding:var(--lz-s-xs) var(--lz-s-md) var(--lz-s-xs);}
    .dsp-search input{width:100%;box-sizing:border-box;height:28px;padding:0 var(--lz-s-sm);
      border-radius:var(--lz-r-sm);border:1px solid var(--lz-c-line);
      background:var(--lz-c-surface-raised);color:var(--lz-c-text);font:var(--lz-f-body);
      outline:none;transition:border-color var(--lz-m-fast);}
    .dsp-search input:focus{border-color:var(--lz-c-line-strong);}
    .dsp-search input::placeholder{color:var(--lz-c-text-disabled);}
    .dsp-group{margin-top:var(--lz-s-xs);font:var(--lz-f-small);
      color:var(--lz-c-text-weak);padding:0 2px var(--lz-s-xxs);}
    .dsp-item{padding:var(--lz-s-xs) var(--lz-s-sm);border-radius:var(--lz-r-sm);
      cursor:pointer;border:1px solid transparent;transition:all var(--lz-m-fast);}
    .dsp-item:hover{background:var(--lz-c-surface-raised);border-color:var(--lz-c-line);}
    .dsp-item-n{font:var(--lz-f-bodyStrong);}
    .dsp-item-d{font:var(--lz-f-small);color:var(--lz-c-text-weak);}
    .dsp-empty{padding:var(--lz-s-lg) 0;text-align:center;
      color:var(--lz-c-text-disabled);font:var(--lz-f-small);}

    /* 每个配置项一张卡片。原先只靠 margin-bottom 隔开，字段一多（标签 + 输入框
       + 建议值 + 提示四行）就分不清哪几行属于同一项 —— 卡片把归属画出来。
       .dsp-f 只在配置浮层里出现（主面板的配置视图已拆走），改这里不影响别处。 */
    .dsp-f{margin-bottom:var(--lz-s-sm);
      padding:var(--lz-s-sm);border-radius:var(--lz-r-md);
      background:var(--lz-c-surface-raised);
      border:1px solid var(--lz-c-line-subtle);}
    .dsp-f:last-child{margin-bottom:0;}
    .dsp-f-l{display:block;font:var(--lz-f-small);color:var(--lz-c-text-sub);
      margin-bottom:var(--lz-s-xxs);}
    /* 单行布局：标签在左、控件在右，与开关那一行（.dsp-sw）同一个骨架。
       用于 select —— 下拉的取值是「从固定几项里挑一个」，和开关是同一类
       「选状态」的操作，没有理由比开关多占一行。
       文本 / 数字输入仍是上下两行：那类要输入任意内容，挤到右半边不够宽。 */
    .dsp-row{display:flex;align-items:center;justify-content:space-between;
      gap:var(--lz-s-sm);}
    /* 单行里的标签不再是块级、也不带下边距 —— 那是两行布局的规格。
       .dsp-sw 一并管：开关那一行同样是「标签左、控件右」，
       原先靠内联 style="margin:0" 压掉下边距，规格挪到这里统一给。 */
    .dsp-row .dsp-f-l,.dsp-sw .dsp-f-l{display:inline;margin:0;flex:0 0 auto;}
    /* 控件占右半边：给 min-width 保证选项文字不被挤成省略号，
       同时 max-width 让长标签也有地方待。 */
    .dsp-row select{flex:1 1 auto;min-width:100px;max-width:62%;}
    /* 输入框底色改 sunken：卡片已经占了 surface-raised，控件再用同一档
       两者会糊成一块，看不出哪里能打字。凹陷一层刚好反过来。 */
    .dsp-f input[type=text],.dsp-f input[type=number],.dsp-f select{width:100%;
      box-sizing:border-box;height:26px;padding:0 var(--lz-s-sm);
      border-radius:var(--lz-r-sm);
      border:1px solid var(--lz-c-line);background:var(--lz-c-surface-sunken);
      color:var(--lz-c-text);font:var(--lz-f-body);outline:none;
      transition:border-color var(--lz-m-fast);}
    .dsp-f select option{background:var(--lz-c-surface);}
    .dsp-f input:focus,.dsp-f select:focus{border-color:var(--lz-c-line-strong);}
    .dsp-sug{display:flex;flex-wrap:wrap;gap:var(--lz-s-xxs);margin-top:var(--lz-s-xxs);}
    /* 底色同样改 sunken，理由同输入框：这些药丸现在坐在卡片上，
       用 surface-raised 会与卡片底色相同、只剩描边撑着。 */
    .dsp-sug button{height:20px;padding:0 var(--lz-s-sm);border-radius:var(--lz-r-pill);
      font:var(--lz-f-small);cursor:pointer;
      border:1px solid var(--lz-c-line);background:var(--lz-c-surface-sunken);
      color:var(--lz-c-text-sub);white-space:nowrap;transition:all var(--lz-m-fast);}
    .dsp-sug button:hover{background:var(--lz-c-line);color:var(--lz-c-text);}
    .dsp-sug button.on{background:var(--lz-c-primary-weak);
      border-color:var(--lz-c-primary);color:var(--lz-c-text);}
    /* 开关型字段：热区是整张卡片（.dsp-f-sw），含 hint 那一行。
       卡片就是这个开关的可视边界，里面任何位置都该能点 —— 包括说明文字。
       上一版把热区做在 .dsp-sw（只有标签+轨道那一行）上，靠负外边距铺满卡片，
       结果带 hint 的卡片下半部点不动：视觉是一整张卡，可点范围却只有上半。
       现在 data-dsp-sw 直接挂 .dsp-f，负边距那套不再需要。
       .dsp-sw 退回纯排版（标签左、轨道右），.dsp-sw-t 也不带 cursor ——
       整卡都是热区，没有哪个子元素是「唯一能点的位置」。 */
    .dsp-f-sw{cursor:pointer;transition:background var(--lz-m-fast);}
    .dsp-f-sw:hover{background:rgba(255,255,255,.10);}
    .dsp-sw{display:flex;align-items:center;justify-content:space-between;
      gap:var(--lz-s-sm);}
    .dsp-sw-t{width:30px;height:18px;border-radius:var(--lz-r-pill);
      background:var(--lz-c-line-strong);
      position:relative;transition:background var(--lz-m-fast);flex:0 0 auto;}
    /* on 态轨道 = 品牌绿 40% 透明（设计确认）。用 color-mix 从令牌现算，
       不另写一个 rgba 裸值 —— 改 --lz-c-primary 这里跟着变。
       透下来的深色面板底把绿压暗一档，白滑块因此有了对比。 */
    .dsp-sw-t.on{background:color-mix(in srgb, var(--lz-c-primary) 40%, transparent);}
    /* 滑块两态都是白色（设计确认）：与 el-switch 一致，白圆点是开关这个控件的
       固定长相，换色会读成另一种控件。 */
    .dsp-sw-b{position:absolute;top:2px;left:2px;width:14px;height:14px;
      border-radius:var(--lz-r-pill);
      background:#fff;transition:transform var(--lz-m-fast);}
    .dsp-sw-t.on .dsp-sw-b{transform:translateX(12px);}
    .dsp-hint{margin-top:var(--lz-s-xxs);font:var(--lz-f-small);
      color:var(--lz-c-text-weak);}
    /* 紧跟单行布局（开关 / 下拉）的说明文字给 4px：2px 是「同一控件的附属」
       那一档，而这里上面是一整行控件，隔太近会读成行内的第二段文字。
       两行布局（文本 / 数字）不动 —— 那里 hint 紧贴的是输入框，2px 正合适。 */
    .dsp-sw + .dsp-hint,.dsp-row + .dsp-hint{margin-top:var(--lz-s-xs);}
    /* .dsp-sub 已删：它是主面板配置视图里放「返回」的那一行，配置搬去
       独立浮层（.dsp-cfg）后没有使用者了。
       .dsp-back 还留着 —— 配置浮层的页脚在用它。
       高度/字阶与 .dsp-foot button 同规格：配置浮层的「返回」和主面板页脚的
       「完成 / 复制到 CC」同时可见，规格不一致会读成两套控件。 */
    .dsp-back{height:28px;padding:0 var(--lz-s-md);border-radius:var(--lz-r-sm);
      font:var(--lz-f-body);cursor:pointer;
      border:1px solid var(--lz-c-line);background:var(--lz-c-surface-raised);
      color:var(--lz-c-text-sub);transition:all var(--lz-m-fast);}
    .dsp-back:hover{background:var(--lz-c-line);color:var(--lz-c-text);}

    /* border-top 已去掉：按钮本身自带描边和实心底，形状已经把「这是操作区」
       说清楚了，再加一条横线是第二次说同一件事。分隔靠留白。
       留白量对齐配置浮层：那边是 .dsp-cfg-bd 下 8 + .dsp-cfg-ft 上 4 = 12px，
       这里 margin 8 + padding 上 4 = 12px。两块浮层前后脚出现，同一处缝隙
       给不同的值会看出来（原先这里是 20px，比下面明显松一档）。 */
    .dsp-foot{flex:0 0 auto;margin-top:var(--lz-s-sm);
      padding:var(--lz-s-xs) var(--lz-s-md) var(--lz-s-sm);
      display:flex;gap:var(--lz-s-sm);}
    .dsp-foot button{flex:1 1 0;height:28px;border-radius:var(--lz-r-sm);
      font:var(--lz-f-body);cursor:pointer;
      border:1px solid var(--lz-c-line);background:var(--lz-c-surface-raised);
      color:var(--lz-c-text);transition:all var(--lz-m-fast);}
    .dsp-foot button:hover{background:var(--lz-c-line);}
    /* color 必须显式给：基类 .dsp-foot button 是近白字，落在薄荷绿上只有 1.27:1 */
    .dsp-foot button.pri{background:var(--lz-c-primary);border-color:var(--lz-c-primary);
      color:var(--lz-c-primary-ink);font:var(--lz-f-bodyStrong);}
    .dsp-foot button.pri:hover{background:var(--lz-c-primary-hover);}
    /* 「删除」刻意不长成第三个等宽实心框：三个同宽同色的框排在一起，只要中间
       那个禁用了，整排都像点不动（上一版就是这个毛病）。这里换掉三件事 ——
       无边框无底色（形状类别不同）、flex:0 0 auto 不参与等分、margin-right:auto
       推到左侧独处。危险色只在 hover 时才上：删除低频且不可逆，常态不该抢眼。 */
    .dsp-foot button.del{flex:0 0 auto;margin-right:auto;
      padding:0 var(--lz-s-xs);border-color:transparent;background:transparent;
      color:var(--lz-c-text-weak);font:var(--lz-f-small);
      display:inline-flex;align-items:center;gap:var(--lz-s-xxs);}
    .dsp-foot button.del:hover{color:var(--lz-c-danger);
      background:var(--lz-c-danger-weak);border-color:transparent;}
    .dsp-foot button.del svg{width:13px;height:13px;flex:0 0 auto;}
    /* 禁用态：空内容时「完成」不可点 —— 存一条什么都没写的标记没有意义。
       统一用降透明度 + not-allowed。 */
    .dsp-foot button:disabled{opacity:.38;cursor:not-allowed;}
    .dsp-foot button:disabled:hover{background:var(--lz-c-surface-raised);}
    .dsp-foot button.pri:disabled:hover{background:var(--lz-c-primary);}

    /* 「/」下拉：独立浮层，不做 .dsp 的子元素 ——
       .dsp 有 overflow:hidden，作为子元素会被裁掉顶部（滑不到顶）。 */
    /* 宽度不在这里写死：positionSlash() 会按面板实测宽度赋值 —— 下拉是从面板里
       长出来的东西，比面板宽会让两层浮层错开边，看着像两个不相干的窗口。 */
    .dsp-slash{position:fixed;z-index:var(--lz-z-top);
      border-radius:var(--lz-r-md);background:var(--lz-c-surface);
      border:1px solid var(--lz-c-line-strong);
      box-shadow:var(--lz-sh-md);overflow:hidden;
      display:flex;flex-direction:column;max-height:min(400px,60vh);}
    /* 内边距与主面板 .dsp-head 同规格：两层浮层的头部前后脚出现，
       上下留白不一致会读成两套控件。 */
    .dsp-slash-hd{flex:0 0 auto;padding:var(--lz-s-sm) var(--lz-s-md);
      font:var(--lz-f-smallStrong);
      color:var(--lz-c-text-sub);border-bottom:1px solid var(--lz-c-line-subtle);
      display:flex;align-items:center;}
    .dsp-slash-q{color:var(--lz-c-primary);font-weight:400;}
    .dsp-slash-tip{margin-left:auto;font:var(--lz-f-small);
      color:var(--lz-c-text-disabled);}
    .dsp-slash-list{flex:1 1 auto;min-height:120px;overflow-y:auto;overscroll-behavior:contain;padding:var(--lz-s-xs);}
    .dsp-slash-it{display:flex;align-items:center;gap:var(--lz-s-sm);
      padding:var(--lz-s-xs) var(--lz-s-sm);
      border-radius:var(--lz-r-sm);cursor:pointer;transition:background var(--lz-m-fast);}
    .dsp-slash-it.on{background:var(--lz-c-primary-weak);}
    /* 130×70 = 图源（CSS 260×140）的整二分之一，比例 1.857 与图源一致：
       既不裁切也不拉伸，且 2x 图缩到 1/2 仍然清晰。改这里要同步 shoot-components.mjs
       的 OUT_W/OUT_H，否则比例一错 contain 会留出白边。 */
    .dsp-slash-ico{flex:0 0 auto;width:130px;height:70px;border-radius:var(--lz-r-sm);
      background:#fff;display:flex;align-items:center;overflow:hidden;
      justify-content:center;color:var(--lz-c-text-sub);
      border:1px solid var(--lz-c-line);}
    .dsp-slash-it.on .dsp-slash-ico{border-color:var(--lz-c-primary);}
    .dsp-slash-ico svg{width:24px;height:24px;color:rgba(0,0,0,.4);}
    /* contain 而非 cover：宁可留白，也不要把组件截掉半截 */
    .dsp-shot{width:100%;height:100%;object-fit:contain;object-position:center;display:block;}
    .dsp-slash-tx{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;}
    .dsp-slash-tx b{font:var(--lz-f-bodyStrong);color:var(--lz-c-text);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .dsp-slash-tx i{font:var(--lz-f-small);font-style:normal;color:var(--lz-c-text-weak);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    /* .dsp-slash-cfg / .dsp-slash-ft / .dsp-ok 已删：斜杠下拉不再有「配置」这一级。
       选完组件即带默认配置插入，要改配置点芯片上的齿轮。
       ⚠️ 本段在模板字符串里，注释里不能出现反引号 —— 会提前终止 POP_CSS，
       整张样式表从这里断掉（面板会裸成没底色没描边的一堆文字），而 node --check
       仍然通过。 */

    /* 组件配置：独立浮层，贴在主面板下方 ——
       原先它是主面板内的第二个视图（popView='cfg'），进配置就把正在写的那段
       描述整屏换掉：改配置本来是为了让描述里那句话成立，参照物却被藏了。
       改成和「/」下拉同一类东西（从面板长出来的第二层），两者同时可见。
       规格全部对齐 .dsp-slash，两层浮层前后脚出现，不一致会读成两套控件。 */
    .dsp-cfg{position:fixed;z-index:var(--lz-z-top);
      border-radius:var(--lz-r-md);background:var(--lz-c-surface);
      border:1px solid var(--lz-c-line-strong);
      box-shadow:var(--lz-sh-md);overflow:hidden;
      display:flex;flex-direction:column;max-height:min(400px,60vh);}
    /* 头尾都不画分割线（与主面板 .dsp-foot 同一取向）：配置项自己成了卡片，
       每张卡都有底色和描边，再加横线就是三层框线叠在一起。 */
    .dsp-cfg-hd{flex:0 0 auto;padding:var(--lz-s-sm) var(--lz-s-md) var(--lz-s-xs);
      font:var(--lz-f-smallStrong);
      color:var(--lz-c-text-sub);
      display:flex;align-items:center;gap:var(--lz-s-sm);}
    /* 标题是组件名而不是「配置组件」：这一层浮层只为一个组件存在，
       说「配置组件」等于把唯一有用的信息（哪个组件）省掉了。 */
    .dsp-cfg-nm{flex:1 1 auto;font:var(--lz-f-title);color:var(--lz-c-text);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .dsp-cfg-tip{flex:0 0 auto;font:var(--lz-f-small);color:var(--lz-c-text-disabled);}
    .dsp-cfg-bd{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
      padding:var(--lz-s-sm) var(--lz-s-md);}
    .dsp-cfg-ft{flex:0 0 auto;padding:var(--lz-s-xs) var(--lz-s-md) var(--lz-s-sm);
      display:flex;gap:var(--lz-s-sm);}
    /* 「返回」窄、「确定」占满剩余：这一层只有一个出口是主路径，
       两个等宽按钮会让「返回」看起来和「确定」一样重要。 */
    .dsp-cfg-ft .dsp-back{flex:0 0 auto;}
    .dsp-cfg-ft .pri{flex:1 1 auto;height:28px;border-radius:var(--lz-r-sm);
      font:var(--lz-f-bodyStrong);cursor:pointer;
      background:var(--lz-c-primary);border:1px solid var(--lz-c-primary);
      color:var(--lz-c-primary-ink);transition:all var(--lz-m-fast);}
    .dsp-cfg-ft .pri:hover{background:var(--lz-c-primary-hover);}
  `

  function ensurePopStyle() {
    // 先注入令牌，再注入用它的样式表。放在幂等守卫之前：样式表可能已存在而令牌
    // 没有（例如令牌脚本后到），那种情况下早退会让 33 个 var() 永久解析失败。
    const T = window.__liaisonUITokens
    if (T && T.ensure) T.ensure()
    else console.error(
      '[liaison-ds] window.__liaisonUITokens 未就绪，面板样式的 --lz-* 变量会全部失效。' +
      '检查 inject.js 里 ui-tokens.js 是否排在 design-system-ui.js 之前。')

    if (document.getElementById('liaison-dsp-style')) return
    const st = document.createElement('style')
    st.id = 'liaison-dsp-style'
    st.textContent = POP_CSS
    document.documentElement.appendChild(st)
  }

  // 主面板只有一种视图：写描述。原先还有个 popView='cfg' 的配置视图，
  // 现在配置搬去了独立浮层（.dsp-cfg），主面板不再换屏。
  // 这次打开是"新建"还是"编辑已有"。决定点 × 时的语义：
  //   新建 → 放弃（整条丢掉，无论写没写）
  //   编辑已有 → 只是收起面板，已有内容保留
  let popIsNew = false

  function openPopover(pin, opts) {
    closePopover()
    popIsNew = !!(opts && opts.isNew)
    popPin = pin
    popQuery = ''
    ensurePopStyle()
    popEl = document.createElement('div')
    popEl.className = 'dsp'
    popEl.setAttribute('data-liaison-ds-pop', '')
    document.documentElement.appendChild(popEl)
    renderPopover()
    positionPopover()
    focusEditor()
  }

  function closePopover() {
    slashClose()
    // 配置浮层挂在 documentElement 上、不是 popEl 的子节点，
    // 移除 popEl 不会带走它 —— 不显式收起会留下一块孤立浮层。
    cfgClose()
    if (popEl && popEl.parentNode) popEl.parentNode.removeChild(popEl)
    popEl = null
    popPin = null
  }

  /** 定位：优先放在标记的右下，越界则翻到左 / 上 */
  function positionPopover() {
    if (!popEl || !popPin) return
    const w = popEl.offsetWidth || 340
    const h = popEl.offsetHeight || 300
    // 区域标记从右下角弹，点标记从点本身弹
    const ax = popPin.x + (isBox(popPin) ? popPin.w : 0)
    const ay = popPin.y + (isBox(popPin) ? popPin.h : 0)
    const vx = ax - window.scrollX
    const vy = ay - window.scrollY
    let left = vx + 14
    let top = vy + 12
    if (left + w > window.innerWidth - 12) left = vx - w - 14
    if (left < 12) left = 12
    if (top + h > window.innerHeight - 12) top = Math.max(12, vy - h - 12)
    popEl.style.left = (left + window.scrollX) + 'px'
    popEl.style.top = (top + window.scrollY) + 'px'
    // 两层浮层都是按主面板矩形算位置的，主面板一动（拖标记、页面滚动）
    // 它们必须跟着走，否则会脱离面板飘在原处。
    if (slashEl) positionSlash()
    if (cfgEl) positionCfg()
  }

  function popMatched() {
    const q = popQuery.trim().toLowerCase()
    if (!q) return CATALOG
    return CATALOG.filter(function (c) {
      if (c.name.toLowerCase().indexOf(q) >= 0) return true
      if (c.desc && c.desc.toLowerCase().indexOf(q) >= 0) return true
      return (c.keywords || []).some(function (k) { return k.toLowerCase().indexOf(q) >= 0 })
    })
  }

  // ── 描述与组件芯片的互转 ──────────────────────────────────────────
  //
  // 存储用纯文本 + 占位符：`右上角加 {{c1}}，文案叫"导出"`
  // 渲染时把 {{c1}} 换成一个不可编辑的芯片元素；读回时再换回占位符。
  // 这样描述与组件的**位置关系**被保留下来，prompt 里能还原成
  // "右上角加【按钮 Button】" 而不是把两者拆成互不相干的两段。

  function chipHtml(c) {
    const comp = findComponent(c.componentId)
    const name = comp ? comp.name : '未知组件'
    // 芯片上只留齿轮，不再有「×」移除按钮：芯片就长在正在写的句子里，
    // 删它的自然手势是退格 —— 芯片 contenteditable=false，一次退格整枚删掉，
    // 删完 syncEditor() 会连带清掉它的配置。多一个 × 反而把两个尺寸相近、
    // 后果完全不同的图标（改配置 / 删掉）并排放在 20px 之内，容易点错。
    return '<span class="dsp-chip" contenteditable="false" data-cid="' + esc(c.cid) + '">' +
      esc(name) + '<span class="dsp-chip-g" data-chip-cfg="' + esc(c.cid) + '" title="配置">⚙</span></span>'
  }

  /** 纯文本（含 {{cid}}）→ 编辑器 HTML */
  function textToHtml(pin) {
    const raw = pin.text || ''
    let out = ''
    let last = 0
    const re = /\{\{(c\d+)\}\}/g
    let m
    while ((m = re.exec(raw))) {
      out += esc(raw.slice(last, m.index))
      const c = (pin.comps || []).filter(function (x) { return x.cid === m[1] })[0]
      out += c ? chipHtml(c) : ''
      last = m.index + m[0].length
    }
    out += esc(raw.slice(last))
    return out
  }

  /** 编辑器 DOM → 纯文本（芯片还原成 {{cid}}） */
  function htmlToText(root) {
    let out = ''
    const walk = function (node) {
      if (node.nodeType === 3) { out += node.nodeValue; return }
      if (node.nodeType !== 1) return
      if (node.classList && node.classList.contains('dsp-chip')) {
        out += '{{' + (node.dataset.cid || '') + '}}'
        return
      }
      if (node.tagName === 'BR') { out += '\n'; return }
      const isBlock = /^(DIV|P)$/.test(node.tagName)
      if (isBlock && out && !/\n$/.test(out)) out += '\n'
      Array.prototype.forEach.call(node.childNodes, walk)
    }
    Array.prototype.forEach.call(root.childNodes, walk)
    return out
  }

  /** 把编辑器里的内容同步进 pin，并清掉已被删除的组件 */
  function syncEditor() {
    if (!popPin || !popEl) return
    const ed = popEl.querySelector('[data-dsp-ed]')
    if (!ed) return
    popPin.text = htmlToText(ed)
    // 芯片被退格删掉时，对应的组件配置也要跟着走
    popPin.comps = (popPin.comps || []).filter(function (c) {
      return popPin.text.indexOf('{{' + c.cid + '}}') >= 0
    })
    // 「完成」的可用性跟着内容实时变。放在这里而不是逐个监听 input：
    // syncEditor 是所有输入路径（打字、删芯片、插组件）的汇聚点，
    // 挂一处就不会漏，也不会因为 renderPopover 重画而错位。
    const dn = popEl.querySelector('[data-dsp-done]')
    if (dn) dn.disabled = !hasContent(popPin)
    syncEdPlaceholder(ed)
  }

  /** 依「纯文本是否为空」开关 placeholder；见 .dsp-ed[data-empty] 处的注释 */
  function syncEdPlaceholder(ed) {
    if (!ed) return
    if (ed.textContent.replace(/[\s\u200b]/g, '') === '') ed.setAttribute('data-empty', '')
    else ed.removeAttribute('data-empty')
  }

  function focusEditor() {
    if (!popEl) return
    const ed = popEl.querySelector('[data-dsp-ed]')
    if (!ed) return
    ed.focus()
    // 光标落到末尾，接着上次写
    try {
      const r = document.createRange()
      r.selectNodeContents(ed)
      r.collapse(false)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(r)
    } catch (_) {}
  }

  /** 光标当前在纯文本里的下标；取不到返回 -1 */
  function caretTextOffset(ed) {
    try {
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount || !ed.contains(sel.anchorNode)) return -1
      return htmlToTextUpTo(ed, sel).length
    } catch (_) { return -1 }
  }

  /** 编辑器里从开头到光标处的纯文本长度（用于定位插入点） */
  function htmlToTextUpTo(ed, sel) {
    try {
      const r = document.createRange()
      r.setStart(ed, 0)
      r.setEnd(sel.anchorNode, sel.anchorOffset)
      const frag = r.cloneContents()
      const box = document.createElement('div')
      box.appendChild(frag)
      return htmlToText(box)
    } catch (_) { return popPin.text || '' }
  }


  // ══════════════════════════════════════════════════════════════════════════
  // 「/」内联下拉：打字途中随手插组件
  // ══════════════════════════════════════════════════════════════════════════
  //
  // 为什么不用「＋ 插入组件」按钮：那要求用户离开键盘去点一下，再回来接着打字，
  // 手会离开正在写的那句话。`/` 是编辑器里公认的插入手势（Notion / Slack /
  // Linear 都是），打到哪儿插到哪儿，不打断写作。
  //
  // 一级：搜组件 → 回车/点选，直接带默认配置以芯片形式落回光标处。
  //
  // 为什么不在这里再插一步「配置」：用户此刻正在写一句话，`/` 是写作动作的一部分。
  // 选完组件立刻弹一屏开关，会把「打字」打断成「填表」——而大多数插入根本不需要
  // 改配置（默认值就是设计规范里的推荐值）。要改的人点芯片上的齿轮进配置视图即可，
  // 那是芯片自带的入口，不占插入路径。

  let slashEl = null          // 下拉容器
  let slashQuery = ''         // `/` 后面已经打的字
  let slashPickId = null      // 已选中的组件 id
  let slashValues = null      // 配置中的取值
  let slashIndex = 0          // 键盘高亮项
  let slashAnchorPos = null   // `/` 在纯文本中的下标（插入时要连它一起替换掉）
  let slashQueryAtInsert = '' // 确认那一刻已输入的搜索词（同样要被替换掉）

  function slashOpen() {
    if (!popEl) return
    slashQuery = ''
    slashPickId = null
    slashValues = null
    slashIndex = 0
    if (!slashEl) {
      slashEl = document.createElement('div')
      slashEl.className = 'dsp-slash'
      slashEl.setAttribute('data-liaison-ds-pop', '')
      // 挂 documentElement 而非 popEl：popEl 有 overflow:hidden，
      // 作为其子元素时下拉的上半部会被裁掉
      document.documentElement.appendChild(slashEl)
    }
    renderSlash()
    positionSlash()
  }

  /**
   * 下拉定位：贴着面板上沿往上展开（面板下半部是按钮区，盖住不合适）；
   * 上方放不下就翻到面板下方。
   */
  // 两层浮层之间的缝：取 --lz-s-md(12px)。原先写死 6px 既是裸值、也太挤 ——
  // 下拉和主面板是两块各自带描边和阴影的浮层，6px 会让两条描边糊成一条。
  // 这里必须是 JS 数字（要参与定位计算），改令牌时同步这一处。
  const SLASH_GAP = 12

  function positionSlash() {
    if (!slashEl || !popEl) return
    const pr = popEl.getBoundingClientRect()
    // 宽度跟着面板走，且左边缘对齐：下拉是从这个面板里长出来的东西，
    // 两层宽度不一致会错开边，看着像两个不相干的窗口。
    // 先赋宽再量高 —— 宽度会影响换行，进而影响 offsetHeight。
    const w = Math.round(pr.width)
    slashEl.style.width = w + 'px'
    const h = slashEl.offsetHeight || 260
    let left = pr.left
    if (left < 8) left = 8
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8
    // 优先向上展开
    let top = pr.top - h - SLASH_GAP
    if (top < 8) {
      // 上方不够 → 翻到面板下方；再不够就贴顶并让内部滚动
      top = pr.bottom + SLASH_GAP
      if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8)
    }
    slashEl.style.left = left + 'px'
    slashEl.style.top = top + 'px'
  }

  function slashClose() {
    if (slashEl && slashEl.parentNode) slashEl.parentNode.removeChild(slashEl)
    slashEl = null
    slashQuery = ''
    slashPickId = null
    slashValues = null
    slashAnchorPos = null
    slashQueryAtInsert = ''
  }

  function slashActive() { return !!slashEl }

  /**
   * 从编辑器现状重算 `/` 后面的搜索词并重画下拉。
   *
   * 抽成函数是因为有两条调用路径，缺一条中文就搜不动：
   *   - `input`：英文/数字直接走这里
   *   - `compositionend`：中文拼音上屏。Chrome 里最后一次 `input` 早于
   *     `compositionend`，而那次 input 被 popComposing 挡掉了，所以候选词
   *     上屏后必须由 compositionend 再算一次，否则 slashQuery 永远是空串，
   *     下拉一直显示全量列表（打「/标签」也照样列出 Button、Breadcrumb…）。
   */
  function slashSyncQuery(ed) {
    if (!slashActive() || !popPin) return
    const t = popPin.text || ''
    // `/` 被删掉了 → 这个下拉失去了锚点，收起
    if (slashAnchorPos == null || t.charAt(slashAnchorPos) !== '/') { slashClose(); return }
    const caret = caretTextOffset(ed)
    slashQuery = t.slice(slashAnchorPos + 1, caret < 0 ? undefined : caret)
    // 打了空格说明这个 `/` 只是普通标点，不是插入手势
    if (/\s/.test(slashQuery)) { slashClose(); return }
    slashIndex = 0
    renderSlash()
    positionSlash()   // 结果条数变了，下拉高度跟着变，得重新贴边
  }

  /**
   * 模糊匹配 + 打分排序。
   *
   * 光靠子串匹配不够用：打「搜」要能找到「搜索框」，打「anniu」也该出「按钮」。
   * 三种匹配方式各给一档分，同档内按名字长短排（短的通常更常用）：
   *   100 前缀命中（"搜" → "搜索框"）—— 最像用户想要的
   *    60 子串命中（"钮" → "按钮"）
   *    30 打散命中（"biaoge" → "表格"，或"分页"匹配"分列表页"）
   * 每一档里名字命中比关键词命中再高一点，因为名字是用户最先看到的。
   */
  function fuzzyScore(text, q) {
    if (!text) return 0
    const t = String(text).toLowerCase()
    if (t.indexOf(q) === 0) return 100
    if (t.indexOf(q) > 0) return 60
    // 打散匹配：q 的每个字按顺序出现在 t 里即可（不要求连续）
    let i = 0
    for (let k = 0; k < t.length && i < q.length; k++) {
      if (t.charAt(k) === q.charAt(i)) i++
    }
    return i === q.length ? 30 : 0
  }

  function slashMatched() {
    const q = slashQuery.trim().toLowerCase()
    if (!q) return CATALOG
    const scored = []
    CATALOG.forEach(function (c) {
      let best = 0
      // 名字权重最高
      best = Math.max(best, fuzzyScore(c.name, q) * 1.2)
      ;(c.keywords || []).forEach(function (k) {
        best = Math.max(best, fuzzyScore(k, q))
      })
      best = Math.max(best, fuzzyScore(c.desc, q) * 0.7)
      if (best > 0) scored.push({ c: c, s: best })
    })
    scored.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s
      return a.c.name.length - b.c.name.length
    })
    return scored.map(function (x) { return x.c })
  }

  function renderSlash() {
    if (!slashEl) return
    let html = ''

    const list = slashMatched()
    if (slashIndex >= list.length) slashIndex = Math.max(0, list.length - 1)
    html += '<div class="dsp-slash-hd">插入组件' +
      (slashQuery ? '\u3000<span class="dsp-slash-q">/' + esc(slashQuery) + '</span>' : '') +
      '<span class="dsp-slash-tip">↑↓ 选择 · Enter 插入 · Esc 取消</span></div>'
    html += '<div class="dsp-slash-list">'
    if (!CATALOG.length) html += '<div class="dsp-empty">正在获取组件库…</div>'
    else if (!list.length) html += '<div class="dsp-empty">没有匹配的组件</div>'
    else {
      list.forEach(function (c, i) {
        html += '<div class="dsp-slash-it' + (i === slashIndex ? ' on' : '') +
          '" data-slash-pick="' + esc(c.id) + '" data-slash-i="' + i + '">' +
          '<span class="dsp-slash-ico">' + compIcon(c) + '</span>' +
          '<span class="dsp-slash-tx"><b>' + esc(c.name) + '</b>' +
          (c.desc ? '<i>' + esc(c.desc) + '</i>' : '') + '</span></div>'
      })
    }
    html += '</div>'

    slashEl.innerHTML = html
    bindSlash()
    positionSlash()
    // 高亮项滚进视野
    const on = slashEl.querySelector('.dsp-slash-it.on')
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' })
  }

  function bindSlash() {
    if (!slashEl) return

    // 键盘处理绑在下拉自身：鼠标在下拉上按过之后焦点可能不在编辑器，
    // 只绑在编辑器上的那份就拿不到事件。
    slashEl.addEventListener('keydown', function (e) {
      // 合成期间整个交给输入法：候选窗开着时 Enter/方向键/Esc 都是它的
      if (isComposingKey(e)) return
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        slashClose(); focusEditor()
        return
      }
      const list = slashMatched()
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation()
        slashIndex = Math.min(list.length - 1, slashIndex + 1); renderSlash(); return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        slashIndex = Math.max(0, slashIndex - 1); renderSlash(); return
      }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation()
        const c = list[slashIndex]
        if (c) slashPick(c.id)
        return
      }
    }, true)

    slashEl.querySelectorAll('[data-slash-pick]').forEach(function (it) {
      it.addEventListener('mouseenter', function () {
        slashIndex = parseInt(it.getAttribute('data-slash-i'), 10) || 0
        slashEl.querySelectorAll('.dsp-slash-it').forEach(function (x) { x.classList.remove('on') })
        it.classList.add('on')
      })
      it.addEventListener('mousedown', function (e) {
        // mousedown 而非 click：click 时编辑器已失焦，光标位置就丢了
        e.preventDefault(); e.stopPropagation()
        slashPick(it.getAttribute('data-slash-pick'))
      })
    })
  }

  /**
   * 选中某个组件 → 带默认配置直接插入，不再中转一屏配置。
   *
   * 默认值取设计规范里定义的 `default`，本身就是推荐值；要改的用户点芯片上的
   * 齿轮进配置视图（见 data-chip-cfg），那是芯片自带的入口，不占插入路径。
   */
  function slashPick(id) {
    const comp = findComponent(id)
    if (!comp) return
    slashPickId = id
    slashValues = {}
    ;(comp.fields || []).forEach(function (f) {
      if (f.default !== undefined) slashValues[f.key] = f.default
    })
    slashConfirm()
  }

  /** 把组件以芯片形式插到 `/` 所在处 */
  function slashConfirm() {
    if (!popPin || !slashPickId) { slashClose(); return }
    const id = slashPickId
    const values = slashValues || {}
    // 先留住这两个：slashClose 会清空它们，而插入时要靠它们算替换范围
    const anchor = slashAnchorPos
    const q = slashQuery
    slashClose()
    slashAnchorPos = anchor
    slashQueryAtInsert = q
    insertComponentAt(id, values)
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 组件配置浮层：点芯片上的齿轮弹出，贴在主面板下方
  // --------------------------------------------------------------------------
  // 与「/」下拉是同一类构件：都挂在 documentElement 上（主面板 overflow:hidden，
  // 做子元素会被裁），都跟着主面板定位，都用 Esc 收起。
  // 两者互斥 —— 打开配置先收下拉，反之亦然，否则两层浮层会叠在同一片位置上。
  // ══════════════════════════════════════════════════════════════════════════

  let cfgEl = null
  let cfgCid = null   // 正在配置哪个已插入的组件（原 popEditingCid）

  /** 当前正被配置的那个组件实例（不存在返回 undefined） */
  function cfgComp() {
    if (!popPin || !cfgCid) return undefined
    return (popPin.comps || []).filter(function (x) { return x.cid === cfgCid })[0]
  }

  function cfgOpen(cid) {
    if (!popEl) return
    slashClose()          // 两层浮层同位置，下拉先让位
    cfgCid = cid
    if (!cfgEl) {
      cfgEl = document.createElement('div')
      cfgEl.className = 'dsp-cfg'
      cfgEl.setAttribute('data-liaison-ds-pop', '')
      document.documentElement.appendChild(cfgEl)
    }
    renderCfg()
    positionCfg()
  }

  function cfgClose() {
    if (cfgEl && cfgEl.parentNode) cfgEl.parentNode.removeChild(cfgEl)
    cfgEl = null
    cfgCid = null
  }

  function cfgActive() { return !!cfgEl }

  /**
   * 定位：优先贴主面板下沿。
   *
   * 与 positionSlash() 的取向相反 —— 下拉优先向上（面板下半是按钮区，选组件时
   * 盖住不合适），配置浮层优先向下（用户此刻在看输入框里那枚芯片，往下展开
   * 不遮挡它）。放不下才翻到上方。
   */
  function positionCfg() {
    if (!cfgEl || !popEl) return
    const pr = popEl.getBoundingClientRect()
    // 宽度与左边缘跟着主面板走，理由同 positionSlash()：两层宽度不一致会错边。
    const w = Math.round(pr.width)
    cfgEl.style.width = w + 'px'
    const h = cfgEl.offsetHeight || 200
    let left = pr.left
    if (left < 8) left = 8
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8
    let top = pr.bottom + SLASH_GAP
    if (top + h > window.innerHeight - 8) {
      // 下方不够 → 翻到面板上方；再不够就贴顶并让内部滚动
      top = pr.top - h - SLASH_GAP
      if (top < 8) top = Math.max(8, window.innerHeight - h - 8)
    }
    cfgEl.style.left = left + 'px'
    cfgEl.style.top = top + 'px'
  }

  function renderCfg() {
    if (!cfgEl) return
    const c = cfgComp()
    const comp = c ? findComponent(c.componentId) : null
    let html = ''

    html += '<div class="dsp-cfg-hd"><span class="dsp-cfg-nm">' +
      esc(comp ? comp.name : '组件') + '</span>' +
      '<span class="dsp-cfg-tip">Enter 确定 · Esc 返回</span></div>'

    html += '<div class="dsp-cfg-bd">'
    if (!comp) html += '<div class="dsp-empty">组件已不存在</div>'
    else if (!comp.fields || !comp.fields.length) {
      html += '<div class="dsp-empty">该组件无需额外配置</div>'
    } else {
      comp.fields.forEach(function (f) { html += renderPopField(f, c) })
    }
    html += '</div>'

    html += '<div class="dsp-cfg-ft">' +
      '<button class="dsp-back" data-cfg-back>返回</button>' +
      '<button class="pri" data-cfg-ok>确定</button></div>'

    cfgEl.innerHTML = html
    bindCfg()
    positionCfg()
  }

  function bindCfg() {
    if (!cfgEl) return

    // 键盘绑在浮层自身：焦点可能落在这里的输入框上，只绑编辑器那份收不到。
    cfgEl.addEventListener('keydown', function (e) {
      if (isComposingKey(e)) return
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation()
        cfgClose(); focusEditor()
      }
    }, true)

    // 字段读写：与主面板配置视图同一套 data-dsp-* 契约，只是宿主换成了 cfgEl。
    cfgEl.querySelectorAll('[data-dsp-field]').forEach(function (inp) {
      const key = inp.getAttribute('data-dsp-field')
      const write = function () {
        const c = cfgComp()
        if (!c) return
        c.values[key] = inp.type === 'number'
          ? (inp.value === '' ? '' : Number(inp.value))
          : inp.value
        popSync()
      }
      inp.addEventListener('change', write)
      if (inp.tagName === 'INPUT') inp.addEventListener('input', write)
    })

    cfgEl.querySelectorAll('[data-dsp-sug]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation()
        const c = cfgComp()
        if (!c) return
        c.values[b.getAttribute('data-dsp-sug')] = Number(b.getAttribute('data-dsp-sv'))
        renderCfg(); popSync()
      })
    })

    cfgEl.querySelectorAll('[data-dsp-sw]').forEach(function (sw) {
      sw.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation()
        const c = cfgComp()
        if (!c) return
        const k = sw.getAttribute('data-dsp-sw')
        c.values[k] = !c.values[k]
        renderCfg(); popSync()
      })
    })

    const bk = cfgEl.querySelector('[data-cfg-back]')
    if (bk) bk.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation()
      cfgClose(); focusEditor()
    })
    const ok = cfgEl.querySelector('[data-cfg-ok]')
    if (ok) ok.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation()
      cfgClose(); focusEditor()
    })
  }

  /**
   * 组件的小图示。
   *
   * 目前是按分组给的示意图形，不是真实样式截图 —— 真实截图需要跑 demo 逐个
   * 拍图并随 catalog 分发，那是单独一轮的事。这里先让列表不只是纯文字。
   */
  function compIcon(c) {
    // 有真实截图就用它 —— 那是拍 demo 得来的，改了源头重跑脚本会跟着变。
    // 没有（新增组件还没补拍）才回退到按分组画的示意图形。
    if (c.shot) {
      return '<img class="dsp-shot" src="' + c.shot + '" alt="" loading="lazy" />'
    }
    const g = c.group || ''
    const P = {
      general: '<rect x="3" y="6" width="14" height="8" rx="2"/>',
      nav: '<path d="M3 5h14M3 10h9M3 15h11"/>',
      input: '<rect x="2.5" y="6" width="15" height="8" rx="2"/><path d="M6 10h5"/>',
      display: '<rect x="2.5" y="4.5" width="15" height="11" rx="1.5"/><path d="M2.5 8h15M8 8v7.5"/>',
      feedback: '<circle cx="10" cy="10" r="6.5"/><path d="M10 7v4M10 13.2v.3"/>',
      business: '<rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M6 9h8M6 12h5"/>',
    }
    return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + (P[g] || P.general) + '</svg>'
  }

  /**
   * 在 `/` 的位置插入一个组件芯片。
   *
   * 与旧的 insertComponent 的区别：这里要**连同触发用的 `/` 和后面已输入的
   * 搜索词一起替换掉** —— 用户打的是 `/按钮`，最终应该只剩下芯片，不能把
   * `/按钮` 这几个字留在描述里。
   */
  function insertComponentAt(componentId, values) {
    if (!popPin) return
    syncEditor()
    let max = 0
    ;(popPin.comps || []).forEach(function (c) {
      const m = /^c(\d+)$/.exec(c.cid)
      if (m) max = Math.max(max, Number(m[1]))
    })
    const cid = 'c' + (max + 1)
    popPin.comps = (popPin.comps || []).concat([
      { cid: cid, componentId: componentId, values: values || {} },
    ])

    const marker = '{{' + cid + '}}'
    const t = popPin.text || ''
    // slashAnchor 记录的是 `/` 在纯文本里的下标；从那里到光标处
    // （`/` + 已打的搜索词）整段换成芯片
    if (slashAnchorPos != null && slashAnchorPos >= 0 && slashAnchorPos <= t.length) {
      const cut = slashAnchorPos + 1 + slashQueryAtInsert.length
      popPin.text = t.slice(0, slashAnchorPos) + marker + t.slice(Math.min(cut, t.length))
    } else {
      popPin.text = t + (t && !/\s$/.test(t) ? ' ' : '') + marker
    }
    slashAnchorPos = null
    slashQueryAtInsert = ''

    renderPopover()
    positionPopover()
    focusEditor()
    popSync()
  }

  function renderPopover() {
    if (!popEl || !popPin) return
    let html = ''

    // 标题只说「做什么」——写下你的想法。编号不再重复：页面上的蓝色标记
    // 本身就带着 ①，面板正指着它。
    html += '<div class="dsp-head">' +
      '<span class="dsp-title">写下你的想法</span>' +
      '<span class="dsp-x" data-dsp-close title="关闭">×</span></div>'

    // 「怎么用」放进 placeholder：光标要落进来的地方，正是需要提示的时机
    html += '<div class="dsp-ed" contenteditable="true" data-dsp-ed ' +
      'data-ph="输入&quot;/&quot;调用组件">' + textToHtml(popPin) + '</div>'

    const nSaved = copyCount()
    // 「完成」= 存下这一条、关浮层、回到标记态继续标下一处。
    // 空内容时禁用：一条什么都没写的标记对下游没有任何意义，存下来只会
    // 在清单里多一行「待填写」。判据与 configuredPins() 一致（有描述或有组件）。
    const canDone = hasContent(popPin)
    // 「删除」不做成第三个等宽灰按钮：三个同宽同色的框排一起，只要中间那个
    // 禁用了，整排都像点不动。改成无边框的图标按钮 + margin-right:auto 推到
    // 左侧独处 —— 形状类别就跟右边两个「实心框」不同，一眼能看出是可点的。
    html += '<div class="dsp-foot">' +
      '<button class="del" data-dsp-del title="删除这条标记">' + ICON_TRASH + '删除</button>' +
      '<button data-dsp-done' + (canDone ? '' : ' disabled') +
        ' title="保存这条，继续标记下一处">完成</button>' +
      '<button class="pri" data-dsp-copy>复制到 CC' +
        (nSaved > 1 ? '（' + nSaved + '）' : '') + '</button>' +
      '</div>'

    popEl.innerHTML = html
    // 重画不经过 input 事件，标记要在这里补上（首次打开、插入芯片后重画）
    syncEdPlaceholder(popEl.querySelector('[data-dsp-ed]'))
    // 两层浮层都挂在 documentElement 上，不受这里的 innerHTML 重写影响，
    // 但面板尺寸可能变了，跟着重新定位一次
    if (slashEl) positionSlash()
    if (cfgEl) positionCfg()
    bindPopover()
  }

  function renderPopField(f, c) {
    const v = c.values[f.key]
    let inner = ''
    if (f.type === 'text') {
      inner = '<input type="text" data-dsp-field="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) +
        '" placeholder="' + esc(f.placeholder || '') + '" />'
    } else if (f.type === 'number') {
      inner = '<input type="number" data-dsp-field="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) + '" />'
      if (f.suggestions && f.suggestions.length) {
        inner += '<div class="dsp-sug">'
        f.suggestions.forEach(function (sg) {
          inner += '<button type="button" data-dsp-sug="' + esc(f.key) + '" data-dsp-sv="' + esc(sg.value) +
            '" class="' + (String(sg.value) === String(v) ? 'on' : '') + '">' +
            esc(String(sg.label).split(' ·')[0]) + '</button>'
        })
        inner += '</div>'
      }
    } else if (f.type === 'select') {
      // 单行：标签在左、下拉在右，与开关那一行同骨架。
      // 下拉的取值是「从固定几项里挑一个」，和开关同类，没理由多占一行。
      let sel = '<select data-dsp-field="' + esc(f.key) + '">'
      ;(f.options || []).forEach(function (o) {
        sel += '<option value="' + esc(o.value) + '"' + (String(o.value) === String(v) ? ' selected' : '') +
          '>' + esc(o.label) + '</option>'
      })
      sel += '</select>'
      return '<div class="dsp-f"><div class="dsp-row">' +
        '<span class="dsp-f-l">' + esc(f.label) + '</span>' + sel + '</div>' +
        (f.hint ? '<div class="dsp-hint">' + esc(f.hint) + '</div>' : '') + '</div>'
    } else if (f.type === 'switch') {
      // data-dsp-sw 挂在最外层 .dsp-f（整张卡片）上，不是轨道、也不是那一行：
      // 热区是整卡，含 hint 那一行 —— 卡片就是这个开关的可视边界，
      // 里面任何位置都该能点。
      // .dsp-sw 只负责排版（标签左、轨道右），不再承载点击。
      return '<div class="dsp-f dsp-f-sw" data-dsp-sw="' + esc(f.key) + '">' +
        '<div class="dsp-sw">' +
        '<span class="dsp-f-l">' + esc(f.label) + '</span>' +
        '<span class="dsp-sw-t' + (v ? ' on' : '') + '">' +
        '<span class="dsp-sw-b"></span></span></div>' +
        (f.hint ? '<div class="dsp-hint">' + esc(f.hint) + '</div>' : '') + '</div>'
    }
    return '<div class="dsp-f"><label class="dsp-f-l">' + esc(f.label) + '</label>' + inner +
      (f.hint ? '<div class="dsp-hint">' + esc(f.hint) + '</div>' : '') + '</div>'
  }

  /** 面板内的改动直接写进 pin，并刷新标记与清单 */
  function popSync() {
    if (!popPin) return
    if (popPin.el) {
      popPin.el.dataset.dsSummary = pinSummary(popPin)
      popPin.el.dataset.dsTitle = pinTitle(popPin)
    }
    // 拖拽中不重建标记：renderPins 会销毁重建 DOM，正在拖的那个元素被移除后
    // 事件监听就指向了孤儿节点，拖到一半失灵。
    if (!draggingAny) renderPins()
    render()
  }

  function bindPopover() {
    if (!popEl) return

    // ── 描述编辑器 ────────────────────────────────────────────────
    const ed = popEl.querySelector('[data-dsp-ed]')
    if (ed) {
      ed.addEventListener('compositionstart', function () { popComposing = true })
      ed.addEventListener('compositionend', function () {
        popComposing = false
        syncEditor()
        // 拼音上屏后必须再算一次搜索词：这一步之前的 input 被 popComposing 挡掉了
        slashSyncQuery(ed)
        popSyncPin(popPin)
      })
      ed.addEventListener('input', function () {
        if (popComposing) return
        syncEditor()
        // 下拉开着时，`/` 后面新打的字就是搜索词
        slashSyncQuery(ed)
        // 只同步数据与清单，不 renderPins —— 那会重建 DOM 让输入框失焦
        popSyncPin(popPin)
        refreshFooter()
      })
      // 粘贴一律转纯文本：从别处拷来的富文本会把样式和标签带进编辑器
      ed.addEventListener('paste', function (e) {
        e.preventDefault()
        const t = (e.clipboardData || window.clipboardData).getData('text/plain')
        document.execCommand('insertText', false, t)
      })
      ed.addEventListener('keydown', function (e) {
        // 合成期间一律不拦：Enter/方向键/数字这会儿都归输入法（见 isComposingKey）。
        // 唯一例外是 Esc —— 输入法自己会先吃掉它来取消候选，真传到我们这儿
        // 就说明候选窗已经关了，那时按 Esc 的意图确实是关面板。
        if (isComposingKey(e) && e.key !== 'Escape') return
        // 下拉开着时，方向键/回车/Esc 归它，不落到编辑器
        if (slashActive()) {
          if (e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation()
            slashClose(); focusEditor()
            return
          }
          const list = slashMatched()
          if (e.key === 'ArrowDown') {
            e.preventDefault(); e.stopPropagation()
            slashIndex = Math.min(list.length - 1, slashIndex + 1); renderSlash(); return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault(); e.stopPropagation()
            slashIndex = Math.max(0, slashIndex - 1); renderSlash(); return
          }
          if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation()
            const c = list[slashIndex]
            if (c) slashPick(c.id)
            return
          }
        }

        // 配置浮层开着时 Esc 先收它，不要一路把整个面板关掉 ——
        // 焦点可能还在编辑器上（点齿轮后没点进配置里的输入框），
        // 这时的 Esc 从用户视角是「关掉刚弹出来这层」。
        if (e.key === 'Escape' && cfgActive()) {
          e.preventDefault(); e.stopPropagation()
          cfgClose(); focusEditor(); return
        }
        // Esc 不关主面板（设计确认）：这个面板是「正在写的一段话」，Esc 落到
        // 这儿多半是刚关掉输入法候选窗或斜杠下拉后的余波，一按就把写了半天的
        // 描述连面板一起收掉，代价太大。关面板走右上角 ×（doClose）。
        // ⚠️ 这里必须把 Esc 拦下并停止冒泡 —— 不拦的话它会走到 document 捕获阶段
        // 那个 onKey 上，直接退出整个组件模式（见 startPicking 里的 onKey），
        // 结果比关面板更重。
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          // 收起面板即可，标记已实时存下；接着在页面上标下一处就行
          e.preventDefault(); e.stopPropagation(); doNext(); return
        }
        // 打出 `/` 就唤起下拉。不拦默认行为——`/` 本身要正常落进文本，
        // 它是搜索起点的锚，确认插入时连同后面的搜索词一起被替换掉。
        if (e.key === '/' && !popComposing && !slashActive()) {
          setTimeout(function () {
            if (!popEl || !popPin) return
            syncEditor()
            const caret = caretTextOffset(ed)
            // 记 `/` 的位置：光标在它后面一格
            slashAnchorPos = caret > 0 ? caret - 1 : 0
            if ((popPin.text || '').charAt(slashAnchorPos) !== '/') return
            cfgClose()   // 两层浮层争同一片位置，下拉优先
            slashOpen()
          }, 0)
        }
      })
      // 芯片上的齿轮/× 按钮
      ed.addEventListener('click', function (e) {
        const cfg = e.target.closest && e.target.closest('[data-chip-cfg]')
        if (cfg) {
          e.preventDefault(); e.stopPropagation()
          // 不重渲主面板：配置是独立浮层，主面板里那段描述要留在视线里
          // 当参照物 —— 改配置本来就是为了让描述里那句话成立。
          cfgOpen(cfg.getAttribute('data-chip-cfg'))
          return
        }
        // 原来这里还有个 [data-chip-del] 分支（芯片上的「×」）。× 已从
        // chipHtml() 去掉 —— 删芯片走退格，见那里的注释。
      })
    }

    // 配置项的读写（data-dsp-field / -sug / -sw）已随配置视图搬去 bindCfg()，
    // 主面板里不再有这些字段。renderPopField() 两处共用，仍留在原处。

    // ── 底部两个按钮 ─────────────────────────────────────────────
    const cp = popEl.querySelector('[data-dsp-copy]')
    if (cp) cp.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation()
      doCopyAll()
    })

    const dl = popEl.querySelector('[data-dsp-del]')
    if (dl) dl.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation()
      doDelete()
    })

    const dn = popEl.querySelector('[data-dsp-done]')
    if (dn) dn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation()
      doDone()
    })

    const cl = popEl.querySelector('[data-dsp-close]')
    if (cl) cl.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation()
      doClose()
    })
  }

  /**
   * 面板上「复制到 CC」要显示的条数。
   *
   * configuredPins() 只数已有内容的标记，而当前正在编辑的这处往往还是空的
   * （刚打开面板还没打字）——直接用会比实际少 1。当前这处一定会被复制，
   * 所以未计入时补上。
   */
  function copyCount() {
    const list = configuredPins()
    let n = list.length
    if (popPin && list.indexOf(popPin) < 0) n += 1
    return n
  }

  /** 只刷新底部按钮文案，不重渲整个面板（重渲会让输入框失焦） */
  function refreshFooter() {
    if (!popEl) return
    const cp = popEl.querySelector('[data-dsp-copy]')
    if (!cp) return
    const n = copyCount()
    cp.textContent = '复制到 CC' + (n > 1 ? '（' + n + '）' : '')
  }

  /**
   * 「继续」＝ 保存当前这处，回到标记态接着标下一处。
   *
   * 保存不需要额外动作——描述和组件早已实时写进 pin 了。这里只是关面板、
   * 让标记留在页面上，然后继续标记态。空标记（什么都没写）直接丢掉。
   */
  function doNext() {
    if (!popPin) return
    syncEditor()
    popIsNew = false      // 点了「继续」＝已确认保存，不再是"新建中"
    const pin = popPin
    const empty = !(pin.text && pin.text.trim()) && !(pin.comps && pin.comps.length)
    closePopover()
    if (empty) {
      const i = state.pins.indexOf(pin)
      if (i >= 0) state.pins.splice(i, 1)
    }
    renderPins()
    render()
    // 保持标记态，鼠标旁重新出现"点击或划区"提示
    if (!state.picking) startPicking()
  }

  /**
   * 「复制到 CC」＝ 把**截止目前所有**标记一起复制，然后清空。
   *
   * 关键在"所有"：前面点过几次「继续」的那些标记都已存在 state.pins 里，
   * 这里连同当前这处一起打包。复制完清空——这一轮改造已经交付出去了。
   */
  function doCopyAll() {
    if (!popPin) return
    syncEditor()
    popIsNew = false      // 要复制了＝已确认保存
    const pin = popPin
    const empty = !(pin.text && pin.text.trim()) && !(pin.comps && pin.comps.length)
    if (empty) {
      const i = state.pins.indexOf(pin)
      if (i >= 0) state.pins.splice(i, 1)
    }
    closePopover()
    renderPins()
    render()
    doCopy()
  }

  /**
   * 关面板（点 ×）。
   *
   * **新建过程中点 × ＝ 放弃这一条**，无论写没写内容——用户点 × 的意图就是
   * "这条不要了"，把半截内容留下来反而要他再去清单里删一次。
   * 编辑已有的标记时点 × 只是收起面板，内容保留（那是早就存下的东西）。
   */
  function doClose() {
    if (!popPin) return
    syncEditor()
    const pin = popPin
    const empty = !(pin.text && pin.text.trim()) && !(pin.comps && pin.comps.length)
    const drop = popIsNew || empty
    closePopover()
    if (drop) {
      const i = state.pins.indexOf(pin)
      if (i >= 0) state.pins.splice(i, 1)
      renderPins()
    }
    render()
  }

  /**
   * 「完成」—— 存下这一条，关浮层，回到标记态继续标下一处。
   *
   * 与 doClose() 的区别正是「存不存」：doClose 是放弃（新建中的直接丢掉，
   * 见 popIsNew），doDone 是确认保留。所以这里要先把 popIsNew 清掉，
   * 否则 closePopover() 内部仍按"新建未确认"把它删了。
   *
   * 与 doCopy() 的区别是「交不交付」：doCopy 打包全部标记去 CC 并清空，
   * doDone 只结束当前这一条，攒着等最后一起交。
   */
  function doDone() {
    if (!popPin) return
    syncEditor()
    if (!hasContent(popPin)) return   // 双保险：按钮已禁用，键盘路径也拦一次
    popIsNew = false
    closePopover()
    // 不退出标记态 —— 「完成」的语义就是"这条写完了，接着标下一处"
    if (!state.picking) startPicking()
    render()
  }

  /**
   * 删除当前这条标记（面板底部左侧的垃圾桶）。
   *
   * 与 doClose（×）的区别：× 是「先不动它」——已存好的标记会留在页面上，
   * 只有空标记和新建未确认的才顺手丢掉。这里是明确的「不要了」，
   * 不管写没写都删。两个动作语义不同，不能合成一个。
   */
  function doDelete() {
    if (!popPin) return
    const pin = popPin
    closePopover()
    const i = state.pins.indexOf(pin)
    if (i >= 0) state.pins.splice(i, 1)
    renderPins()   // 重新编号并重画页面标记
    render()
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 面板状态与渲染
  // ══════════════════════════════════════════════════════════════════════════

  const state = {
    // root/ctx 已删：那是侧边面板的挂载容器与上下文，面板整个撤掉了
    // 多标记：一次页面改造往往要在好几处动手（这儿加筛选、那儿改间距、
    // 底下加分页），逐个复制粘贴太碎。pins 里每项 = 一处标记 + 它的需求描述。
    //
    // 标记有两种形态，用 w/h 是否为 0 区分：
    //   点   { n, x, y, w:0, h:0, ... }      —— 单击落点，指"这个位置"
    //   区域 { n, x, y, w, h, ... }          —— 拖拽框选，指"这一块"
    //
    // 需求由两部分组成，都可以为空但不能同时为空：
    //   text   —— 用户自己打的描述（"这块间距太富，压紧一点"）
    //   comps  —— 内联在描述里的组件 [{ cid, componentId, values }]
    //             cid 是内联占位符的锚，形如 {{c1}}，渲染时替换成组件芯片
    //
    //   { n, x, y, w, h, nearText, url, text, comps, el, boxEl, tagEl }
    pins: [],
    editingPin: -1,      // 正在编辑第几处（-1 = 无）
    picking: false,
    copied: false,
    shooting: false,
    shotError: '',
    syncedAt: 0,
    syncError: '',
    loading: true,
  }

  /**
   * 有内容的标记（空标记不进清单、不出现在 prompt 里）。
   *
   * 「有内容」= 写了描述 **或** 插了组件。只写文字不选组件也算数——
   * 用户可能只想说"这块间距太富""这个删掉"，那同样是一条改造需求。
   */
  /**
   * 这条标记有没有实质内容（有描述文字，或插了组件）。
   * configuredPins() 的筛选条件与「完成」按钮的可用条件本是同一判据，
   * 抽出来共用 —— 两处若各写一份，将来改判据必漏一头。
   */
  function hasContent(p) {
    return !!(p && ((p.text && p.text.trim()) || (p.comps && p.comps.length)))
  }

  function configuredPins() {
    return state.pins.filter(hasContent)
  }

  /** 标记是否为区域（拖拽框选）——点的 w/h 为 0 */
  function isBox(p) { return !!(p.w && p.h) }

  /**
   * 与页面上的标记对账，丢掉已失效的点。
   *
   * 为什么需要：宿主「清单」tab 的「清空」会把页面上带 data-liaison-modified
   * 的元素全部重置（含我们的标记），但它不知道 state.pins 的存在。不对账就会
   * 留下"面板里还列着、页面上已经没有"的幽灵点，复制时截图拍不到标记。
   */
  // 正在重画标记时跳过对账：renderPins() 会先 hidePin() 清空再逐个重建，
  // 中途所有 pin.el 都处于 isConnected=false 的瞬间——此时对账会把全部点误杀。
  let repainting = false
  let draggingAny = false

  function reconcilePins() {
    if (repainting) return false
    const before = state.pins.length
    state.pins = state.pins.filter(function (p) {
      if (!p.el) return true          // 尚未渲染的新点，保留
      return p.el.isConnected         // 渲染过的：还在文档里才算有效
    })
    if (state.pins.length !== before) {
      state.pins.forEach(function (p, i) { p.n = i + 1 })
      if (state.editingPin >= state.pins.length) state.editingPin = -1
      renderPins()
      return true
    }
    return false
  }

  // 侧边面板的 CSS 常量与 injectStyle() 已删 —— 面板整个撤掉了，那批 .ds-* 类
  // 无任何使用者。就地浮层用的是另一套（POP_CSS + ensurePopStyle），不受影响。

  const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮'
  function circled(n) { return CIRCLED[n - 1] || '(' + n + ')' }

  /**
   * 组件模式已无侧边面板，这里不再画任何界面。
   *
   * 但函数保留 —— 全模块 20 来处「状态变了，刷新一下」都调它，而其中两件事
   * 与面板无关、仍必须做：
   *   ① reconcilePins() 剔掉页面上已失效的标记（元素被业务代码移除等）
   *   ② 通知宿主「清单」tab 重算（那里现在是唯一的清单视图）
   * 所以这不是空壳，只是不再有 innerHTML。
   */
  function render() {
    reconcilePins()
    notifyOverview()
  }

  // renderRecord() 已删：侧边面板整个撤掉了（详见文件末尾「组件模式不用面板」）。

  // ══════════════════════════════════════════════════════════════════════════
  // 点位拾取的事件处理
  // ══════════════════════════════════════════════════════════════════════════

  let onMove = null
  let onClick = null
  let onKey = null

  /**
   * 打点：在页面任意位置标一个点，不做任何 DOM 方位推断。
   *
   * 为什么不推断方位：之前试过"按元素四边缘/中心判 before/after/left/right/append"，
   * 但用户要表达的落点往往不等于某个 DOM 元素的边——比如"放在这个标题右边、和它
   * 同一行"，DOM 上可能是插进另一个容器。方位判定越细，越容易和意图错位。
   *
   * 改为：**只记坐标 + 截图**，让下游 CC 看图判断。这与用户在 CC 窗口里"截图画个
   * 框说在这里加个东西"的既有习惯一致，实践中准确率很高——CC 有完整代码库，
   * 看图定位大概位置后再去代码里验证，比我们在浏览器侧硬推 DOM 语义更可靠。
   */
  /**
   * 事件是否发生在扩展自己的 UI 上（不该触发打点）。
   *
   * 两个坑：
   * ① 扩展的 UI 不止 liaison-app —— 侧边面板 liaison-style-panel、悬浮工具条
   *    liaison-top-toolbar、清单 liaison-page-overview-panel 等都是**独立的
   *    自定义元素**，不是 liaison-app 的后代，closest('liaison-app') 判不到。
   * ② 这些元素都是 Shadow DOM，e.target 会被重定向成宿主元素本身，
   *    在 shadow 内部点击时 closest 也不可靠 —— 必须走 composedPath()。
   */
  const EXT_TAGS = [
    'liaison-app', 'liaison-style-panel', 'liaison-top-toolbar',
    'liaison-comment-panel', 'liaison-comment-list-panel',
    'liaison-page-overview-panel', 'liaison-metatip', 'liaison-ally',
    'liaison-handles', 'liaison-handle', 'liaison-label', 'liaison-offscreen-label',
    'liaison-hover', 'liaison-corners', 'liaison-gridlines', 'liaison-distance',
    'liaison-boxmodel', 'liaison-overlay', 'liaison-grip', 'hotkey-map',
    'liaison-cat', 'liaison-backdrop', 'liaison-allytip',
    'liaison-mode-tip', 'liaison-asset-library', 'liaison-asset-ui',
    'liaison-hotkeys', 'liaison-page-overview', 'liaison-sel-label',
  ]

  function isExtensionUI(e) {
    const path = (e.composedPath && e.composedPath()) || []
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue
      const tag = node.tagName && node.tagName.toLowerCase()
      if (tag && EXT_TAGS.indexOf(tag) >= 0) return true
      if (node.hasAttribute &&
        (node.hasAttribute('data-liaison-ds-pop') ||
         node.hasAttribute('data-liaison-ds-pick') ||
         node.hasAttribute('data-liaison-ds-pin'))) return true
    }
    // composedPath 拿不到时（极少）退回 closest 兜底
    const t = e.target
    if (t && t.closest) {
      for (const tag of EXT_TAGS) if (t.closest(tag)) return true
      if (t.closest('[data-liaison-ds-pop]')) return true
    }
    return false
  }

  let onDown = null
  let onUp = null
  let dragBox = null      // 拖拽中的临时选框元素
  let dragFrom = null     // 按下时的视口坐标

  function startPicking() {
    if (state.picking) { stopPicking(); return }
    state.picking = true
    ensurePickLayer()
    hideHostHover()   // 打点态下不要宿主那圈紫色 hover 描边（见 hideHostHover 注释）
    render()

    // 标记态下鼠标旁跟随提示"点哪儿标哪儿"
    onMove = function (e) {
      // 拖拽中：画选框，提示换成尺寸
      if (dragFrom) {
        drawDragBox(e.clientX, e.clientY)
        if (pickLabel) {
          const w = Math.abs(e.clientX - dragFrom.x)
          const h = Math.abs(e.clientY - dragFrom.y)
          pickLabel.style.display = 'block'
          pickLabel.textContent = Math.round(w) + ' × ' + Math.round(h)
          pickLabel.style.left = (e.clientX + 12) + 'px'
          pickLabel.style.top = (e.clientY + 12) + 'px'
        }
        return
      }
      if (!pickLine || !pickLabel) return
      // 鼠标在扩展自己的 UI 上时不提示"点击或划区以增改组件"——那里点了不会标记
      if (isExtensionUI(e)) {
        pickLabel.style.display = 'none'
        return
      }
      pickOutline.style.display = 'none'
      pickLine.style.display = 'none'
      pickLabel.style.display = 'block'
      pickLabel.textContent = '点击或划区以增改组件'
      pickLabel.style.left = (e.clientX + 12) + 'px'
      pickLabel.style.top = (e.clientY + 12) + 'px'
    }

    // 点击与划区共用 mousedown/mouseup，靠**拖拽距离**区分：
    // 超过 6px 判为划区，否则算点击落点。不用"按住多久"之类的时间判据——
    // 手抖会让单击变成 2~3px 的微拖，用距离阈值最稳。
    onDown = function (e) {
      if (isExtensionUI(e)) return
      if (e.button !== 0) return          // 只认左键
      dragFrom = { x: e.clientX, y: e.clientY }
    }

    onUp = function (e) {
      if (!dragFrom) return
      const from = dragFrom
      dragFrom = null
      clearDragBox()
      if (isExtensionUI(e)) return

      const dx = e.clientX - from.x
      const dy = e.clientY - from.y
      const isArea = Math.abs(dx) > 6 || Math.abs(dy) > 6

      e.preventDefault()
      e.stopPropagation()

      // 记录页面绝对坐标（含滚动量），截图时换算回视口坐标画标记
      let pin
      if (isArea) {
        const vx = Math.min(from.x, e.clientX)
        const vy = Math.min(from.y, e.clientY)
        pin = {
          n: state.pins.length + 1,
          x: vx + window.scrollX,
          y: vy + window.scrollY,
          w: Math.abs(dx),
          h: Math.abs(dy),
          url: location.href,
          nearText: visibleText(document.elementFromPoint(from.x + dx / 2, from.y + dy / 2)),
          text: '',
          comps: [],
          el: null,
        }
      } else {
        pin = {
          n: state.pins.length + 1,
          x: from.x + window.scrollX,
          y: from.y + window.scrollY,
          w: 0,
          h: 0,
          url: location.href,
          // 标记处元素的文本，仅作辅助线索——不参与方位推断
          nearText: visibleText(document.elementFromPoint(from.x, from.y)),
          text: '',
          comps: [],
          el: null,
        }
      }

      // 标新的之前先清掉上一个"标了但什么都没写"的空标记——那多半是误点
      state.pins = state.pins.filter(function (p) {
        return (p.text && p.text.trim()) || (p.comps && p.comps.length)
      })

      state.pins.push(pin)
      // 先建标记（填上 pin.el）再做别的：render 前的 reconcilePins 按
      // pin.el.isConnected 判存活，el 还是 null 的新 pin 会被当场过滤掉。
      state.editingPin = state.pins.length - 1
      renderPins()
      // 不退出标记态——连续标记是常态。就地弹面板写需求，
      // 眼睛不用在页面和侧边栏之间来回跳。
      openPopover(pin, { isNew: true })
      render()
    }

    // 阻断点击：页面自己的 click 处理（跳转、展开等）在标记态下不该触发
    onClick = function (e) {
      if (isExtensionUI(e)) return
      e.preventDefault()
      e.stopPropagation()
    }

    // Esc 退出整个组件模式，而不只是停打点。
    //
    // 面板还在的时候，停打点后面板会显示「切到本 tab 即可开始标记」，用户
    // 知道自己处在什么状态、也知道怎么回去。面板撤掉后，「组件模式但不打点」
    // 是个**没有任何界面表现的死状态** —— 光标提示消失了、工具条却还高亮着
    // 「组件」，再点它也不会重新开始（那是同一个模式，不触发切换）。
    // 所以 Esc 直接退回浏览态，工具条按钮随之熄灭，状态与界面重新对上。
    onKey = function (e) {
      if (e.key !== 'Escape') return
      // 合成期间的 Esc 是「取消这串拼音」，归输入法。这个监听器挂在 document
      // 的捕获阶段，不挡就会抢先一步把整个组件模式退掉 —— 用户只想清掉候选窗，
      // 结果标记态没了，正在写的面板也跟着关。
      if (isComposingKey(e)) return
      // 面板开着时 Esc 一概不退组件模式（设计确认）：此刻 Esc 的意图顶多是
      // 「收起刚弹出来的那层」（斜杠下拉 / 配置浮层各自处理），绝不是「把正在
      // 写的东西全丢掉」。这里必须挡 —— 本监听在 document 捕获阶段，比面板内
      // 那些 stopPropagation 更早跑到，不挡就先一步退模式了。
      if (popEl) return
      stopPicking()
      // 走宿主自己监听的那个事件（liaison-top-toolbar-browse），而不是直接
      // 调 activateWorkspace —— 事件是它对外的既有契约，方法名是内部实现。
      try {
        const tb = document.querySelector('liaison-top-toolbar')
        if (tb) tb.dispatchEvent(new CustomEvent('liaison-top-toolbar-browse',
          { bubbles: true, composed: true }))
      } catch (_) {}
    }

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('mouseup', onUp, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
  }

  /** 拖拽中的临时选框 */
  function drawDragBox(cx, cy) {
    if (!dragFrom) return
    if (!dragBox) {
      dragBox = document.createElement('div')
      dragBox.setAttribute('data-liaison-ds-pick', '')
      dragBox.style.cssText =
        // 这些元素会被截图拍进去，令牌若没注入成功（ensure 未跑）var() 会解析失败、
        // 边框直接消失 —— 比颜色错更难发现。所以一律带 fallback 写死一份。
        'position:fixed;z-index:2147483645;' +
        'border:1.5px solid var(--lz-c-marker, #0069E0);' +
        'background:var(--lz-c-marker-weak, rgba(0,105,224,.12));' +
        'border-radius:3px;pointer-events:none;'
      document.documentElement.appendChild(dragBox)
    }
    dragBox.style.left = Math.min(dragFrom.x, cx) + 'px'
    dragBox.style.top = Math.min(dragFrom.y, cy) + 'px'
    dragBox.style.width = Math.abs(cx - dragFrom.x) + 'px'
    dragBox.style.height = Math.abs(cy - dragFrom.y) + 'px'
  }

  function clearDragBox() {
    if (dragBox && dragBox.parentNode) dragBox.parentNode.removeChild(dragBox)
    dragBox = null
  }

  // ── 打点标记（留在页面上，截图时一并拍进去）─────────────────────────────

  /**
   * 渲染全部打点标记。
   *
   * 标记同时挂 `data-liaison-modified="true"` —— 这是宿主 buildOverviewItems()
   * 扫描的属性，挂上它，每个点就会自动作为一条记录出现在「清单」tab 里，
   * 与样式变更、评论并列。复用宿主整套渲染/清空/定位逻辑，不另造一套。
   */
  function renderPins() {
    repainting = true
    try {
      hidePin()
      state.pins.forEach(function (pin, i) {
        pin.n = i + 1
        // hidePin 按属性全清，旧引用已成孤儿节点，重建前先断开
        pin.el = null; pin.boxEl = null; pin.tagEl = null
        createPinEl(pin)
      })
    } finally {
      repainting = false
    }
    notifyOverview()
  }

  /**
   * 通知宿主刷新「清单」。
   *
   * 挂了 data-liaison-modified 只是让 buildOverviewItems() **能**扫到，
   * 但那个函数只在宿主自己的操作后（改样式、加评论、选中元素）才被调用——
   * 我们在 page world 里创建标记，宿主完全不知道，清单永远不刷新。
   * 所以必须主动喊它一声。
   */
  function notifyOverview() {
    try {
      const app = document.querySelector('liaison-app')
      if (app && typeof app.syncOverviewPanel === 'function') app.syncOverviewPanel()
    } catch (e) {}
  }

  /**
   * 一处标记的人话摘要（清单里显示的那行）。
   * 描述文字优先——那是用户自己写的，比"新增组件：按钮"更贴近意图。
   */
  function pinSummary(pin) {
    const t = (pin.text || '').trim()
    const names = (pin.comps || []).map(function (c) {
      const comp = findComponent(c.componentId)
      return comp ? comp.name : ''
    }).filter(Boolean)
    const scope = isBox(pin) ? '区域' : '位置'
    if (t) {
      const short = t.length > 40 ? t.slice(0, 40) + '…' : t
      return scope + '改造：' + short + (names.length ? '（含 ' + names.join('、') + '）' : '')
    }
    if (names.length) return scope + '新增：' + names.join('、')
    return '待填写（' + circled(pin.n) + ' 已标记，尚未描述）'
  }

  /**
   * 清单条目的标题（那一行加粗的大字）。
   *
   * 宿主默认用 describeNode() 描述元素，但标记是我们造的浮标 div，
   * 于是标题显示成 `div.ds-pin-1` —— 对用户毫无意义。这里给出人话：
   * 编号 + 标记类型 + 落点附近的文本（有的话），让人一眼知道是哪一处。
   */
  function pinTitle(pin) {
    const scope = isBox(pin) ? '区域' : '位置'
    const near = (pin.nearText || '').trim()
    return circled(pin.n) + ' ' + scope + '标记' + (near ? ' · ' + near : '')
  }

  function createPinEl(pin) {
    // ── 区域标记：先画框，圆点落在框的左上角 ──────────────────────
    if (isBox(pin)) {
      const box = document.createElement('div')
      box.setAttribute('data-liaison-ds-pin', '')
      box.style.cssText =
        'position:absolute;z-index:2147483644;' +
        'border:1.5px solid var(--lz-c-marker,#0069E0);' +
        'background:var(--lz-c-marker-weak,rgba(0,105,224,.12));' +
        'border-radius:3px;cursor:grab;box-sizing:border-box;'
      box.style.left = pin.x + 'px'
      box.style.top = pin.y + 'px'
      box.style.width = pin.w + 'px'
      box.style.height = pin.h + 'px'
      document.documentElement.appendChild(box)
      pin.boxEl = box
    }

    const pinEl = document.createElement('div')
    pinEl.className = 'ds-pin-' + pin.n
    pinEl.setAttribute('data-liaison-ds-pin', '')
    // 让宿主的清单扫到它（buildOverviewItems 找的就是这个属性）
    pinEl.setAttribute('data-liaison-modified', 'true')
    pinEl.setAttribute('data-ds-pin-n', String(pin.n))
    // 给清单显示的人话描述（bundle 优先读它，而不是把定位 style 当配置列出来）
    pinEl.dataset.dsSummary = pinSummary(pin)
    // 清单条目的标题也要人话，否则宿主 describeNode() 会给出 `div.ds-pin-1`
    pinEl.dataset.dsTitle = pinTitle(pin)
    pinEl.style.cssText =
      'position:absolute;z-index:2147483645;width:26px;height:26px;border-radius:50%;' +
      'background:var(--lz-c-marker,#0069E0);color:#fff;' +
      'font:600 13px/1 -apple-system,BlinkMacSystemFont,' +
      '"PingFang SC",sans-serif;cursor:grab;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.28);transform:translate(-50%,-50%);' +
      'border:2px solid #fff;box-sizing:border-box;' +
      'display:flex;align-items:center;justify-content:center;user-select:none;'
    pinEl.textContent = String(pin.n)
    pinEl.style.left = pin.x + 'px'
    pinEl.style.top = pin.y + 'px'
    // 挂 documentElement 不挂 body：body 若有 position/transform 会成为包含块，
    // 绝对定位坐标就会偏。挂 html 上配页面绝对坐标，任何页面都对得准。
    document.documentElement.appendChild(pinEl)
    pin.el = pinEl

    // 写了内容的标记加一个小标签，页面上一眼看出这处要干嘛
    let tag = null
    const label = pinTagText(pin)
    if (label) {
      tag = document.createElement('div')
      tag.setAttribute('data-liaison-ds-pin', '')
      tag.style.cssText =
        'position:absolute;z-index:2147483645;padding:2px 6px;border-radius:4px;' +
        'background:var(--lz-c-marker,#0069E0);color:#fff;' +
        'font:500 11px/16px -apple-system,BlinkMacSystemFont,' +
        '"PingFang SC",sans-serif;white-space:nowrap;pointer-events:none;' +
        'box-shadow:0 2px 6px rgba(0,0,0,.22);transform:translateY(-50%);' +
        'max-width:220px;overflow:hidden;text-overflow:ellipsis;'
      tag.textContent = label
      tag.style.left = (pin.x + 18) + 'px'
      tag.style.top = pin.y + 'px'
      document.documentElement.appendChild(tag)
      pin.tagEl = tag
    }

    bindPinInteraction(pin, pinEl, tag)
  }

  /**
   * 区域框的缩放手柄：四角各一个，拖动改尺寸。
   *
   * 只做四角不做四边——八个手柄在小区域上会挤成一团，四角够用且不误触。
   * 手柄挂在框内部，靠 stopPropagation 抢在框的整体拖拽之前处理。
   */
  function bindBoxResize(pin) {
    const CORNERS = [
      { k: 'nw', cx: 0, cy: 0, cur: 'nwse-resize' },
      { k: 'ne', cx: 1, cy: 0, cur: 'nesw-resize' },
      { k: 'sw', cx: 0, cy: 1, cur: 'nesw-resize' },
      { k: 'se', cx: 1, cy: 1, cur: 'nwse-resize' },
    ]
    CORNERS.forEach(function (c) {
      // 外层是 18×18 的透明热区，内层才是看得见的 9px 圆点。
      // 只有 9px 的话太难点中（尤其贴着边框时）。
      const h = document.createElement('div')
      h.setAttribute('data-liaison-ds-pin', '')
      h.setAttribute('data-ds-box-handle', '')
      h.style.cssText =
        'position:absolute;width:18px;height:18px;box-sizing:border-box;' +
        'cursor:' + c.cur + ';display:flex;align-items:center;justify-content:center;' +
        'left:' + (c.cx * 100) + '%;top:' + (c.cy * 100) + '%;' +
        'transform:translate(-50%,-50%);z-index:2;'
      const dot = document.createElement('div')
      dot.style.cssText =
        'width:9px;height:9px;border-radius:50%;background:#fff;' +
        'border:1.5px solid var(--lz-c-marker,#0069E0);' +
        'box-sizing:border-box;pointer-events:none;'
      h.appendChild(dot)
      pin.boxEl.appendChild(h)

      let rs = null
      const down = function (e) {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()      // 不让框的整体拖拽接管
        draggingAny = true
        rs = { mx: e.clientX, my: e.clientY, x: pin.x, y: pin.y, w: pin.w, h: pin.h }
        document.addEventListener('mousemove', move, true)
        document.addEventListener('mouseup', up, true)
      }
      const move = function (e) {
        if (!rs) return
        const dx = e.clientX - rs.mx
        const dy = e.clientY - rs.my
        // 拖左/上边时，位置和尺寸要同时变
        let x = rs.x, y = rs.y, w = rs.w, h = rs.h
        if (c.cx === 0) { x = rs.x + dx; w = rs.w - dx } else { w = rs.w + dx }
        if (c.cy === 0) { y = rs.y + dy; h = rs.h - dy } else { h = rs.h + dy }
        // 反向拖过头时翻转，而不是让尺寸变负
        if (w < 0) { x += w; w = -w }
        if (h < 0) { y += h; h = -h }
        pin.x = x; pin.y = y; pin.w = Math.max(8, w); pin.h = Math.max(8, h)
        pin.boxEl.style.left = pin.x + 'px'
        pin.boxEl.style.top = pin.y + 'px'
        pin.boxEl.style.width = pin.w + 'px'
        pin.boxEl.style.height = pin.h + 'px'
        if (pin.el) {
          pin.el.style.left = pin.x + 'px'
          pin.el.style.top = pin.y + 'px'
        }
        if (pin.tagEl) {
          pin.tagEl.style.left = (pin.x + 18) + 'px'
          pin.tagEl.style.top = pin.y + 'px'
        }
        if (popPin === pin) positionPopover()
      }
      const up = function (e) {
        if (!rs) return
        rs = null
        draggingAny = false
        document.removeEventListener('mousemove', move, true)
        document.removeEventListener('mouseup', up, true)
        e.preventDefault()
        e.stopPropagation()
        // 尺寸变了，区域中心指向的内容也变了，重采文本线索
        const el = document.elementFromPoint(
          pin.x + pin.w / 2 - window.scrollX, pin.y + pin.h / 2 - window.scrollY)
        if (el && !isExtensionUIEl(el)) pin.nearText = visibleText(el)
        popSyncPin(pin)
        render()
      }
      // 必须捕获阶段：框的整体拖拽同样绑在捕获阶段，若手柄走冒泡，
      // 框会**先**接管，手柄的 stopPropagation 永远来不及执行 ——
      // 表现就是"手柄拖不动，一拖就整体移动"。
      h.addEventListener('mousedown', down, true)
      h.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation()
      }, true)
    })
  }

  /** 标记旁小标签的文字：优先组件名（短、可辨识），否则截断的描述 */
  function pinTagText(pin) {
    const names = (pin.comps || []).map(function (c) {
      const comp = findComponent(c.componentId)
      return comp ? comp.name : ''
    }).filter(Boolean)
    if (names.length) return names.join('、')
    const t = (pin.text || '').trim()
    if (!t) return ''
    return t.length > 18 ? t.slice(0, 18) + '…' : t
  }

  /**
   * 标记的交互：拖拽移位 + 点击唤起面板。
   *
   * 两者共用 mousedown，靠**移动距离**区分：超过 4px 判为拖拽，否则算点击。
   * 不用 dblclick 之类区分——标记本身就是单击操作，再引入双击会让手感割裂。
   *
   * 区域标记的框也能拖：拖框 = 整体移动（与拖圆点等效）。
   */
  function bindPinInteraction(pin, pinEl, tag) {
    let dragging = false
    let moved = 0
    let startX = 0
    let startY = 0
    let originX = 0
    let originY = 0

    const onDown = function (e) {
      // 只响应左键；阻止冒泡免得触发页面自身的点击和标记逻辑
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      dragging = true
      draggingAny = true
      moved = 0
      startX = e.clientX
      startY = e.clientY
      originX = pin.x
      originY = pin.y
      pinEl.style.cursor = 'grabbing'
      if (pin.boxEl) pin.boxEl.style.cursor = 'grabbing'
      document.addEventListener('mousemove', onMoveDrag, true)
      document.addEventListener('mouseup', onUp, true)
    }

    const onMoveDrag = function (e) {
      if (!dragging) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy))
      pin.x = originX + dx
      pin.y = originY + dy
      pinEl.style.left = pin.x + 'px'
      pinEl.style.top = pin.y + 'px'
      if (pin.boxEl) {
        pin.boxEl.style.left = pin.x + 'px'
        pin.boxEl.style.top = pin.y + 'px'
      }
      if (tag) {
        tag.style.left = (pin.x + 18) + 'px'
        tag.style.top = pin.y + 'px'
      }
      // 拖动时面板跟着走，不然会指向旧位置
      if (popPin === pin) positionPopover()
    }

    const onUp = function (e) {
      if (!dragging) return
      dragging = false
      draggingAny = false
      pinEl.style.cursor = 'grab'
      if (pin.boxEl) pin.boxEl.style.cursor = 'grab'
      document.removeEventListener('mousemove', onMoveDrag, true)
      document.removeEventListener('mouseup', onUp, true)
      e.preventDefault()
      e.stopPropagation()

      if (moved <= 4) {
        // 没怎么动＝点击：唤起面板调整（已开着则关掉，可反复切换）
        if (popPin === pin) closePopover()
        else openPopover(pin)
      } else {
        // 真的拖了：位置变了，附近文本线索要重新采
        const cx = pin.x + (isBox(pin) ? pin.w / 2 : 0) - window.scrollX
        const cy = pin.y + (isBox(pin) ? pin.h / 2 : 0) - window.scrollY
        const el = document.elementFromPoint(cx, cy)
        if (el && !isExtensionUIEl(el)) pin.nearText = visibleText(el)
        popSyncPin(pin)
      }
      render()
    }

    pinEl.addEventListener('mousedown', onDown, true)
    // mousedown 阻止冒泡不影响 click 的派发（两者是独立事件）。
    // isExtensionUI 已把标记排除在标记态之外，这里再显式拦一道：
    // 点标记的语义是"调整这处"，绝不能又标出一个新的。
    pinEl.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
    }, true)

    // 区域框同样可拖、可点（与圆点等效）
    if (pin.boxEl) {
      pin.boxEl.addEventListener('mousedown', function (e) {
        // 点在缩放手柄上时不做整体拖动 —— 那是改尺寸，由手柄自己处理。
        // 两者都绑在捕获阶段，靠 target 判断谁负责。
        if (e.target && e.target.closest && e.target.closest('[data-ds-box-handle]')) return
        onDown(e)
      }, true)
      pin.boxEl.addEventListener('click', function (e) {
        e.preventDefault()
        e.stopPropagation()
      }, true)
      bindBoxResize(pin)
    }
  }

  /** 元素是否属于扩展自己的 UI（拖拽落点判断用，非事件版） */
  function isExtensionUIEl(el) {
    if (!el || !el.closest) return false
    for (const tag of EXT_TAGS) if (el.closest(tag)) return true
    return !!(el.closest('[data-liaison-ds-pop]') || el.closest('[data-liaison-ds-pin]'))
  }

  /** 更新某个点的清单摘要并通知宿主（拖拽后用，不重画标记免得打断交互） */
  function popSyncPin(pin) {
    if (pin.el) {
      pin.el.dataset.dsSummary = pinSummary(pin)
      pin.el.dataset.dsTitle = pinTitle(pin)
    }
    notifyOverview()
  }

  /** 清掉页面上所有打点标记（含组件名小标签） */
  function hidePin() {
    document.querySelectorAll('[data-liaison-ds-pin]').forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el)
    })
  }

  /** 按 id 找组件 */
  function findComponent(id) {
    return CATALOG.filter(function (c) { return c.id === id })[0] || null
  }

  /** 经 background 截当前可视区（content script 直连会被页面 CSP 挡） */
  function captureScreenshot() {
    return new Promise(function (resolve) {
      const id = 'ds-shot-' + Math.random().toString(36).slice(2)
      const onMsg = function (ev) {
        const d = ev.data
        if (!d || d._liaisonInspBridgeReply !== true || d.id !== id) return
        window.removeEventListener('message', onMsg)
        resolve(d.ok ? d.result : null)
      }
      window.addEventListener('message', onMsg)
      window.postMessage({ _liaisonInspBridge: true, id: id, action: 'screenshot', payload: {} }, '*')
      setTimeout(function () {
        window.removeEventListener('message', onMsg)
        resolve(null)
      }, 5000)
    })
  }

  /** 把截图下载到本地，返回落盘路径——CC 需要的是能读的文件而不是 dataUrl */
  function downloadShot(dataUrl, seq) {
    return new Promise(function (resolve) {
      const id = 'ds-dl-' + Math.random().toString(36).slice(2)
      const onMsg = function (ev) {
        const d = ev.data
        if (!d || d._liaisonInspBridgeReply !== true || d.id !== id) return
        window.removeEventListener('message', onMsg)
        resolve(d.ok ? d.result : null)
      }
      window.addEventListener('message', onMsg)
      window.postMessage({
        _liaisonInspBridge: true, id: id, action: 'download',
        payload: { dataUrl: dataUrl, filename: 'liaison-ds-shot-' + (seq || 1) + '.png' },
      }, '*')
      setTimeout(function () {
        window.removeEventListener('message', onMsg)
        resolve(null)
      }, 8000)
    })
  }

  function stopPicking() {
    state.picking = false
    closePopover()
    dragFrom = null
    clearDragBox()
    if (onMove) document.removeEventListener('mousemove', onMove, true)
    if (onDown) document.removeEventListener('mousedown', onDown, true)
    if (onUp) document.removeEventListener('mouseup', onUp, true)
    if (onClick) document.removeEventListener('click', onClick, true)
    if (onKey) document.removeEventListener('keydown', onKey, true)
    onMove = onDown = onUp = onClick = onKey = null
    removePickLayer()
    showHostHover()   // 退出打点，把宿主的 hover 反馈还回去
    render()
  }

  /**
   * 复制全部标记 → 剪贴板，然后清空。
   *
   * 面板上的「复制到 CC」和侧栏底部那个按钮共用这一条路径：两处语义完全相同
   * ——把截止目前所有标记打包交付。
   */
  async function doCopy() {
    const pins = configuredPins()
    if (!pins.length) { state.shotError = '还没有写任何改造需求'; render(); return }

    state.shotError = ''
    state.shooting = true
    render()

    // 逐处各截一张：多处标记可能分散在长页面的不同位置，一张可视区图盖不全。
    // 慢一点（每处约 1 秒）但可靠，prompt 里能一一对应「① 见图1、② 见图2」。
    const shots = await captureEachPin(pins)
    state.shooting = false

    const text = buildMultiPrompt(pins, shots)
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch (_) {
      // 剪贴板 API 在非安全上下文/无焦点时会失败，退回 execCommand
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;'
        document.documentElement.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        ta.remove()
      } catch (__) { ok = false }
    }

    state.copied = ok
    if (!ok) state.shotError = '复制失败，请重试'
    else {
      // 复制成功＝这一轮改造已交付，清空标记重新开始
      state.pins = []
      state.editingPin = -1
      renderPins()
    }
    render()
    if (ok) setTimeout(function () {
      state.copied = false; state.shotError = ''; render()
    }, 3200)
  }

  /**
   * 逐点截图。每次把该点滚进视口中央 → 藏扩展 UI → 截图 → 存盘。
   *
   * 为什么不截一张全景：captureVisibleTab 只能拍当前可视区，滚动拼接实现复杂
   * 且容易在固定头部/懒加载处出错。逐点截图慢一点但每张都确定包含目标标记。
   */
  // 截图时藏掉一切扩展 UI 的自建样式表。
  //
  // 元素清单 = EXT_TAGS（isExtensionUI 用的那份"这些都是扩展自己的 UI"），
  // 单一数据源：以后宿主新增自定义元素，两处一起受益，不会漏。
  // 唯一区别是 liaison-app —— 它单独用 visibility 藏（见 hideAllChromeForShot）。
  //
  // 用 visibility:hidden 而非 opacity:0：opacity 只是透明，元素仍参与合成，
  // 某些带 backdrop-filter 的浮层会在图上留下一片模糊。
  const SHOT_HIDE_CLASS = 'liaison-ds-shot-hide'
  let shotHideStyleEl = null

  function ensureShotHideStyle() {
    if (shotHideStyleEl && shotHideStyleEl.isConnected) return
    shotHideStyleEl = document.createElement('style')
    shotHideStyleEl.setAttribute('data-liaison-ds-shot-hide', '')
    const sel = EXT_TAGS.map(function (tag) {
      return 'html.' + SHOT_HIDE_CLASS + ' ' + tag
    }).join(',')
    shotHideStyleEl.textContent =
      sel + '{display:none !important;pointer-events:none !important;}'
    document.documentElement.appendChild(shotHideStyleEl)
  }

  /**
   * 藏起所有非页面内容（扩展自己的 UI），只留宿主页面 + 标记点。
   *
   * 四件事，缺一即会拍进图里 —— 这里踩过两个坑，都记在下面，别退回去：
   * ① 逐元素 inline `display:none !important` 藏掉 EXT_TAGS 里的一切
   *    （工具条 / 侧栏 / 清单面板 / 各种 overlay）。⚠️ **不能只靠加 class**：
   *    宿主那张 `liaison-shot-hide-style` 样式表是它在自己的 snapshotElement()
   *    里**懒创建**的，我们从不调那个函数 → 样式表不存在 → 加 class 是空操作。
   *    这就是「无论工具条还是面板都没过滤掉」的真正原因。
   * ② 清掉 `data-shot-keep` —— 宿主 snapshotElement() 会给「不与目标元素重叠」
   *    的工具条/侧栏打这个属性，让它们在那轮截图里故意留着。属性打上后
   *    **不会被清掉**，于是宿主样式表里的 `:not([data-shot-keep])` 永久失效。
   *    我们不靠那张表了，但仍摘掉它：宿主的表若恰好存在，豁免会让藏不干净。
   * ③ 挂自建样式表 + class（见 ensureShotHideStyle）：兜住截图期间新插进来的元素。
   * ④ 本模块自己建的浮层是普通 div，不在 EXT_TAGS 里，逐个藏。
   *
   * 返回一个恢复函数：改了什么就恢复什么，不多不少。
   */
  function hideAllChromeForShot() {
    const restores = []

    // 猫头光标：freeze 模式给 <html> 加 li-cat-cursor（样式表 #li-cat-cursor-style),
    // 把指针换成 cursor-cat-64.png。captureVisibleTab 会把指针连图一起拍进去，
    // 于是图上多出一个猫头。摘掉 class 让指针回到系统箭头（箭头不入镜）。
    try {
      const de = document.documentElement
      if (de.classList.contains('li-cat-cursor')) {
        de.classList.remove('li-cat-cursor')
        restores.push(function () { de.classList.add('li-cat-cursor') })
      }
    } catch (e) {}
    // 逐个元素打 inline `display:none !important`。
    //
    // 为什么不只靠样式表：这些是 Shadow DOM 自定义元素，其中几个还会被
    // showPopover() 提到 top layer，宿主自己也可能给它们写过 inline style
    // —— 外部样式表压不过 inline。inline + important 是唯一压得住的一层。
    // 样式表仍留着（见 ensureShotHideStyle）：截图期间新插入的元素也能被盖到。
    EXT_TAGS.forEach(function (tag) {
      let nodes = []
      try { nodes = Array.prototype.slice.call(document.querySelectorAll(tag)) } catch (e) {}
      nodes.forEach(function (n) {
        const prev = n.style.getPropertyValue('display')
        const prevPri = n.style.getPropertyPriority('display')
        n.style.setProperty('display', 'none', 'important')
        restores.push(function () {
          if (prev) n.style.setProperty('display', prev, prevPri)
          else n.style.removeProperty('display')
        })
      })
    })

    // data-shot-keep：宿主留下的「拍照时别藏我」豁免。它是别人那轮截图的残留，
    // 对我们只会造成遮挡 —— 摘掉，拍完原样还回去（宿主下次自己会重设）。
    const keepers = []
    try {
      document.querySelectorAll('[data-shot-keep]').forEach(function (n) { keepers.push(n) })
    } catch (e) {}
    keepers.forEach(function (n) { n.removeAttribute('data-shot-keep') })
    if (keepers.length) {
      restores.push(function () {
        keepers.forEach(function (n) { n.setAttribute('data-shot-keep', '1') })
      })
    }

    // 自己那份样式表（不依赖宿主）+ 宿主那个 class 一起上。
    // ⚠️ 为什么必须自建：宿主的 `liaison-shot-hide-style` 是在它自己的
    // snapshotElement() 里**懒创建**的 —— 我们从不调那个函数，样式表压根不存在，
    // 于是 classList.add('liaison-shot-hide') 是个空操作，工具条/清单面板照样入镜。
    // 宿主那个 class 仍然加：它已经存在时（用户先用过别的截图功能）能一并生效。
    ensureShotHideStyle()
    try {
      document.documentElement.classList.add(SHOT_HIDE_CLASS)
      document.documentElement.classList.add('liaison-shot-hide')
      restores.push(function () {
        try {
          document.documentElement.classList.remove(SHOT_HIDE_CLASS)
          document.documentElement.classList.remove('liaison-shot-hide')
        } catch (e) {}
      })
    } catch (e) {}

    // 本模块自己的浮层：主面板 / 斜杠下拉 / 配置浮层 / 光标跟随提示层。
    // 前三个是普通 div，最后一个是 pickLayer（跟随提示 + 描边），都不在宿主清单里。
    ;[popEl, slashEl, cfgEl, pickLayer].forEach(function (el) {
      if (!el) return
      const prev = el.style.getPropertyValue('visibility')
      const prevPri = el.style.getPropertyPriority('visibility')
      el.style.setProperty('visibility', 'hidden', 'important')
      restores.push(function () {
        if (prev) el.style.setProperty('visibility', prev, prevPri)
        else el.style.removeProperty('visibility')
      })
    })

    return function () { restores.forEach(function (fn) { try { fn() } catch (e) {} }) }
  }

  /**
   * 逐屏截图。把标记按「落在同一屏」归组，每组只拍一张。
   *
   * 为什么不逐点各拍一张：多个标记常常都在首屏（用户就在当前视口连点几处），
   * 逐点拍就是同一片画面重复下载 N 份 —— 用户看到的「下载了多个同样的截图」
   * 正是这个。归组后同屏的标记共用一张图，prompt 里几处都指向它。
   *
   * 为什么不截一张全景：captureVisibleTab 只能拍当前可视区，滚动拼接实现复杂
   * 且容易在固定头部/懒加载处出错。按屏分组既不重复、也保证每张都含目标标记。
   *
   * @return 与 pins 等长的路径数组（同组的多个元素指向同一路径）
   */
  async function captureEachPin(pins) {
    const prevScroll = window.scrollY
    const out = new Array(pins.length).fill('')

    // ── 按屏分组 ────────────────────────────────────────────────────────
    // 判据：把该组第一个标记滚到居中后，后续标记是否也落在这一屏内。
    // 留 80px 上下余量，免得标记压在屏幕边缘、看不出它指着什么。
    const vh = window.innerHeight
    const margin = 80
    const order = pins.map(function (p, i) { return { p: p, i: i } })
      .sort(function (a, b) { return (a.p.y || 0) - (b.p.y || 0) })

    const groups = []
    order.forEach(function (item) {
      const y = item.p.y || 0
      const g = groups[groups.length - 1]
      if (g) {
        // g.top 是该组的滚动位置，组内标记须落在 [top+margin, top+vh-margin]
        const bottom = (item.p.y || 0) + (isBox(item.p) ? (item.p.h || 0) : 0)
        if (y >= g.top + margin && bottom <= g.top + vh - margin) { g.items.push(item); return }
      }
      groups.push({ top: Math.max(0, y - vh / 2), items: [item] })
    })

    let shotSeq = 0
    for (const g of groups) {
      shotSeq += 1
      window.scrollTo({ top: g.top, behavior: 'instant' })
      await new Promise(function (r) { setTimeout(r, 140) })

      const restore = hideAllChromeForShot()
      // 两帧：一帧让 class/属性生效，一帧让浏览器完成重绘再拍
      await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r) }) })

      let path = ''
      try {
        const dataUrl = await captureScreenshot()
        if (dataUrl) path = (await downloadShot(dataUrl, shotSeq)) || ''
      } catch (e) {}
      if (!path && !state.shotError) state.shotError = '部分截图失败'

      restore()
      // 同组共用这一张
      g.items.forEach(function (item) { out[item.i] = path })
    }

    window.scrollTo({ top: prevScroll, behavior: 'instant' })
    return out
  }

  /**
   * 把描述里的 {{cid}} 占位符还原成人话的组件引用。
   * 「右上角加 {{c1}}」→「右上角加【按钮 Button】」，位置关系得以保留。
   */
  function textWithComps(pin) {
    let t = pin.text || ''
    ;(pin.comps || []).forEach(function (c) {
      const comp = findComponent(c.componentId)
      const label = comp ? '【' + comp.name + '】' : '【未知组件】'
      t = t.split('{{' + c.cid + '}}').join(label)
    })
    // 插入芯片时为分词方便会补空格，【】本身已是视觉边界，紧邻的空格是多余的
    t = t.replace(/ +【/g, '【').replace(/】 +/g, '】')
    return t.trim()
  }

  /** 一个组件实例的配置项列表（沿用设计规范定义的字段） */
  function compConfigLines(comp, values) {
    const out = []
    ;(comp.fields || []).forEach(function (f) {
      const v = values[f.key]
      if (v === undefined || v === '' || v === null) return
      let display = v
      if (f.type === 'switch') display = v ? '是' : '否'
      if (f.type === 'select') {
        const opt = (f.options || []).filter(function (o) { return String(o.value) === String(v) })[0]
        if (opt) display = opt.label
      }
      if (f.type === 'number' && Number(v) === 0) display = '撑满（100%）'
      out.push('  - ' + f.label + '：' + display)
    })
    return out
  }

  /**
   * 一处标记的正文（描述 + 涉及的组件明细）。
   * 单处和多处共用，保证两种情况下格式一致。
   */
  /**
   * @param sharedWith 与本处共用同一张截图的其它标记编号（同屏归组的结果）。
   *   必须说出来 —— 一张图上有好几个蓝色标记时，不点明「看 ② 这个」，
   *   CC 无从知道该对哪一个。
   */
  function pinSection(pin, shot, L, sharedWith) {
    const box = isBox(pin)
    if (shot) {
      const others = (sharedWith || []).filter(function (n) { return n !== pin.n })
      L.push('- **截图**：`' + shot + '`（图中' +
        (box ? '蓝色方框 ' + circled(pin.n) + ' 即改造范围' : '蓝色圆点 ' + circled(pin.n) + ' 即位置') +
        (others.length
          ? '；这张图同时含 ' + others.map(circled).join(' ') + '，本节只说 ' + circled(pin.n)
          : '') + '）')
    } else {
      L.push('- ⚠️ 本处截图未能保存，请手动补一张')
    }
    if (box) L.push('- **范围**：约 ' + Math.round(pin.w) + '×' + Math.round(pin.h) + ' px 的区域')
    if (pin.nearText) L.push('- **该处附近的内容**：「' + pin.nearText + '」')
    L.push('')

    const desc = textWithComps(pin)
    if (desc) {
      L.push('**要求**')
      L.push('')
      desc.split('\n').forEach(function (line) { L.push('> ' + line) })
      L.push('')
    }

    const comps = (pin.comps || []).map(function (c) {
      return { c: c, comp: findComponent(c.componentId) }
    }).filter(function (x) { return x.comp })

    if (comps.length) {
      L.push('**其中用到的设计系统组件**')
      L.push('')
      comps.forEach(function (x) {
        L.push('- **' + x.comp.name + '**')
        const cfg = compConfigLines(x.comp, x.c.values)
        cfg.forEach(function (line) { L.push(line) })
        if (x.comp.snippet) {
          L.push('')
          L.push('  ```vue')
          let code = ''
          // 兜底默认打底、用户填的值覆盖（见 applyCatalog 的 snippetDefaults）
          try {
            code = x.comp.snippet(Object.assign({}, x.comp.snippetDefaults, x.c.values))
          } catch (e) { code = '（骨架生成失败）' }
          code.split('\n').forEach(function (line) { L.push('  ' + line) })
          L.push('  ```')
        }
        L.push('')
      })
    }
    return comps
  }

  /**
   * 合并 prompt：一次输出全部标记，让 CC 一趟做完。
   *
   * 每处标记 = 一段用户自己写的需求描述（组件内联在描述里）+ 该处涉及的
   * 组件明细（配置项 + 可照抄骨架）。末尾汇总所有涉及的硬约束（去重）。
   *
   * 为什么描述优先于组件：用户写的是意图（"两列布局，左边表格右上角加导出按钮"），
   * 组件只是实现意图的零件。把描述放前面，CC 才知道这些零件要怎么摆。
   */
  function buildMultiPrompt(pins, shots) {
    const L = []
    const one = pins.length === 1

    if (one) {
      L.push('按下面的要求改造页面，用到的组件来自 xiaoya 设计系统。')
    } else {
      L.push('按下面 ' + pins.length + ' 处要求改造页面，用到的组件均来自 xiaoya 设计系统。')
      L.push('')
      L.push('每处的位置见对应截图里的**蓝色标记**（编号与下面小节一一对应）。')
    }
    L.push('')
    L.push('---')

    const allRules = new Map()
    const allRefs = new Set()

    pins.forEach(function (pin, i) {
      L.push('')
      L.push('## ' + circled(pin.n) + ' ' + (isBox(pin) ? '区域改造' : '位置改造'))
      L.push('')
      // 同屏归组后多处会共用一张图，把同图的编号一并告知（见 pinSection）
      const sharedWith = shots[i]
        ? pins.filter(function (p, j) { return shots[j] === shots[i] })
              .map(function (p) { return p.n })
        : []
      const comps = pinSection(pin, shots[i], L, sharedWith)
      comps.forEach(function (x) {
        ;(x.comp.mustRules || []).forEach(function (r) { allRules.set(r, x.comp.name) })
        ;(x.comp.readRefs || []).forEach(function (r) { allRefs.add(r) })
      })
    })

    if (allRules.size) {
      L.push('---')
      L.push('')
      L.push('## 硬约束（不读细则也必须遵守）')
      L.push('')
      allRules.forEach(function (compName, rule) { L.push('- 【' + compName + '】' + rule) })
      L.push('')
    }
    if (allRefs.size) {
      L.push('## 需要展开时读这些')
      L.push('')
      L.push('> 路径相对你项目根 `CLAUDE.md` 里 `@` 指向的 design-spec 目录')
      L.push('')
      allRefs.forEach(function (r) { L.push('- `' + r + '`') })
      L.push('')
    }
    L.push('---')
    L.push('')
    L.push('骨架里的 `form.field` / `handleClick` 等占位命名请按实际业务改；样式值一律走设计令牌，不要写裸值。')
    if (pins[0] && pins[0].url) { L.push(''); L.push('页面地址：' + pins[0].url) }
    return L.join('\n')
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 组件模式不用面板
  // ══════════════════════════════════════════════════════════════════════════
  //
  // 这里曾有一整套「无选中也能开侧边面板」的机制（new 一个宿主的
  // `liaison-style-panel`、喂最小 meta 过它的显隐关卡、设 docked 触发停靠）。
  // 现在全部删掉 —— 因为面板本身没有存在的理由了：
  //
  //   · 标记清单 → 宿主「清单」tab（三类改动合一，复制也在那儿）
  //   · 写需求 / 选组件 / 改配置 / 删这一处 → 页面上的就地浮层
  //   · 剩下的只有两句提示，而「点击或划区标记」光标旁的跟随提示已经在说
  //
  // 面板曾顺带充当「打点的启动开关」（宿主 renderPanel 建出
  // #liaison-ds-root → 调 mount() → startPicking()）。这层依赖已拆开：
  // 工具条点「组件」直接调 enterComponent()，不碰任何面板 DOM。
  //
  // ⚠️ 留个记性：更早还走过一次弯路 —— 自建了一个长得一样的浮层容器，
  // 结果两套面板并存、内容重复。所以将来若又想给组件模式加面板，先问
  // 「它要显示什么是浮层和清单都放不下的」，答不出就别加。

  window.__liaisonDesignUI = {
    /**
     * 供宿主「清空」调用。
     *
     * 宿主的 clearSelectedState 只重置带 data-liaison-modified 的元素——
     * 碰不到组件名小标签（没有该属性），更不知道 state.pins 的存在。
     * 所以清空必须由我们自己做全套：清数据、清标记、关浮层、重绘面板。
     */
    clearAll() {
      state.pins = []
      state.editingPin = -1
      state.copied = false
      state.shotError = ''
      closePopover()
      hidePin()
      render()
    },

    // ── 调试/开发用：暴露内部状态 ──────────────────────────────────────
    get CATALOG() { return CATALOG },
    get GROUPS() { return GROUPS },
    get TOKENS() { return TOKENS },
    get state() { return state },

    // 暴露 loadTokens 供调试和手动触发
    loadTokens: loadTokens,

    /**
     * 供宿主「清单」tab 的复制调用：把已配好的组件点拼成一段，
     * 追加在 Page Feedback 之后。没有已配点则返回空串（宿主会跳过）。
     *
     * 会在这里逐点截图——清单复制是"一次性交付全部改动"的动作，
     * 组件的落点图也该在这时生成。
     */
    async buildOverviewSection() {
      const pins = configuredPins()
      if (!pins.length) return ''
      const shots = await captureEachPin(pins)
      return buildMultiPrompt(pins, shots)
    },

    /**
     * 供宿主「清单」tab 的单条删除调用。
     *
     * 宿主原本的删除是「重置元素样式 + 清该元素的批注」，碰不到 state.pins
     * ——那是本模块的闭包私有数据。于是在清单里删一条组件标记，页面上的
     * 圆点没了，但数据还在，复制时它会诈尸重现。所以宿主判到
     * `data-ds-pin-n` 就把删除转交给这里。
     *
     * @param n 标记编号（1-based，就是圆点上显示的那个数字）
     */
    removePinByN(n) {
      const i = state.pins.findIndex(function (p) { return p.n === n })
      if (i < 0) return false
      if (popPin === state.pins[i]) closePopover()
      state.pins.splice(i, 1)
      renderPins()   // 重新编号并重画页面标记
      state.copied = false
      render()
      return true
    },

    /**
     * 宿主面板的 renderPanel() 每次都重写整个 shadow，容器会被换成新的空 div，
     * 所以这个 mount 会被反复调用（切 tab、选中元素、改样式…）。
     * **不能每次都重置状态**——否则用户填到一半的配置、已选好的落点会被清空。
     * 只有容器真的换了才重新接管；状态一律保留，交给 render() 重绘。
     */
    /**
     * 进入组件模式：直接开始打点，**不需要任何面板**。
     *
     * 为什么不再开侧边面板：面板曾是打点的启动开关（宿主 renderPanel() 建出
     * #liaison-ds-root 容器 → 调 mount() → startPicking()），但它显示的内容
     * 已被彻底掏空 —— 清单归宿主「清单」tab，编辑归页面上的就地浮层，
     * 剩下的只有两句提示，而「点击或划区标记」这句光标旁的跟随提示已经在说了。
     * 一整块面板宽度只为说两句废话，那就不该存在。
     *
     * 于是把「启动打点」从「挂载面板」里拆出来：这个函数只做打点该做的事
     * （补建标记 + startPicking + 后台同步目录），不碰任何面板 DOM。
     * 样式仍需注入 —— 就地浮层用的是同一份 CSS。
     */
    enterComponent: function () {
      ensurePopStyle()
      if (state.pins.length && state.pins.some(function (p) { return !p.el || !p.el.isConnected })) renderPins()
      if (!state.picking) startPicking()
      if (!CATALOG.length || Date.now() - state.syncedAt > 60000) {
        state.loading = !CATALOG.length
        loadCatalog()
        loadTokens()  // 并行加载设计令牌
      }
    },

    /**
     * 退出组件模式（切到别的模式 / 关掉工具）。
     *
     * 与旧 unmount 的差别只是不碰 state.root —— 已经没有面板了。
     * 空标记照旧清掉（多半是误点），有内容的标记留在页面上：
     * 那是"这里要改"的记号，不该因为切个模式就消失。
     */
    exitComponent: function () {
      stopPicking()
      closePopover()
      const before = state.pins.length
      state.pins = state.pins.filter(function (p) {
        return (p.text && p.text.trim()) || (p.comps && p.comps.length)
      })
      if (state.pins.length !== before) renderPins()
      state.copied = false
    },

    // ── 兼容别名 ────────────────────────────────────────────────────────
    //
    // mount/unmount 曾是「面板挂载/卸载」的入口，宿主在切到 design tab 时调。
    // 面板撤掉后这条路已不可达（面板里本就没有 design 这个 tab 按钮，
    // 只有旧的 openSolo 会程序化设 _activeTab='design'，而它也删了）。
    //
    // 但名字留着并转发到 enter/exitComponent：万一宿主还有哪条路径调到，
    // 得到的是"进/出组件模式"这个正确语义，而不是 undefined 报错 —— 更不会
    // 因为 mount 又去建一个面板。rootEl 参数直接忽略。
    mount: function () { window.__liaisonDesignUI.enterComponent() },
    unmount: function () { window.__liaisonDesignUI.exitComponent() },
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 样式面板增强：为颜色/间距/圆角输入框注入 token 选择器
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 监听样式面板渲染，识别属性输入框并注入 token 按钮
   *
   * 策略：
   *   - 观察 document.body 等待 liaison-style-panel 出现
   *   - 一旦发现面板且有 shadow root，为 shadow root 内部设置 MutationObserver
   *   - Shadow root 内的 DOM 变化时触发输入框增强
   */
  /** 节点是否属于本模块注入的 UI（按钮层 / picker / 场景气泡） */
  function isOurNode(n) {
    if (!n) return false
    const el = n.nodeType === 1 ? n : n.parentElement
    return !!(el && el.closest && el.closest('[data-liaison-ds-ui]'))
  }

  function enhanceStylePanel() {
    if (typeof MutationObserver === 'undefined') return

    let observedRoot = null       // 当前已挂观察器的那个 shadow root
    let tokensLoadTriggered = false
    let rescanQueued = false

    /**
     * 合并重扫 —— 必须用 microtask，不能用 setTimeout。
     *
     * 宿主 hover 页面元素时会整段重写面板（输入框全换新节点，按钮随旧节点消失）。
     * setTimeout 哪怕只有 16ms，浏览器也会先渲染一帧「没有按钮」的画面再补回来，
     * 表现就是鼠标一动按钮就闪。microtask 在 DOM 变更后、渲染前执行 ——
     * 按钮在同一帧内补回，空白帧不存在。
     * MutationObserver 回调本身就是批量的（同一任务的变更合并成一次回调），
     * 这里再用 flag 合并一层，防同一任务里多个回调重复扫。
     */
    const scheduleRescan = function () {
      if (!TOKENS) return
      if (rescanQueued) return
      rescanQueued = true
      queueMicrotask(function () {
        rescanQueued = false
        enhanceStylePanelInputs()
      })
    }

    /**
     * 确保观察器挂在**当前**的 shadow root 上。
     *
     * 上一版用 `if (shadowObserver) return` 只绑一次 —— 宿主换掉面板元素
     * （或重建 shadow）之后，观察器还盯着已经废弃的旧 root，新面板里的输入框
     * 从此没人管，表现就是「刚打开有按钮、之后再选元素就没了」。
     * 这里改成按 root 身份判断：root 变了就重新挂。
     */
    const attach = function () {
      const panel = document.querySelector('liaison-style-panel')
      if (!panel) return   // 按钮长在面板 shadow 里，面板没了它们随之消失
      const root = panel.shadowRoot
      if (!root) return

      if (!TOKENS && !tokensLoadTriggered) {
        tokensLoadTriggered = true
        loadTokens()
      }

      if (observedRoot !== root) {
        observedRoot = root
        // ⚠️ 必须过滤自己的 mutation：按钮层 / picker / 气泡都挂在这个 shadow 里，
        // 我们每次重建它们都会触发本 observer —— 不过滤就是
        // 「重扫 → 改 DOM → 又触发重扫」的 16ms 死循环。
        new MutationObserver(function (muts) {
          const external = muts.some(function (m) {
            if (isOurNode(m.target)) return false
            const nodes = []
            m.addedNodes && nodes.push.apply(nodes, m.addedNodes)
            m.removedNodes && nodes.push.apply(nodes, m.removedNodes)
            // 变更只涉及我们自己的节点（层被建/删）→ 不算宿主动静
            if (nodes.length && nodes.every(isOurNode)) return false
            return true
          })
          if (external) scheduleRescan()
        }).observe(root, { childList: true, subtree: true })
      }
      scheduleRescan()
    }

    new MutationObserver(attach).observe(document.body, {
      childList: true, subtree: true,
    })

    // 面板可能在本脚本执行前就已存在（切 tab 回来等），主动探一次。
    // TOKENS 尚未到位时隔秒重试 —— loadTokens 是异步的。
    const poll = function () {
      attach()
      if (!TOKENS) setTimeout(poll, 1000)
    }
    setTimeout(poll, 300)
    // 按钮在输入框容器内 absolute 定位，随布局走 —— 不需要任何滚动/缩放对位逻辑。
  }

  /**
   * 宿主字段 → 令牌类别的白名单。
   *
   * 为什么是白名单而不是正则模糊匹配：上一版用 /width|height|top|left/ 之类
   * 去猜，结果把 W/H 那对复合控件也算进来 —— 它们右侧本来就有宿主自己的
   * 「固定 / 自适应」下拉，再塞一枚 token 按钮会把那个下拉挤没。
   * 宿主的 data-commit-field 是一份有限且稳定的清单（见 bundle.min.js），
   * 直接照着列，不在表里的一律不增强。
   *
   * 刻意不收的字段及理由：
   *   width / height          复合控件，右侧被「固定 / 自适应」占了
   *   widthMode / heightMode  那两个下拉本身
   *   fontFamily / fontWeight 取值是族名 / 字重，不在字阶令牌里
   *   strokePosition          枚举，不是数值
   *   textContent             文案
   *   *Opacity                百分比，设计令牌里没有对应档位
   */
  const TOKEN_FIELD_MAP = {
    // 间距：内外边距 + 自动布局间隙
    paddingTop: 'spacing', paddingRight: 'spacing',
    paddingBottom: 'spacing', paddingLeft: 'spacing',
    marginTop: 'spacing', marginRight: 'spacing',
    marginBottom: 'spacing', marginLeft: 'spacing',
    layoutGap: 'spacing',
    // 圆角：四角 + 统一
    borderRadiusAll: 'radius',
    borderRadiusTopLeft: 'radius', borderRadiusTopRight: 'radius',
    borderRadiusBottomLeft: 'radius', borderRadiusBottomRight: 'radius',
    // 字阶刻意不在 fontSize / lineHeight / letterSpacing 上开入口：
    // 语义字阶（font-body-primary 等）是「字重+字号/行高+字族」的复合令牌，
    // 拆到三个输入框上会诱导用户只改其中一项、破坏组合 —— 统一入口挂在
    // 「字体」区块标题行（见 enhanceStylePanelInputs 的 fontComposite）。
    // 颜色：文字色 / 描边色
    textHex: 'color', strokeHex: 'color',
  }

  /**
   * 识别输入框类型（color/spacing/radius/font）。
   * 只认 data-commit-field —— 那是宿主给每个字段的唯一标识，
   * 比从 class / 邻近文本上猜可靠得多。
   */
  function detectInputType(input) {
    const commitField = input.getAttribute('data-commit-field')
    if (!commitField) return null
    // 填充层是动态列表（fillLayer0Hex、fillLayer1Hex…），没法进静态白名单。
    // 渐变态的填充框是 readonly（值为「渐变填充」），色板写不进去，跳过。
    if (/^fillLayer\d+Hex$/.test(commitField)) {
      return input.readOnly ? null : 'color'
    }
    return TOKEN_FIELD_MAP[commitField] || null
  }

  /** 找「字体」区块的标题元素（面板里唯一 textContent 恰为「字体」的叶子节点） */
  function findFontSectionTitle(root) {
    const all = root.querySelectorAll('*')
    for (let i = 0; i < all.length; i++) {
      const el = all[i]
      if (el.childElementCount === 0 && el.textContent.trim() === '字体' &&
          !el.closest('[data-liaison-ds-ui]')) {
        return el
      }
    }
    return null
  }

  /**
   * 给一个输入框配一枚 token 按钮：**直接放进输入框的父容器，absolute 定位**。
   *
   * 走过两版弯路，各自的教训都留在这：
   *   ① 独立浮层 + fixed 坐标去「追」输入框 —— 位置永远慢一拍：宿主 mutation /
   *      面板滚动后都要 JS 重新算坐标，表现为按钮闪动、滚动跟随有延迟。
   *      按钮和输入框写在一起才是零延迟：布局引擎自己带着它走。
   *   ② 更早的「按钮挤掉 W/H 固定下拉」不是进容器的锅 —— 那是当时的类型误判
   *      把 width/height 也算成了间距字段，按钮盖到了宿主自带的下拉上。
   *      白名单（TOKEN_FIELD_MAP）已把 W/H 排除，进容器是安全的。
   *
   * 对宿主的两处内联改动（容器 position、input paddingRight）都随宿主
   * renderPanel() 重写 shadow 一起消失，不会累积；重写后 rescan 会重新注入。
   */
  function injectTokenButton(input, type) {
    const container = input.parentElement
    if (!container) return

    const btn = document.createElement('button')
    btn.className = 'liaison-ds-token-btn'
    // observer 靠这个属性过滤掉我们自己的 DOM 动作（见 isOurNode），
    // 否则 appendChild 进宿主容器会触发自己的重扫。
    btn.setAttribute('data-liaison-ds-ui', '')
    btn.type = 'button'
    btn.title = '从设计系统选择'
    btn.innerHTML = ICON_TOKEN
    // absolute：贴容器右缘垂直居中，不参与布局流，不挤任何兄弟控件。
    // ⚠️ 不给 z-index：按钮靠 DOM 后序已能盖住同容器的 input；
    // 设过 z-index:1 会压到宿主的弹出菜单（「添加填充/描边/投影」是 auto=0）。
    btn.style.cssText =
      'position:absolute;right:4px;top:50%;transform:translateY(-50%);' +
      'width:20px;height:20px;padding:0;border:none;' +
      'background:transparent;color:#7B838C;cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;' +
      'border-radius:4px;transition:background .15s,color .15s;'

    // hover：图标纯白 + 底色 20% 不透明度（设计确认），并直接弹出选择面板 ——
    // 按钮唯一的用途就是开面板，多一次点击没有信息量。
    btn.onmouseenter = function () {
      btn.style.background = 'rgba(255,255,255,.2)'
      btn.style.color = '#fff'
      showTokenPicker(input, type, btn)
    }
    btn.onmouseleave = function () {
      btn.style.background = 'transparent'
      btn.style.color = '#7B838C'
    }

    // 点击仍然可开（hover 失效的边缘场景兜底）
    btn.onclick = function (e) {
      e.preventDefault()
      e.stopPropagation()
      showTokenPicker(input, type, btn)
    }

    // 记住它服务哪个输入框，重扫时做集合比对用
    btn.__dsInput = input
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'
    }
    container.appendChild(btn)

    if (type === 'fontComposite') {
      // 区块标题入口：input 是「字体」标题文本节点，按钮贴行右端、与标题垂直对齐。
      // 不能用 top:50% —— 容器可能是包着整个字体区块的大盒子，50% 会落到区块中部。
      // right 与输入框内的图标（right:4px）同一条竖线，不另起一档。
      btn.style.top = (input.offsetTop + input.offsetHeight / 2) + 'px'
      btn.style.right = '4px'
    } else if (type === 'color') {
      // 颜色行是复合行（色块 + hex + 透明度%），行末元素是透明度而非 hex 输入框。
      // 留白必须给整行容器 —— 给 hex input 加 paddingRight 挡不住按钮压在「100%」上。
      // 30px = 按钮 20 + right 4 + 与数值的呼吸位 6。
      container.style.paddingRight = '30px'
    } else {
      // 有的行右端有宿主自带控件（圆角行的「独立圆角」切换按钮等），
      // 固定 right:4px 会压在它上面。探测容器右端已被占掉的宽度，排到其左侧。
      let occupied = 0
      const cRect = container.getBoundingClientRect()
      Array.prototype.forEach.call(container.children, function (ch) {
        if (ch === btn || ch === input) return
        const r = ch.getBoundingClientRect()
        if (!r.width) return
        // 只认贴着行右端的控件（距右缘 30px 内）
        if (cRect.right - r.right < 30) {
          occupied = Math.max(occupied, Math.round(cRect.right - r.left))
        }
      })
      if (occupied) btn.style.right = (occupied + 4) + 'px'
      // 给按钮让出输入区右端，长数值不被盖住。
      // 固定 26px（按钮 20 + 呼吸 6），**不加 occupied**：行尾的宿主控件
      // （圆角行的角标切换）是 flex item，input 的右边界本来就止于它左侧 ——
      // 把 occupied 算进 padding 会二次让位（63px），内容区被压瘪、整行撑破。
      // box-sizing 钉成 border-box：content-box 下加 padding 会把 input 总宽
      // 撑大，宿主控件被推出容器裁掉半个。
      input.style.boxSizing = 'border-box'
      input.style.paddingRight = '26px'
    }
  }

  // Lucide「component」图标（四菱形，设计确认）：描边风格，与宿主图标同一视觉重量
  const ICON_TOKEN =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M15.536 11.293a1 1 0 0 0 0 1.414l2.376 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/>' +
    '<path d="M2.297 11.293a1 1 0 0 0 0 1.414l2.377 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414L6.088 8.916a1 1 0 0 0-1.414 0z"/>' +
    '<path d="M8.916 17.912a1 1 0 0 0 0 1.415l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.415l-2.377-2.376a1 1 0 0 0-1.414 0z"/>' +
    '<path d="M8.916 4.674a1 1 0 0 0 0 1.414l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/></svg>'

  // 当前开着的选择面板（同一时刻至多一个）。宿主重写 shadow 会把它连带销毁，
  // restoreActivePicker 靠这个引用捞回来；用户主动关闭的路径负责清空它。
  let activePicker = null

  /** 移除面板里现存的全部 token 按钮（宿主重写 shadow 时旧的随之消失，无需处理） */
  function clearTokenBtns(root) {
    if (!root) return
    root.querySelectorAll('.liaison-ds-token-btn').forEach(function (b) {
      const input = b.__dsInput
      if (input) input.style.removeProperty('padding-right')
      // color 类的留白加在容器上（复合行），一并还原；其它容器没设过，无害
      if (b.parentElement) b.parentElement.style.removeProperty('padding-right')
      b.remove()
    })
  }

  /**
   * 显示 token 选择面板
   *
   * 策略：将选择器渲染到 shadow DOM 内部，避开 liaison 的页面级事件捕获
   */
  function showTokenPicker(input, type, triggerBtn) {
    const panel = document.querySelector('liaison-style-panel')
    const shadowRoot = panel && (panel.shadowRoot || panel)

    // 同一个按钮的面板已开着 → 只取消待执行的关闭，不重建（重建会闪）。
    // hover 开启后鼠标在按钮和面板之间来回，mouseenter 会反复触发。
    const opened = (shadowRoot && shadowRoot.querySelector('.liaison-ds-token-picker')) ||
      document.querySelector('.liaison-ds-token-picker')
    if (opened) {
      if (opened.__dsTrigger === triggerBtn) {
        if (opened.__dsCancelClose) opened.__dsCancelClose()
        return
      }
      opened.remove()
      hideSceneTip()
    }

    // 创建面板
    const picker = document.createElement('div')
    picker.className = 'liaison-ds-token-picker'
    picker.setAttribute('data-liaison-ds-ui', '')
    picker.__dsTrigger = triggerBtn

    // 定位到按钮下方
    const rect = triggerBtn.getBoundingClientRect()
    // 记住锚点：宿主重写 shadow 后 restoreActivePicker 靠它找回新一代触发按钮
    picker.__dsAnchorRect = { left: rect.left, top: rect.top }
    const PICKER_W = 240
    // 水平：默认左缘对齐按钮向右展开；面板停靠在屏幕右侧时会超出右缘，
    // 此时改为右缘对齐按钮向左展开（朝页面区域）。
    let left = rect.left
    if (left + PICKER_W > window.innerWidth - 8) {
      left = Math.max(8, rect.right - PICKER_W)
    }
    // 垂直：按钮上下两侧谁空间大往谁那边弹。按钮在面板下部时下方只剩一两条的
    // 高度，硬往下弹会把列表压成一条缝 —— 上方更大就翻上去（bottom 锚定贴按钮
    // 上沿，实际高度不足 maxHeight 时也紧贴按钮、不会悬空）。
    const spaceBelow = window.innerHeight - rect.bottom - 24
    const spaceAbove = rect.top - 24
    const openUp = spaceBelow < 300 && spaceAbove > spaceBelow
    const maxHeight = Math.min(400, Math.max(160, openUp ? spaceAbove : spaceBelow))
    const vAnchor = openUp
      ? 'bottom:' + (window.innerHeight - rect.top + 4) + 'px;'
      : 'top:' + (rect.bottom + 4) + 'px;'

    // 样式：深色主题，符合 liaison 设计规范
    picker.style.cssText =
      'position:fixed;width:240px;max-height:' + maxHeight + 'px;' +
      'background:#1E2530;' +
      'border:1px solid #2D3748;border-radius:6px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,0.4);' +
      'z-index:2147483647;overflow:hidden;display:flex;flex-direction:column;' +
      'pointer-events:auto;' +
      'left:' + left + 'px;' + vAnchor

    // 填充内容
    picker.innerHTML = renderTokenPickerContent(type, maxHeight)

    // 优先渲染到 shadow root 内部（避开页面级事件拦截）
    const host = shadowRoot || document.body
    host.appendChild(picker)

    // 行 hover：底色 + 场景图标点亮 + 场景气泡。
    // 气泡与 picker 挂同一个宿主，免得 shadow 内外各一份定位参考系。
    bindTokenItemHover(picker, host)

    // ── hover 生命周期：移开自动关，带 250ms 宽限 ──────────────────────
    // 面板由 hover 打开，鼠标从按钮平移进面板的途中会先离开按钮 ——
    // 立即关就永远选不到值。宽限期内进入面板（或回到按钮）则取消关闭。
    let closeTimer = null
    const doClose = function () {
      picker.remove()
      hideSceneTip()
      if (activePicker === picker) activePicker = null
    }
    const scheduleClose = function () {
      if (closeTimer) clearTimeout(closeTimer)
      closeTimer = setTimeout(doClose, 250)
    }
    const cancelClose = function () {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    }
    picker.__dsCancelClose = cancelClose
    picker.__dsScheduleClose = scheduleClose
    activePicker = picker
    picker.addEventListener('mouseenter', cancelClose)
    picker.addEventListener('mouseleave', scheduleClose)
    // addEventListener 不会覆盖按钮上已有的 onmouseenter/onmouseleave 属性
    triggerBtn.addEventListener('mouseenter', cancelClose)
    triggerBtn.addEventListener('mouseleave', scheduleClose)

    // 点击外部关闭（点了别处 = 明确不想选，不等宽限）
    setTimeout(function () {
      const close = function (e) {
        if (!picker.contains(e.target) && e.target !== triggerBtn) {
          doClose()
          host.removeEventListener('click', close)
        }
      }
      host.addEventListener('click', close)
    }, 0)

    // 绑定选择事件
    picker.querySelectorAll('[data-token-value]').forEach(function (item) {
      item.onclick = function (e) {
        e.stopPropagation()
        e.preventDefault()
        const value = item.getAttribute('data-token-value')

        // 先关闭选择器（气泡是独立节点，得一起收）
        picker.remove()
        hideSceneTip()
        if (activePicker === picker) activePicker = null

        // 语义字阶：input 参数是「字体」标题节点，不能往它身上写值 ——
        // 走复合应用路径，同步写字重/字号/行高/字族四个字段。
        if (type === 'fontComposite') {
          applyCompositeFont(value)
          return
        }

        // 带透明度的色（描边/遮罩组）：hex 与透明度分两个字段写。
        // 透明度框的字段名 = hex 字段名把 Hex 换成 Opacity（textHex→textOpacity、
        // fillLayer0Hex→fillLayer0Opacity），与宿主命名约定一致。
        if (type === 'color') {
          const alpha = item.getAttribute('data-token-alpha')
          const hexField = input.getAttribute('data-commit-field') || ''
          const opField = hexField.replace(/Hex$/, 'Opacity')
          if (opField !== hexField) {
            const opInput = input.getRootNode().querySelector(
              'input[data-commit-field="' + opField + '"]')
            if (opInput) {
              // 没标 alpha 的实色令牌回写 100%——不清的话上一次选的半透明会残留
              opInput.value = (alpha != null ? alpha : '100') + '%'
              opInput.dispatchEvent(new Event('blur', { bubbles: true }))
              opInput.dispatchEvent(new Event('change', { bubbles: true }))
            }
          }
        }

        // 设置值（宿主的 hex 框吃不带 # 的纯 hex）
        input.value = type === 'color' ? value.replace(/^#/, '') : value

        // 用 Object.defineProperty 临时锁定 value，阻止拖动逻辑覆盖
        // 这比拦截 mousemove 更精准，不会影响其他事件
        try {
          const lockedValue = value
          Object.defineProperty(input, 'value', {
            get: function () { return lockedValue },
            set: function () { /* 锁定期间忽略写入 */ },
            configurable: true,
          })
          setTimeout(function () {
            try {
              // 恢复原生 value 行为
              delete input.value
              // 再次确保值已设置
              input.value = lockedValue
            } catch (e) {}
          }, 400)
        } catch (e) {
          // 降级：直接设置
        }

        // 触发 blur 让面板提交
        input.dispatchEvent(new Event('blur', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
  }

  // 语义字阶复合值的形态：`<字重> <字号rem> / <行高rem> <字族>`（斜杠两侧可有空格）
  const COMPOSITE_FONT_RE = /^(\d{3})\s+([\d.]+)rem\s*\/\s*([\d.]+)rem\s+(.+)$/

  /**
   * 复合值先折叠空白再解析。
   * $font-family-base 在 SCSS 里是多行定义，展开进复合值后带换行 ——
   * 正则的 `.` 不跨行，系统字族的条目会整批匹配失败（列表只剩阿里普惠/数字体 5 条）。
   */
  function normFontValue(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
  }

  /** 字族串 → 人话标签（列表摘要用） */
  function fontFamilyLabel(family) {
    if (/douyinNum/i.test(family)) return '数字体'
    if (/PuHuiTi/i.test(family)) return '阿里普惠'
    return '系统'
  }

  /**
   * 应用一条语义字阶：解析复合值，把字重 / 字号 / 行高 / 字族**同步**写进
   * 面板对应的四个字段 —— 语义字阶的意义就是这四项作为一个整体成立，
   * 只写其中一项等于把令牌拆散。rem → px 按根字号 16 换算（面板输入框吃 px 数值）。
   */
  function applyCompositeFont(value) {
    const m = COMPOSITE_FONT_RE.exec(normFontValue(value))
    if (!m) return
    const panel = document.querySelector('liaison-style-panel')
    const root = panel && (panel.shadowRoot || panel)
    if (!root) return
    const fields = {
      fontWeight: m[1],
      fontSize: String(parseFloat(m[2]) * 16),
      lineHeight: String(parseFloat(m[3]) * 16),
      fontFamily: m[4].trim(),
    }
    Object.keys(fields).forEach(function (key) {
      const inp = root.querySelector('input[data-commit-field="' + key + '"]')
      if (!inp) return
      inp.value = fields[key]
      // 与单值路径同一套提交流程：blur 触发宿主 commitField
      inp.dispatchEvent(new Event('blur', { bubbles: true }))
      inp.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  /**
   * 语义色板：按规范站的分组渲染（主题色 / 成功色 / … 顺序也照规范站），
   * 条目一行式「色块 + 中文名 + 色值」—— 上一版每条三行把列表撑得只显示两条。
   * 只列解析成了字面 hex 的条目：var(...) / 渐变写进宿主的 hex 框没有意义。
   */
  function renderColorPickerContent(maxHeight) {
    const groups = TOKENS.semanticColorGroups || {}
    const baseOrder = (TOKENS.semanticColorGroupOrder && TOKENS.semanticColorGroupOrder.length)
      ? TOKENS.semanticColorGroupOrder
      : Object.keys(groups)
    // 文本色 / 背景色置顶（设计确认）：改样式时最常取的是这两组，
    // 品牌五件套反而低频。其余保持规范站顺序。
    const order = ['text', 'bg'].concat(baseOrder.filter(function (k) {
      return k !== 'text' && k !== 'bg'
    }))
    const titles = TOKENS.semanticColorGroupTitles || {}

    let html = '<div style="padding:10px 12px;border-bottom:1px solid #2D3748;' +
      'font-weight:500;font-size:13px;color:#E2E8F0;flex-shrink:0;">语义色板</div>'
    const scrollHeight = (maxHeight || 400) - 43
    html += '<div style="overflow-y:auto;overscroll-behavior:contain;max-height:' + scrollHeight + 'px;padding:6px;">'

    let any = false
    order.forEach(function (key) {
      // 只列规范站收录的条目（有中文名）：text-on-light 这类 demo 未展示的
      // 内部变量不该出现在设计师面前。
      const list = (groups[key] || []).filter(function (t) {
        return t.comment && /^#[0-9a-fA-F]{6}$/.test(t.value)
      })
      if (!list.length) return
      any = true
      html += '<div style="padding:8px 10px 4px;font-size:11px;color:#718096;">' +
        esc(titles[key] || key) + '</div>'
      list.forEach(function (t) {
        const hasAlpha = typeof t.alpha === 'number' && t.alpha < 100
        // 色块用 8 位 hex 呈现真实透明度；值文字附上百分比
        const swatch = hasAlpha
          ? t.value + Math.round(t.alpha * 2.55).toString(16).padStart(2, '0')
          : t.value
        const valueText = t.value.toUpperCase() + (hasAlpha ? ' ' + t.alpha + '%' : '')
        html +=
          '<div class="liaison-ds-token-item" data-token-value="' + esc(t.value) + '"' +
          (hasAlpha ? ' data-token-alpha="' + t.alpha + '"' : '') + ' ' +
          'style="display:flex;align-items:center;gap:8px;padding:6px 10px;' +
          'border-radius:4px;cursor:pointer;transition:background .15s;background:transparent;">' +
          '<span style="width:14px;height:14px;border-radius:3px;flex:0 0 auto;' +
          'background:' + swatch + ';border:1px solid #2D3748;"></span>' +
          '<span style="flex:1 1 auto;font-size:12px;color:#E2E8F0;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;">' + esc(t.comment || t.name) + '</span>' +
          '<span style="font-size:11px;color:#A0AEC0;font-family:\'SF Mono\',Menlo,monospace;">' +
          esc(valueText) + '</span></div>'
      })
    })
    if (!any) html += '<div style="padding:16px;color:#718096;">暂无可用令牌</div>'
    html += '</div>'
    return html
  }

  /**
   * 渲染 token 选择面板内容
   */
  function renderTokenPickerContent(type, maxHeight) {
    if (!TOKENS) return '<div style="padding:16px;color:#718096;">令牌加载中...</div>'

    // 语义色板走独立渲染：按规范站分组，条目只留中文名 + 色值
    if (type === 'color') return renderColorPickerContent(maxHeight)

    let tokens = []
    let title = ''

    if (type === 'spacing') {
      title = '间距'
      tokens = TOKENS.spacing || []
    } else if (type === 'radius') {
      title = '圆角'
      tokens = TOKENS.radius || []
    } else if (type === 'font') {
      title = '字阶'
      tokens = TOKENS.fontScale || []
    } else if (type === 'fontComposite') {
      // 语义字阶：只取「字重 字号/行高 字族」的复合条目，
      // 排除 font-family-* / font-size-* / font-weight-* 这些底层单项。
      title = '语义字阶'
      tokens = (TOKENS.fontScale || []).filter(function (t) {
        return COMPOSITE_FONT_RE.test(normFontValue(t.value))
      })
    }

    if (!tokens.length) {
      return '<div style="padding:16px;color:#718096;">暂无可用令牌</div>'
    }

    // 标题栏
    let html = '<div style="padding:10px 12px;border-bottom:1px solid #2D3748;' +
      'font-weight:500;font-size:13px;color:#E2E8F0;flex-shrink:0;">' + title + '</div>'

    // 滚动区域：减去标题栏高度
    const scrollHeight = (maxHeight || 400) - 43
    html += '<div style="overflow-y:auto;overscroll-behavior:contain;max-height:' + scrollHeight + 'px;padding:6px;">'

    tokens.forEach(function (token) {
      let displayName = token.name
      let subLabel = token.comment || ''
      let displayValue = token.value.length > 30 ? token.value.slice(0, 30) + '...' : token.value
      // 语义字阶：中文名为主（设计师认「页面标题」不认 title-page），
      // 英文名降为小字；值行换成人话摘要「26/48 · 800 · 阿里普惠」——
      // 原始 font 简写又长又全是 rem，没法读。
      if (type === 'fontComposite') {
        const en = token.name.replace(/^font-/, '')
        displayName = token.comment || en
        subLabel = token.comment ? en : ''
        const m = COMPOSITE_FONT_RE.exec(normFontValue(token.value))
        if (m) {
          displayValue = (parseFloat(m[2]) * 16) + '/' + (parseFloat(m[3]) * 16) +
            ' · ' + m[1] + ' · ' + fontFamilyLabel(m[4])
        }
      }
      const comment = subLabel ? '<span style="color:#718096;font-size:11px;margin-left:4px;">· ' + esc(subLabel) + '</span>' : ''

      // 对于样式面板的输入框，传入实际值而不是 CSS 变量
      const actualValue = token.value

      // 应用场景：间距令牌有 scenes 数组（spacing-usage.ts）；圆角令牌的场景
      // 写在行内注释里（「Tag、Checkbox、Select item…」），按顿号拆开后走同一套
      // i 图标 + hover 气泡 —— 内联在名字后面会把一行撑成三行。
      // 挂在 data-* 上而不是直接渲染进 DOM：一条令牌可能有 7 条场景，
      // 全铺出来会把列表撑成一屏只放得下两三项，所以收进 hover 气泡。
      let scenes = Array.isArray(token.scenes) ? token.scenes : null
      if (!scenes && type === 'radius' && token.comment) {
        scenes = token.comment.split('、').map(function (s) { return s.trim() }).filter(Boolean)
        subLabel = ''   // 场景进了气泡，名字行不再拼注释
      }
      const sceneAttr = scenes
        ? ' data-token-scenes="' + esc(scenes.join('\n')) + '"'
        : ''

      html +=
        '<div class="liaison-ds-token-item" data-token-value="' + esc(actualValue) + '"' + sceneAttr + ' ' +
        'style="position:relative;padding:8px 10px;border-radius:4px;cursor:pointer;' +
        'margin-bottom:2px;transition:background .15s;background:transparent;">' +
        '<div style="font-size:12px;color:#E2E8F0;margin-bottom:2px;font-weight:500;">' + displayName + comment + '</div>' +
        '<div style="font-size:11px;color:#A0AEC0;font-family:\'SF Mono\',Menlo,monospace;">' + displayValue + '</div>'

      // 场景图标：常态半隐，hover 该行时点亮（见 bindTokenItemHover）。
      // 放右上角而不是跟在值后面 —— 值那行是等宽数字，插图标会破坏对齐。
      if (scenes) {
        html +=
          '<span class="liaison-ds-scene-ico" style="position:absolute;right:8px;top:8px;' +
          'width:16px;height:16px;display:flex;align-items:center;justify-content:center;' +
          'color:#718096;opacity:.6;transition:opacity .15s,color .15s;">' + ICON_INFO + '</span>'
      }

      // 颜色类型显示色块预览
      if (type === 'color' && (token.value.startsWith('#') || token.value.startsWith('rgb'))) {
        html +=
          '<div style="width:100%;height:20px;margin-top:6px;border-radius:3px;' +
          'background:' + token.value + ';border:1px solid #2D3748;"></div>'
      }

      html += '</div>'
    })

    html += '</div>'
    return html
  }

  // 场景提示图标（i）。用描边而非实心：它是常态半隐的辅助标记，
  // 实心圆在深色底上太像一个可点的主操作。
  const ICON_INFO =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4"/><path d="M8 4.9v.3"/></svg>'

  // 场景气泡。整个选择器共用一个，跟着 hover 的行走 —— 每行各建一个的话，
  // 10 条令牌就是 10 个常驻 DOM，且都要各自处理越界翻转。
  let sceneTipEl = null

  function ensureSceneTip(host) {
    if (sceneTipEl && sceneTipEl.isConnected) return sceneTipEl
    sceneTipEl = document.createElement('div')
    sceneTipEl.className = 'liaison-ds-scene-tip'
    sceneTipEl.setAttribute('data-liaison-ds-ui', '')
    // z-index 比选择器本身高一档：气泡要压在选择器上沿之外
    sceneTipEl.style.cssText =
      'position:fixed;max-width:260px;padding:8px 10px;border-radius:6px;' +
      'background:#0F1520;border:1px solid #2D3748;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.5);' +
      'font-size:11px;line-height:1.6;color:#CBD5E0;' +
      'z-index:2147483647;pointer-events:none;display:none;'
    host.appendChild(sceneTipEl)
    return sceneTipEl
  }

  function showSceneTip(item, host) {
    const raw = item.getAttribute('data-token-scenes')
    if (!raw) return
    const tip = ensureSceneTip(host)
    // 多条场景排成带项目符号的列表；单条就直接一行，不必加符号
    const lines = raw.split('\n')
    tip.innerHTML =
      '<div style="color:#718096;font-size:10px;margin-bottom:4px;">应用场景</div>' +
      lines.map(function (s) {
        return lines.length > 1
          ? '<div style="display:flex;gap:6px;"><span style="color:#4A5568;">·</span>' +
            '<span>' + esc(s) + '</span></div>'
          : '<div>' + esc(s) + '</div>'
      }).join('')

    tip.style.display = 'block'
    // 先显示再量尺寸 —— display:none 时 offsetWidth 恒为 0
    const r = item.getBoundingClientRect()
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    // 固定优先右侧：选择器右边是页面区域，几乎总有空间。
    // 「优先左、放不下翻右」会随选择器位置忽左忽右，读起来像两套交互。
    let left = r.right + 8
    if (left + w > window.innerWidth - 8) left = r.left - w - 8   // 右边真放不下才翻左
    if (left < 8) left = 8
    let top = r.top + r.height / 2 - h / 2        // 与行垂直居中对齐
    if (top < 8) top = 8
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8)
    tip.style.left = left + 'px'
    tip.style.top = top + 'px'
  }

  function hideSceneTip() {
    if (sceneTipEl) sceneTipEl.style.display = 'none'
  }

  /**
   * 令牌行的 hover：行底色 + 场景图标点亮 + 场景气泡。
   *
   * 用事件委托而不是给每行绑监听：行是 innerHTML 一次性生成的，
   * 委托到容器上只需一对监听器，重渲染也不必重绑。
   */
  function bindTokenItemHover(picker, host) {
    picker.addEventListener('mouseover', function (e) {
      const item = e.target.closest && e.target.closest('.liaison-ds-token-item')
      if (!item || item.__dsHovered) return
      item.__dsHovered = true
      item.style.background = '#2D3748'
      const ico = item.querySelector('.liaison-ds-scene-ico')
      if (ico) { ico.style.opacity = '1'; ico.style.color = '#E2E8F0' }
      showSceneTip(item, host)
    })
    picker.addEventListener('mouseout', function (e) {
      const item = e.target.closest && e.target.closest('.liaison-ds-token-item')
      if (!item) return
      // 在行内部子元素之间移动会连发 mouseout/mouseover，不能就此收起
      if (e.relatedTarget && item.contains(e.relatedTarget)) return
      item.__dsHovered = false
      item.style.background = 'transparent'
      const ico = item.querySelector('.liaison-ds-scene-ico')
      if (ico) { ico.style.opacity = '.6'; ico.style.color = '#718096' }
      hideSceneTip()
    })
  }

  // 初始化样式面板增强
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceStylePanel)
  } else {
    enhanceStylePanel()
  }
})()
