// ============================================================================
// 线上参考 · 全屏资产库管理界面（Eagle 风格网格图墙）
// ----------------------------------------------------------------------------
// 只在「线上参考」面板 **全屏态** 使用。非全屏仍走 bundle 里原有的简单时间倒序
// 列表，本模块完全不介入。
//
// 架构：bundle.min.js 的 renderInspirationPanel() 在检测到 data-fullscreen 时，
// 返回一个空的挂载容器 `<div id="liaison-asset-ui-root">`，然后调用
// window.__liaisonAssetUI.mount(rootEl, ctx)。本模块接管该容器内的全部渲染与
// 交互，数据通过 bundle 暴露的 window.__liaisonInsp（list/remove/updateTags/
// buildPromptAsync）读写。ctx.exitFullscreen 用于「退出全屏」按钮。
//
// 交互要点（吸取首版教训）：
//  - 卡片默认只显示缩略图，hover 才淡入信息+操作（动效）。
//  - 搜索只重绘网格、不重建输入框，并监听 composition 事件 → 中文输入法可用。
//  - 打标签用内联输入框，不用 window.prompt（扩展内容脚本里会被浏览器拦截）。
//  - 局部更新为主，避免整体 render() 导致闪屏。
// ============================================================================

;(function () {
  if (typeof window === 'undefined' || window.__liaisonAssetUI) return

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))

  // 卡片尺寸偏好持久化（页面级 localStorage，全屏库专用键）
  const COL_W_KEY = 'liaison-asset-col-w'
  const COL_W_MIN = 140
  const COL_W_MAX = 480

  const state = {
    root: null,
    ctx: null,
    snapshots: [],   // 未删除的
    trash: [],       // 回收站（deleted）
    query: '',
    view: 'all',     // 'all' | 'untagged' | 'trash' | {tag:'xxx'}
    composing: false, // 中文输入法组合中
    colW: readColW(), // 卡片列宽下限（px），受右下角滑块控制，存 localStorage
    tagOrders: {},    // 每标签自定义顺序 { tag: [id,...] }，标签视图拖拽排序用
  }

  function readColW() {
    try {
      const v = parseInt(localStorage.getItem(COL_W_KEY), 10)
      if (v >= 140 && v <= 480) return v
    } catch (_) {}
    return 200
  }
  function applyColW(w) {
    state.colW = w
    try { localStorage.setItem(COL_W_KEY, String(w)) } catch (_) {}
    // 同步写扩展全局存储，跨网站/重开扩展都记住
    if (window.__liaisonInsp && window.__liaisonInsp.setColW) {
      try { window.__liaisonInsp.setColW(w) } catch (_) {}
    }
    const rootEl = state.root && state.root.querySelector('.lau-root')
    if (rootEl) rootEl.style.setProperty('--lau-col-w', w + 'px')
  }

  const CSS = `
  .lau-root{position:absolute;inset:0;box-sizing:border-box;display:flex;color:#e8eaed;font-family:-apple-system,"PingFang SC","Segoe UI",sans-serif;font-size:13px;line-height:1.5;text-align:left;letter-spacing:normal;word-break:normal;white-space:normal;}
  .lau-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;padding:24px;box-sizing:border-box;}
  .lau-topbar{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:0 0 16px;}
  .lau-search{flex:1 1 auto;display:flex;align-items:center;gap:8px;height:36px;box-sizing:border-box;background:rgba(255,255,255,.06);border:none;border-radius:10px;padding:0 12px;}
  .lau-search input{flex:1;background:transparent;border:none;outline:none;color:#e8eaed;font-size:14px;}
  .lau-search input::placeholder{color:rgba(232,234,237,.4);}
  .lau-search-ico{flex:0 0 auto;color:rgba(232,234,237,.45);}
  .lau-count{flex:0 0 auto;font-size:12px;color:rgba(232,234,237,.5);white-space:nowrap;}
  .lau-exit{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;font-size:13px;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.06);border:none;color:#e8eaed;cursor:pointer;transition:background .12s;}
  .lau-exit:hover{background:rgba(255,255,255,.14);}
  .lau-empty-trash{color:#ff8f8f;border-color:rgba(255,110,110,.32);}
  .lau-empty-trash:hover{background:rgba(255,80,80,.16);border-color:rgba(255,110,110,.5);}
  .lau-empty-trash.lau-confirming{background:rgba(255,80,80,.22);color:#ffd0d0;border-color:rgba(255,110,110,.6);}
  .lau-side{flex:0 0 200px;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;background:rgba(0,0,0,.22);padding:24px 14px;}
  .lau-side-back{display:inline-flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;margin-bottom:14px;font-size:13px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.06);border:none;color:#e8eaed;cursor:pointer;transition:background .12s;}
  .lau-side-back:hover{background:rgba(255,255,255,.14);}
  .lau-side-title{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:rgba(232,234,237,.4);margin:6px 6px 8px;}
  .lau-tag-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:#d7d9dc;transition:background .12s;}
  .lau-tag-item:hover{background:rgba(255,255,255,.06);}
  .lau-tag-item.active{background:rgba(255,255,255,.2);color:#fff;}
  .lau-tag-count{font-size:11px;color:rgba(232,234,237,.4);}
  .lau-empty-side{font-size:12px;color:rgba(232,234,237,.35);padding:8px 10px;line-height:1.5;}
  .lau-side-taghead{padding:10px 8px 6px;font-size:11px;letter-spacing:.05em;color:rgba(232,234,237,.4);text-transform:uppercase;}
  .lau-side-newtag{margin-top:auto;width:100%;box-sizing:border-box;text-align:center;background:rgba(255,255,255,.06);border:1px dashed rgba(255,255,255,.22);color:rgba(232,234,237,.8);padding:7px 10px;border-radius:8px;cursor:pointer;font-size:13px;}
  .lau-side-newtag:hover{background:rgba(255,255,255,.12);color:#fff;}
  .lau-tag-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  /* 右侧：数字默认右对齐；hover 出 ⋯ 后 ⋯ 占位，把数字往左挤 */
  .lau-tag-right{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;}
  .lau-tag-menu{width:0;overflow:hidden;opacity:0;background:none;border:none;color:rgba(232,234,237,.7);cursor:pointer;font-size:14px;line-height:1;padding:0;border-radius:4px;transition:opacity .12s,width .12s;}
  .lau-tag-item:hover .lau-tag-menu{width:16px;opacity:1;}
  .lau-tag-menu:hover{color:#fff;}
  /* 标签管理小菜单 */
  .lau-tagmenu-pop{position:absolute;z-index:60;min-width:120px;background:#20242c;border:none;border-radius:9px;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:5px;}
  .lau-tagmenu-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;font-size:12px;color:#dfe1e4;cursor:pointer;}
  .lau-tagmenu-item:hover{background:rgba(255,255,255,.2);color:#fff;}
  .lau-tagmenu-item.danger:hover{background:rgba(255,80,80,.22);}
  .lau-tagmenu-input{width:100%;box-sizing:border-box;font-size:12px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.08);border:1px solid rgba(120,140,255,.5);color:#fff;outline:none;}
  .lau-grid-wrap{flex:1 1 auto;overflow:auto;overscroll-behavior:contain;}
  .lau-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--lau-col-w,200px),1fr));gap:14px;padding:2px 2px 24px;align-content:start;}

  /* 卡片：等高，缩略图在固定高度区内居中；hover 淡入操作层 */
  .lau-card{position:relative;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);transition:border-color .18s,transform .18s,box-shadow .18s;}\n  .lau-card.lau-removing{animation:lau-card-collapse .3s cubic-bezier(0.4,0,1,1) forwards;pointer-events:none;}\n  @keyframes lau-card-collapse{0%{opacity:1;transform:scale(1);}100%{opacity:0;transform:scale(.9);}}
  .lau-card:hover{border-color:rgba(255,255,255,.32);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.35);}
  .lau-grid.lau-enter .lau-card{opacity:0;animation:lau-card-in .65s ease forwards;animation-delay:calc(320ms + var(--lau-i,0)*55ms);}
  @keyframes lau-card-in{to{opacity:1;}}
  /* hover/pinned 时整卡加一层黑色 20% 遮罩（压在缩略图上、操作层下） */
  .lau-card::before{content:"";position:absolute;inset:0;background:rgba(0,0,0,.2);opacity:0;transition:opacity .2s ease;pointer-events:none;z-index:1;}
  .lau-card:hover::before,.lau-card.lau-card-pinned::before{opacity:1;}
  .lau-thumb-box{display:flex;align-items:center;justify-content:center;width:100%;height:calc(var(--lau-col-w,200px) * 1.2);background:#ffffff;overflow:hidden;}
  .lau-thumb{display:block;max-width:100%;max-height:100%;object-fit:contain;}
  .lau-thumb-fallback{display:flex;align-items:center;justify-content:center;width:100%;height:calc(var(--lau-col-w,200px) * 1.2);font-size:13px;color:rgba(232,234,237,.4);text-transform:uppercase;}

  .lau-overlay{position:absolute;left:0;right:0;bottom:0;padding:12px 11px 11px;z-index:2;
    background:linear-gradient(to top,rgba(12,14,18,.94) 0%,rgba(12,14,18,.82) 55%,rgba(12,14,18,0) 100%);
    opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;pointer-events:none;}
  .lau-card:hover .lau-overlay,.lau-card.lau-card-pinned .lau-overlay{opacity:1;transform:translateY(0);pointer-events:auto;}
  /* popover 打开时卡片保持"选中"态，鼠标移到 popover 上也不淡出 */
  .lau-card.lau-card-pinned{border-color:rgba(255,255,255,.32);z-index:20;}
  .lau-card-tags{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;align-items:center;}
  .lau-note{display:block;width:100%;box-sizing:border-box;font-size:12px;line-height:1.4;padding:6px 8px;margin:0 0 8px;border-radius:7px;background:rgba(255,255,255,.08);border:1px solid transparent;color:#e8eaed;outline:none;resize:none;min-height:32px;max-height:80px;font-family:inherit;vertical-align:top;}
  .lau-note:focus{background:rgba(255,255,255,.12);}
  .lau-note::placeholder{color:rgba(232,234,237,.4);}
  .lau-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 7px;border-radius:20px;background:rgba(120,140,255,.28);color:#eef1ff;}
  .lau-chip button{background:none;border:none;color:inherit;cursor:pointer;padding:0;font-size:12px;line-height:1;opacity:.7;}
  .lau-chip button:hover{opacity:1;}
  .lau-tag-add{font-size:11px;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.1);border:1px dashed rgba(255,255,255,.3);color:rgba(232,234,237,.85);cursor:pointer;}
  .lau-tag-add:hover{background:rgba(255,255,255,.18);color:#fff;}

  /* 打标签下拉：已有标签可选 + 底部输入可新增 */
  .lau-tagpop{position:absolute;z-index:50;min-width:150px;max-width:220px;background:#20242c;border:1px solid rgba(255,255,255,.16);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:6px;}
  .lau-tagpop-list{max-height:160px;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:2px;margin-bottom:6px;}
  .lau-tagpop-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:7px;font-size:12px;color:#dfe1e4;cursor:pointer;}
  .lau-tagpop-item:hover{background:rgba(120,140,255,.22);color:#fff;}
  .lau-tagpop-item.checked{color:#8fa4ff;}
  .lau-tagpop-empty{font-size:11px;color:rgba(232,234,237,.4);padding:4px 8px;}
  .lau-tagpop-input{width:100%;box-sizing:border-box;font-size:12px;padding:6px 8px;border-radius:7px;background:rgba(255,255,255,.08);border:1px solid rgba(120,140,255,.5);color:#fff;outline:none;}
  .lau-card-actions{display:flex;gap:8px;}
  .lau-btn{flex:1;font-size:12px;line-height:1.4;padding:6px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent;transition:background .12s;}
  .lau-btn-primary{background:#65ffb6;color:#12151A;font-weight:600;}
  .lau-btn-primary:hover{background:#7affc4;}
  .lau-btn-ghost{background:rgba(255,255,255,.1);color:#e8eaed;}
  .lau-btn-ghost:hover{background:rgba(255,255,255,.18);}
  .lau-empty{grid-column:1/-1;text-align:center;color:rgba(232,234,237,.4);font-size:14px;padding:60px 0;}
  /* 右下角卡片尺寸滑块 */
  .lau-sizer{position:absolute;right:24px;bottom:24px;z-index:40;display:flex;align-items:center;gap:9px;padding:8px 13px;border-radius:12px;background:rgba(28,32,40,.82);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.12);box-shadow:0 6px 20px rgba(0,0,0,.4);opacity:.55;transition:opacity .18s;}
  .lau-sizer:hover{opacity:1;}
  .lau-sizer svg{flex:0 0 auto;color:rgba(232,234,237,.7);}
  .lau-sizer input[type=range]{-webkit-appearance:none;appearance:none;width:110px;height:4px;border-radius:2px;background:rgba(255,255,255,.22);outline:none;cursor:pointer;}
  .lau-sizer input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#e8eaed;border:none;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.4);}
  .lau-sizer input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#e8eaed;border:none;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.4);}
  /* 卡片右上角来源图标：hover 显示网址(title)，点击新标签打开 */
  .lau-src{position:absolute;top:8px;right:8px;z-index:3;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:rgba(20,22,28,.55);color:rgba(255,255,255,.72);backdrop-filter:blur(4px);opacity:0;transition:opacity .18s,background .12s,color .12s;text-decoration:none;pointer-events:none;}
  .lau-card:hover .lau-src,.lau-card.lau-card-pinned .lau-src{opacity:1;pointer-events:auto;}
  .lau-src:hover{background:rgba(34,197,94,.85);color:#fff;}
  /* 拖拽排序（仅「全部」视图 + 无搜索时启用）*/
  .lau-grid.lau-reorderable{position:relative;}
  .lau-grid.lau-reorderable .lau-thumb-box,.lau-grid.lau-reorderable .lau-thumb-fallback{cursor:grab;}
  .lau-card.lau-dragging{opacity:.35;transform:scale(.97);}
  /* 插入指示条：一条明显的竖向高亮，绝对定位到落点 */
  .lau-drop-indicator{position:absolute;width:2px;border-radius:2px;background:#22c55e;box-shadow:0 0 0 1px rgba(34,197,94,.35),0 0 12px 2px rgba(34,197,94,.7);pointer-events:none;z-index:30;transition:left .08s ease,top .08s ease,height .08s ease;}
  `

  function injectCss(rootNode) {
    const sr = rootNode.getRootNode && rootNode.getRootNode()
    const holder = sr instanceof ShadowRoot ? sr : rootNode
    if (holder.querySelector && holder.querySelector('#lau-style')) return
    const style = document.createElement('style')
    style.id = 'lau-style'
    style.textContent = CSS
    holder.appendChild(style)
  }

  // ---- 数据派生 ----
  function allTags(snaps) {
    const m = new Map()
    for (const s of snaps) for (const t of (s.tags || [])) m.set(t, (m.get(t) || 0) + 1)
    // 合并新建但暂无资源的空标签（计数 0）
    for (const t of (state.extraTags || [])) if (!m.has(t)) m.set(t, 0)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }

  // 按某标签的自定义顺序排列（表内 id 按位置在前；表外的保持原相对序追加末尾）
  function applyTagOrder(list, tag) {
    const order = (state.tagOrders && state.tagOrders[tag]) || null
    if (!order || !order.length) return list
    const pos = {}
    order.forEach((id, i) => { pos[id] = i })
    return list.slice().sort((a, b) => {
      const pa = (a && a.id in pos) ? pos[a.id] : 1e9
      const pb = (b && b.id in pos) ? pos[b.id] : 1e9
      return pa - pb
    })
  }

  function filtered() {
    const q = state.query.trim().toLowerCase()
    // 基础集合按视图取
    let base
    if (state.view === 'trash') base = state.trash
    else if (state.view === 'untagged') base = state.snapshots.filter((s) => !(s.tags && s.tags.length))
    else if (state.view && state.view.tag) {
      base = state.snapshots.filter((s) => (s.tags || []).includes(state.view.tag))
      base = applyTagOrder(base, state.view.tag)
    }
    else base = state.snapshots // all
    if (!q) return base
    return base.filter((s) => {
      const hay = [(s.tags || []).join(' '), s.note || ''].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }

  // 允许拖拽排序的视图（无搜索时）：
  //  - 'all'：写回整库全局顺序（reorder）
  //  - 标签视图 {tag}：写回该标签的独立顺序（reorderTag）
  // 回收站、未标记、搜索结果下语义不明确，禁用。
  function canReorder() {
    if (state.query.trim()) return false
    return state.view === 'all' || !!(state.view && state.view.tag)
  }

  // ---- 卡片 HTML ----
  function cardHtml(s) {
    const tag = (s.element && s.element.tagName || '?').toLowerCase()
    const drag = canReorder() ? ' draggable="true"' : ''
    const thumb = s.thumbnailUrl
      ? `<div class="lau-thumb-box"${drag}><img class="lau-thumb" src="${esc(s.thumbnailUrl)}" alt="" referrerpolicy="no-referrer" draggable="false" onerror="this.parentNode.classList.add('lau-thumb-fallback');this.remove()" /></div>`
      : `<div class="lau-thumb-fallback"${drag}>${esc(tag)}</div>`
    const chips = (s.tags || []).map((t) =>
      `<span class="lau-chip">${esc(t)}<button data-lau-untag="${esc(s.id)}" data-lau-tagname="${esc(t)}" title="移除">×</button></span>`
    ).join('')
    const inTrash = state.view === 'trash'
    const overlay = inTrash
      ? `<div class="lau-card-actions">
          <button class="lau-btn lau-btn-primary" data-lau-restore="${esc(s.id)}">恢复</button>
          <button class="lau-btn lau-btn-ghost" data-lau-purge="${esc(s.id)}">彻底删除</button>
        </div>`
      : `<div class="lau-card-tags" data-lau-tagbar="${esc(s.id)}">${chips}<span class="lau-tag-add" data-lau-addtag="${esc(s.id)}">+ 标签</span></div>
        <textarea class="lau-note" data-lau-note="${esc(s.id)}" rows="1" placeholder="添加备注…">${esc(s.note || '')}</textarea>
        <div class="lau-card-actions">
          <button class="lau-btn lau-btn-primary" data-lau-copy="${esc(s.id)}" data-lau-mode="imitate" title="复制「自适应设计」prompt 到 CC——以参考为基准，按目标场景做必要调整">模仿</button>
          <button class="lau-btn lau-btn-ghost" data-lau-copy="${esc(s.id)}" data-lau-mode="replica" title="复制「完全复刻」prompt 到 CC——1:1 照抄参考，不做自适应发挥">复刻</button>
          <button class="lau-btn lau-btn-ghost" data-lau-del="${esc(s.id)}">删除</button>
        </div>`
    const srcUrl = s.source && s.source.url ? String(s.source.url) : ''
    const srcTip = srcUrl ? (s.source.hostname || srcUrl) : ''
    const srcBadge = srcUrl
      ? `<a class="lau-src" href="${esc(srcUrl)}" target="_blank" rel="noreferrer" data-lau-src title="来源：${esc(srcTip)}\n${esc(srcUrl)}" aria-label="打开来源网址">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        </a>`
      : ''
    return `
    <div class="lau-card" data-lau-card="${esc(s.id)}">
      ${thumb}
      ${srcBadge}
      <div class="lau-overlay">${overlay}</div>
    </div>`
  }

  // ---- 只重绘网格（搜索/筛选用，不动搜索框，保住中文输入）----
  function refreshGrid(opts) {
    const root = state.root
    if (!root) return
    const list = filtered()
    const grid = root.querySelector('.lau-grid')
    if (grid) {
      // FLIP：opts.flip 时先记录旧卡位置，重建后让剩余卡从旧位置平滑位移补位（删除/重排用）
      const flip = opts && opts.flip
      let firstRects = null
      if (flip) {
        firstRects = new Map()
        grid.querySelectorAll('[data-lau-card]').forEach((c) => {
          firstRects.set(c.getAttribute('data-lau-card'), c.getBoundingClientRect())
        })
      }
      const html = list.length
        ? list.map(cardHtml).join('')
        : `<div class="lau-empty">${state.snapshots.length ? '没有匹配的采集。' : '库为空。退出全屏，选中元素后采集。'}</div>`
      // 内容没变就跳过重建：挂载时"缓存帧+异步数据帧"两连渲染不打断入场动画，也避免重复绑事件
      const changed = grid._lauHtml !== html
      if (changed) {
        grid.innerHTML = html
        grid._lauHtml = html
      }
      grid.classList.toggle('lau-reorderable', canReorder())
      if (changed) {
        bindCardEvents()
        bindDragSort(grid)
        // 进全屏首次渲染：卡片按 DOM 顺序（CSS grid 即 Z 字型阅读序）错峰渐显
        if (state.enterAnim && list.length) {
          state.enterAnim = false
          grid.classList.add('lau-enter')
          const cards = grid.querySelectorAll('[data-lau-card]')
          cards.forEach((c, i) => c.style.setProperty('--lau-i', Math.min(i, 20)))
          setTimeout(() => {
            grid.classList.remove('lau-enter')
            cards.forEach((c) => c.style.removeProperty('--lau-i'))
          }, 320 + 650 + Math.min(cards.length, 21) * 55 + 100)
        }
      }
      if (flip && firstRects && firstRects.size) {
        grid.querySelectorAll('[data-lau-card]').forEach((c) => {
          const prev = firstRects.get(c.getAttribute('data-lau-card'))
          if (!prev) return
          const now = c.getBoundingClientRect()
          const dx = prev.left - now.left
          const dy = prev.top - now.top
          if (!dx && !dy) return
          c.style.transition = 'none'
          c.style.transform = `translate(${dx}px, ${dy}px)`
        })
        // 强制回流后清掉 transform，触发从旧位置到新位置的过渡
        void grid.offsetWidth
        grid.querySelectorAll('[data-lau-card]').forEach((c) => {
          if (c.style.transform) {
            c.style.transition = 'transform .32s cubic-bezier(0.22, 1, 0.36, 1)'
            c.style.transform = ''
            c.addEventListener('transitionend', function te() { c.style.transition = ''; c.style.transform = ''; c.removeEventListener('transitionend', te) }, { once: true })
          }
        })
      }
    }
    // 「清空回收站」按钮：仅回收站视图且有内容时显示；离开则复位确认态
    const emptyBtn = root.querySelector('[data-lau-emptytrash]')
    if (emptyBtn) {
      const show = state.view === 'trash' && state.trash.length > 0
      emptyBtn.style.display = show ? '' : 'none'
      if (!show) resetEmptyTrashConfirm(emptyBtn)
    }
  }

  // 「清空回收站」二次确认：首点变「确认清空？」，3s 未再点自动复位
  let emptyTrashTimer = null
  function resetEmptyTrashConfirm(btn) {
    if (emptyTrashTimer) { clearTimeout(emptyTrashTimer); emptyTrashTimer = null }
    if (!btn) return
    btn.classList.remove('lau-confirming')
    btn.textContent = '清空回收站'
  }
  async function onEmptyTrash(btn) {
    if (!state.trash.length) return
    // 第一次点击：进入确认态，等第二次点击真正执行
    if (!btn.classList.contains('lau-confirming')) {
      btn.classList.add('lau-confirming')
      btn.textContent = '确认清空？'
      emptyTrashTimer = setTimeout(() => resetEmptyTrashConfirm(btn), 3000)
      return
    }
    resetEmptyTrashConfirm(btn)
    if (window.__liaisonInsp && window.__liaisonInsp.emptyTrash) {
      try { await window.__liaisonInsp.emptyTrash() } catch (_) {}
    }
    state.trash = []
    refreshSide(); refreshGrid()
  }

  // ---- 只重绘左侧标签栏 ----
  function refreshSide() {
    const root = state.root
    if (!root) return
    const side = root.querySelector('.lau-side')
    if (!side) return
    side.innerHTML = sideInner()
    bindSideEvents()
  }

  function sideInner() {
    const snaps = state.snapshots
    const tags = allTags(snaps)
    const untaggedCount = snaps.filter((s) => !(s.tags && s.tags.length)).length
    const isView = (v) => (typeof state.view === 'string' ? state.view === v : false)
    const isTag = (t) => (state.view && state.view.tag === t)
    return `
      <button class="lau-side-back" data-lau-exit title="退出全屏">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        返回
      </button>
      <div class="lau-tag-item ${isView('all') ? 'active' : ''}" data-lau-view="all">
        <span>全部</span><span class="lau-tag-count">${snaps.length}</span>
      </div>
      <div class="lau-tag-item ${isView('untagged') ? 'active' : ''}" data-lau-view="untagged">
        <span>未标记</span><span class="lau-tag-count">${untaggedCount}</span>
      </div>
      <div class="lau-tag-item ${isView('trash') ? 'active' : ''}" data-lau-view="trash">
        <span>回收站</span><span class="lau-tag-count">${state.trash.length}</span>
      </div>
      <div class="lau-side-taghead"><span>标签</span></div>
      ${tags.length
        ? tags.map(([t, c]) => `
          <div class="lau-tag-item ${isTag(t) ? 'active' : ''}" data-lau-tag="${esc(t)}">
            <span class="lau-tag-name">${esc(t)}</span>
            <span class="lau-tag-right"><span class="lau-tag-count">${c}</span><button class="lau-tag-menu" data-lau-tagmenu="${esc(t)}" title="管理">⋯</button></span>
          </div>`).join('')
        : '<div class="lau-empty-side">还没有标签。</div>'}
      <button class="lau-side-newtag" data-lau-newtag>＋ 新增标签</button>`
  }

  // ---- 整体渲染（幂等：shell 已在时只刷数据视图）----
  function renderShell() {
    const root = state.root
    if (!root) return
    // mount 会渲染两次（缓存帧 + 异步数据帧）：第二次不重建容器，
    // 只刷侧栏和网格——网格层有内容比对，数据没变就不会打断入场动画
    if (root.querySelector('.lau-root')) {
      refreshSide()
      refreshGrid()
      return
    }
    root.innerHTML = `
      <div class="lau-root">
        <div class="lau-side">${sideInner()}</div>
        <div class="lau-main">
          <div class="lau-topbar">
            <div class="lau-search">
              <svg class="lau-search-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>
              <input type="text" placeholder="搜索标签 / 备注…" data-lau-search />
            </div>
            <button class="lau-exit lau-empty-trash" data-lau-emptytrash title="彻底删除回收站全部内容" style="display:none">清空回收站</button>
            <button class="lau-exit" data-lau-import title="从 .json 库文件导入">导入</button>
            <button class="lau-exit" data-lau-export title="导出为 .json 库文件">导出</button>
          </div>
          <div class="lau-grid-wrap"><div class="lau-grid"></div></div>
          <div class="lau-sizer" title="调整卡片尺寸">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 21v-5h-5"/><path d="M11 21H5a2 2 0 0 1-2-2v-1"/></svg>
            <input type="range" min="140" max="480" step="10" data-lau-sizer />
          </div>
        </div>
      </div>`
    bindShellEvents()
    bindSideEvents()
    applyColW(state.colW)  // 应用已存偏好到 CSS 变量
    refreshGrid()
  }

  // ---- 事件绑定 ----
  function bindShellEvents() {
    const root = state.root
    const search = root.querySelector('[data-lau-search]')
    if (search) {
      search.addEventListener('compositionstart', () => { state.composing = true })
      search.addEventListener('compositionend', (e) => {
        state.composing = false
        state.query = e.target.value
        refreshGrid()
      })
      search.addEventListener('input', (e) => {
        if (state.composing) return // 组合输入中不筛选，避免打断中文输入法
        state.query = e.target.value
        refreshGrid()
      })
    }
    const expBtn = root.querySelector('[data-lau-export]')
    if (expBtn) expBtn.onclick = doExport
    const impBtn = root.querySelector('[data-lau-import]')
    if (impBtn) impBtn.onclick = doImport
    const emptyBtn = root.querySelector('[data-lau-emptytrash]')
    if (emptyBtn) emptyBtn.onclick = () => onEmptyTrash(emptyBtn)
    const sizer = root.querySelector('[data-lau-sizer]')
    if (sizer) {
      sizer.value = String(state.colW)
      sizer.addEventListener('input', (e) => {
        let w = parseInt(e.target.value, 10)
        if (!(w >= COL_W_MIN && w <= COL_W_MAX)) w = 200
        applyColW(w)
      })
    }
  }

  // ---- 导出：整库 → JSON 文件（走 downloads bridge）----
  async function doExport() {
    if (!window.__liaisonInsp || !window.__liaisonInsp.exportLibrary) return
    const btn = state.root.querySelector('[data-lau-export]')
    const orig = btn ? btn.textContent : ''
    try {
      const payload = await window.__liaisonInsp.exportLibrary()
      const json = JSON.stringify(payload)
      const filename = `liaison-library-${payload.count}.json`
      // Blob + a[download]（模块在 page world，可用 Blob URL）
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url) }, 1000)
      if (btn) { btn.textContent = `已导出 ${payload.count} 条`; setTimeout(() => { btn.textContent = orig }, 1800) }
    } catch (e) {
      if (btn) { btn.textContent = '导出失败'; setTimeout(() => { btn.textContent = orig }, 1800) }
    }
  }

  // ---- 导入：选 JSON 文件 → 合并去重 ----
  function doImport() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.style.display = 'none'
    document.body.appendChild(input)
    input.onchange = async () => {
      const file = input.files && input.files[0]
      document.body.removeChild(input)
      if (!file) return
      const btn = state.root.querySelector('[data-lau-import]')
      const orig = btn ? btn.textContent : ''
      try {
        const text = await file.text()
        const payload = JSON.parse(text)
        if (!window.__liaisonInsp || !window.__liaisonInsp.importLibrary) throw new Error('no api')
        const res = await window.__liaisonInsp.importLibrary(payload)
        // 重新拉取数据并刷新
        state.snapshots = await window.__liaisonInsp.list()
        state.trash = window.__liaisonInsp.listTrash ? await window.__liaisonInsp.listTrash() : []
        state.extraTags = []
        if (state.ctx && state.ctx.onDataChanged) state.ctx.onDataChanged()
        refreshSide(); refreshGrid()
        if (btn) { btn.textContent = `已导入 ${res.added} 条`; setTimeout(() => { btn.textContent = orig }, 2000) }
      } catch (e) {
        if (btn) { btn.textContent = '导入失败'; setTimeout(() => { btn.textContent = orig }, 2000) }
      }
    }
    input.click()
  }

  function bindSideEvents() {
    const root = state.root
    // 返回（退出全屏）
    const exit = root.querySelector('[data-lau-exit]')
    if (exit) exit.onclick = () => { if (state.ctx && state.ctx.exitFullscreen) state.ctx.exitFullscreen() }
    // 视图切换：全部/未标记/回收站
    root.querySelectorAll('[data-lau-view]').forEach((el) => {
      el.onclick = () => {
        state.view = el.getAttribute('data-lau-view')
        refreshSide(); refreshGrid()
      }
    })
    // 标签筛选
    root.querySelectorAll('[data-lau-tag]').forEach((el) => {
      el.onclick = (e) => {
        // 点在 ⋯ 菜单按钮上不触发筛选
        if (e.target.closest && e.target.closest('[data-lau-tagmenu]')) return
        state.view = { tag: el.getAttribute('data-lau-tag') }
        refreshSide(); refreshGrid()
      }
    })
    // 新增标签
    const newBtn = root.querySelector('[data-lau-newtag]')
    if (newBtn) newBtn.onclick = (e) => { e.stopPropagation(); openNewTagInput(newBtn) }
    // 标签 ⋯ 管理菜单
    root.querySelectorAll('[data-lau-tagmenu]').forEach((el) => {
      el.onclick = (e) => { e.stopPropagation(); openTagManageMenu(el, el.getAttribute('data-lau-tagmenu')) }
    })
  }

  // 新增空标签：在 ＋ 旁弹输入框（新标签暂无资源，但会出现在列表，可后续在卡片上勾选）
  function openNewTagInput(anchor) {
    closeSidePop()
    const root = state.root
    const pop = document.createElement('div')
    pop.className = 'lau-tagmenu-pop'
    pop.innerHTML = `<input class="lau-tagmenu-input" type="text" placeholder="新标签名，回车" />`
    positionSidePop(pop, anchor, true) // 向上弹，浮在按钮上方
    const input = pop.querySelector('input')
    let composing = false
    input.addEventListener('compositionstart', () => composing = true)
    input.addEventListener('compositionend', () => composing = false)
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !composing) {
        const name = input.value.trim()
        if (!name) { closeSidePop(); return }
        // 空标签：记到 state.extraTags，让它在左侧出现（allTags 会合并）
        if (!state.extraTags) state.extraTags = []
        if (!state.extraTags.includes(name) && !allTags(state.snapshots).some(([t]) => t === name)) state.extraTags.push(name)
        closeSidePop(); refreshSide()
      } else if (e.key === 'Escape') closeSidePop()
    })
    setTimeout(() => input.focus(), 0)
  }

  // 标签管理菜单：重命名 / 删除
  function openTagManageMenu(anchor, name) {
    closeSidePop()
    const pop = document.createElement('div')
    pop.className = 'lau-tagmenu-pop'
    pop.innerHTML = `
      <div class="lau-tagmenu-item" data-act="rename">重命名</div>
      <div class="lau-tagmenu-item danger" data-act="delete">删除标签</div>`
    positionSidePop(pop, anchor)
    pop.querySelector('[data-act="rename"]').onclick = (e) => { e.stopPropagation(); startRenameTag(pop, anchor, name) }
    pop.querySelector('[data-act="delete"]').onclick = async (e) => {
      e.stopPropagation()
      if (window.__liaisonInsp) { try { await window.__liaisonInsp.deleteTag(name) } catch (err) {} }
      // 同步本地 snapshots
      state.snapshots.forEach((s) => { s.tags = (s.tags || []).filter((x) => x !== name) })
      if (state.extraTags) state.extraTags = state.extraTags.filter((x) => x !== name)
      if (state.view && state.view.tag === name) state.view = 'all'
      closeSidePop(); refreshSide(); refreshGrid()
    }
  }

  // 重命名：把菜单换成输入框
  function startRenameTag(pop, anchor, oldName) {
    pop.innerHTML = `<input class="lau-tagmenu-input" type="text" value="${esc(oldName)}" />`
    const input = pop.querySelector('input')
    let composing = false
    input.addEventListener('compositionstart', () => composing = true)
    input.addEventListener('compositionend', () => composing = false)
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !composing) {
        const nn = input.value.trim()
        if (!nn || nn === oldName) { closeSidePop(); return }
        if (window.__liaisonInsp) { try { await window.__liaisonInsp.renameTag(oldName, nn) } catch (err) {} }
        state.snapshots.forEach((s) => {
          const t = s.tags || []; const i = t.indexOf(oldName)
          if (i !== -1) { if (t.indexOf(nn) === -1) t[i] = nn; else t.splice(i, 1); s.tags = t }
        })
        if (state.extraTags) { const i = state.extraTags.indexOf(oldName); if (i !== -1) state.extraTags[i] = nn }
        if (state.view && state.view.tag === oldName) state.view = { tag: nn }
        closeSidePop(); refreshSide(); refreshGrid()
      } else if (e.key === 'Escape') closeSidePop()
    })
    setTimeout(() => { input.focus(); input.select() }, 0)
  }

  // 侧栏浮层定位 + 关闭（复用几何命中判断，因 closed shadow）
  let sidePop = null
  function positionSidePop(pop, anchor, above) {
    const lauRoot = state.root.querySelector('.lau-root') || state.root
    lauRoot.appendChild(pop)
    const ar = anchor.getBoundingClientRect()
    const rr = lauRoot.getBoundingClientRect()
    pop.style.left = (ar.left - rr.left) + 'px'
    if (above) {
      // 向上弹（用于沉底的「＋新增标签」，避免溢出容器底把布局撑坏）
      pop.style.top = (ar.top - rr.top - pop.offsetHeight - 6) + 'px'
    } else {
      pop.style.top = (ar.bottom - rr.top + 6) + 'px'
    }
    const inRect = (el, x, y) => { if (!el) return false; const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom }
    const onDoc = (e) => { if (!inRect(pop, e.clientX, e.clientY) && !inRect(anchor, e.clientX, e.clientY)) closeSidePop() }
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0)
    sidePop = { el: pop, onDoc }
  }
  function closeSidePop() {
    if (sidePop && sidePop.el) sidePop.el.remove()
    if (sidePop && sidePop.onDoc) document.removeEventListener('mousedown', sidePop.onDoc, true)
    sidePop = null
  }

  // ---- 拖拽排序（事件委托绑在 grid 上，仅 canReorder 时生效）----
  function bindDragSort(grid) {
    if (grid.__lauDragBound) return
    grid.__lauDragBound = true
    let dragEl = null
    let indicator = null

    const removeIndicator = () => {
      if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator)
      indicator = null
    }

    // 找鼠标位置对应的插入锚点：返回应插到其【前面】的卡片（null = 插到末尾）。
    // 多列网格按阅读顺序判断：先比行（y），同行内再比列（x）。
    const findRef = (x, y) => {
      const cards = [...grid.querySelectorAll('.lau-card')].filter((c) => c !== dragEl)
      for (const c of cards) {
        const r = c.getBoundingClientRect()
        const cy = r.top + r.height / 2
        const cx = r.left + r.width / 2
        // 鼠标明显在该卡上方行 → 插它前面；或同行且在其左半 → 插它前面
        if (y < r.top) return c
        if (y <= r.bottom && x < cx) return c
      }
      return null
    }

    // 把指示条画到 ref 卡片左边缘（ref=null 时画到最后一张卡右边缘）
    const showIndicatorAt = (ref) => {
      if (!indicator) {
        indicator = document.createElement('div')
        indicator.className = 'lau-drop-indicator'
        grid.appendChild(indicator)
      }
      const gr = grid.getBoundingClientRect()
      const GAP = 14         // 与 .lau-grid 的 gap 一致
      const halfW = 1        // 指示条宽度 2px 的一半
      let left, top, h
      if (ref) {
        const r = ref.getBoundingClientRect()
        // 落在 ref 左侧间隙的正中：ref 左边缘往左半个 gap，再减半个线宽居中
        left = r.left - gr.left + grid.scrollLeft - GAP / 2 - halfW
        top = r.top - gr.top + grid.scrollTop
        h = r.height
      } else {
        const cards = [...grid.querySelectorAll('.lau-card')].filter((c) => c !== dragEl)
        const last = cards[cards.length - 1]
        if (!last) { removeIndicator(); return }
        const r = last.getBoundingClientRect()
        // 末尾：最后一张右边缘往右半个 gap 居中
        left = r.right - gr.left + grid.scrollLeft + GAP / 2 - halfW
        top = r.top - gr.top + grid.scrollTop
        h = r.height
      }
      indicator.style.left = left + 'px'
      indicator.style.top = top + 'px'
      indicator.style.height = h + 'px'
    }

    grid.addEventListener('dragstart', (e) => {
      if (!canReorder()) return
      const card = e.target.closest ? e.target.closest('.lau-card') : null
      if (!card) return
      dragEl = card
      card.classList.add('lau-dragging')
      try {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', card.getAttribute('data-lau-card') || '')
      } catch (_) {}
    })

    // 整个 grid 都是热区：任意位置 dragover 都算最近落点并显示指示条
    grid.addEventListener('dragover', (e) => {
      if (!dragEl) return
      e.preventDefault()
      try { e.dataTransfer.dropEffect = 'move' } catch (_) {}
      showIndicatorAt(findRef(e.clientX, e.clientY))
    })

    grid.addEventListener('drop', (e) => {
      if (!dragEl) return
      e.preventDefault()
      const ref = findRef(e.clientX, e.clientY)
      if (ref !== dragEl) grid.insertBefore(dragEl, ref)  // ref=null → 追加到末尾
      removeIndicator()
    })

    grid.addEventListener('dragend', () => {
      if (dragEl) dragEl.classList.remove('lau-dragging')
      dragEl = null
      removeIndicator()
      persistOrder(grid)
    })
  }

  // 读当前 DOM 卡片顺序 → 按视图写回存储
  //  - 「全部」：重排全局 state.snapshots 并调 reorder(ids)
  //  - 标签视图：只更新该标签的顺序表 state.tagOrders[tag] 并调 reorderTag(tag, ids)
  async function persistOrder(grid) {
    if (!canReorder()) return
    const ids = [...grid.querySelectorAll('.lau-card')]
      .map((c) => c.getAttribute('data-lau-card'))
      .filter(Boolean)
    if (!ids.length) return
    const insp = window.__liaisonInsp
    if (state.view && state.view.tag) {
      const tag = state.view.tag
      state.tagOrders = state.tagOrders || {}
      state.tagOrders[tag] = ids.slice()
      if (insp && insp.reorderTag) { try { await insp.reorderTag(tag, ids) } catch (_) {} }
    } else {
      const pos = {}
      ids.forEach((id, i) => { pos[id] = i })
      state.snapshots.sort((a, b) => {
        const pa = (a && a.id in pos) ? pos[a.id] : 1e9
        const pb = (b && b.id in pos) ? pos[b.id] : 1e9
        return pa - pb
      })
      if (insp && insp.reorder) { try { await insp.reorder(ids) } catch (_) {} }
    }
  }

  function bindCardEvents() {
    const root = state.root

    // 来源图标：阻止冒泡到卡片（拖拽/pin 等），原生 <a target=_blank> 负责跳转
    root.querySelectorAll('[data-lau-src]').forEach((el) => {
      el.addEventListener('click', (ev) => ev.stopPropagation())
      el.addEventListener('mousedown', (ev) => ev.stopPropagation())
    })

    // 删除 → 软删除（进回收站）
    root.querySelectorAll('[data-lau-del]').forEach((el) => {
      el.onclick = async (ev) => {
        ev.stopPropagation()
        const id = el.getAttribute('data-lau-del')
        const doDelete = async () => {
          if (window.__liaisonInsp) { try { await window.__liaisonInsp.softDelete(id) } catch (e) {} }
          const snap = state.snapshots.find((s) => s.id === id)
          state.snapshots = state.snapshots.filter((s) => s.id !== id)
          if (snap) { snap.deleted = true; state.trash.unshift(snap) }
          if (state.ctx && state.ctx.onDataChanged) state.ctx.onDataChanged()
          refreshSide(); refreshGrid({ flip: true })
        }
        // 先播收拢动画（下方卡片补位），动画结束再真正删除重排
        const card = el.closest ? el.closest('.lau-card') : null
        if (card) {
          let done = false
          const fin = () => { if (done) return; done = true; doDelete() }
          card.addEventListener('animationend', fin, { once: true })
          setTimeout(fin, 360)
          card.classList.add('lau-removing')
        } else {
          doDelete()
        }
      }
    })

    // 回收站：恢复
    root.querySelectorAll('[data-lau-restore]').forEach((el) => {
      el.onclick = async (ev) => {
        ev.stopPropagation()
        const id = el.getAttribute('data-lau-restore')
        if (window.__liaisonInsp) { try { await window.__liaisonInsp.restore(id) } catch (e) {} }
        const snap = state.trash.find((s) => s.id === id)
        state.trash = state.trash.filter((s) => s.id !== id)
        if (snap) { delete snap.deleted; state.snapshots.unshift(snap) }
        refreshSide(); refreshGrid()
      }
    })

    // 回收站：彻底删除
    root.querySelectorAll('[data-lau-purge]').forEach((el) => {
      el.onclick = async (ev) => {
        ev.stopPropagation()
        const id = el.getAttribute('data-lau-purge')
        if (window.__liaisonInsp) { try { await window.__liaisonInsp.purge(id) } catch (e) {} }
        state.trash = state.trash.filter((s) => s.id !== id)
        refreshSide(); refreshGrid()
      }
    })

    root.querySelectorAll('[data-lau-copy]').forEach((el) => {
      el.onclick = async (ev) => {
        ev.stopPropagation()
        const id = el.getAttribute('data-lau-copy')
        const snap = state.snapshots.find((s) => s.id === id)
        if (!snap || !window.__liaisonInsp) return
        const mode = el.getAttribute('data-lau-mode') || 'imitate'
        try {
          const prompt = await window.__liaisonInsp.buildPromptAsync(snap, state.ctx && state.ctx.target, mode)
          await navigator.clipboard.writeText(prompt)
          if (window.__liToast) window.__liToast('复制到 CC 即可', el)
        } catch (e) {
          console.error('copy failed', e)
          if (window.__liToast) window.__liToast('复制失败，请手选全文', el)
        }
      }
    })

    // 备注：聚焦时 pin 卡片（overlay 保持可见），失焦保存
    root.querySelectorAll('[data-lau-note]').forEach((ta) => {
      const id = ta.getAttribute('data-lau-note')
      const card = ta.closest ? ta.closest('.lau-card') : null
      // 自动高度
      const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(80, ta.scrollHeight) + 'px' }
      ta.addEventListener('focus', () => { if (card) card.classList.add('lau-card-pinned'); autosize() })
      ta.addEventListener('input', autosize)
      ta.addEventListener('mousedown', (e) => e.stopPropagation())
      ta.addEventListener('click', (e) => e.stopPropagation())
      ta.addEventListener('blur', async () => {
        if (card) card.classList.remove('lau-card-pinned')
        const val = ta.value
        const snap = state.snapshots.find((s) => s.id === id)
        if (!snap) return
        if ((snap.note || '') === val) return // 无变化不写
        snap.note = val
        if (window.__liaisonInsp) { try { await window.__liaisonInsp.updateNote(id, val) } catch (e) {} }
      })
    })

    // 打标签：下拉选择器（已有标签点选 + 底部输入新增）
    root.querySelectorAll('[data-lau-addtag]').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation()
        openTagPopover(el, el.getAttribute('data-lau-addtag'))
      }
    })

    root.querySelectorAll('[data-lau-untag]').forEach((el) => {
      el.onclick = async (ev) => {
        ev.stopPropagation()
        const id = el.getAttribute('data-lau-untag')
        const t = el.getAttribute('data-lau-tagname')
        await applyTag(id, t, false)
        if (state.view && state.view.tag === t && !allTags(state.snapshots).some(([tt]) => tt === t)) state.view = 'all'
        updateCardTagbar(id); refreshSide()
      }
    })
  }

  // 属性选择器里的 id 转义（id 是 uuid，通常安全，但稳妥起见）
  function cssEsc(s) {
    return String(s).replace(/["\\]/g, '\\$&')
  }

  // 给某条采集加/去标签并持久化
  async function applyTag(id, name, add) {
    const snap = state.snapshots.find((s) => s.id === id)
    if (!snap) return
    snap.tags = snap.tags || []
    if (add) { if (!snap.tags.includes(name)) snap.tags.push(name) }
    else { snap.tags = snap.tags.filter((x) => x !== name) }
    if (window.__liaisonInsp) { try { await window.__liaisonInsp.updateTags(id, snap.tags) } catch (e) {} }
  }

  // 只重绘某张卡片的标签栏（不动网格、不破坏 hover）
  function updateCardTagbar(id) {
    const root = state.root
    if (!root) return
    const bar = root.querySelector(`[data-lau-tagbar="${cssEsc(id)}"]`)
    if (!bar) return
    const snap = state.snapshots.find((s) => s.id === id)
    const chips = ((snap && snap.tags) || []).map((t) =>
      `<span class="lau-chip">${esc(t)}<button data-lau-untag="${esc(id)}" data-lau-tagname="${esc(t)}" title="移除">×</button></span>`
    ).join('')
    bar.innerHTML = `${chips}<span class="lau-tag-add" data-lau-addtag="${esc(id)}">+ 标签</span>`
    // 重绑该标签栏内的事件
    const add = bar.querySelector('[data-lau-addtag]')
    if (add) add.onclick = (ev) => { ev.stopPropagation(); openTagPopover(add, id) }
    bar.querySelectorAll('[data-lau-untag]').forEach((el) => {
      el.onclick = async (ev) => {
        ev.stopPropagation()
        const t = el.getAttribute('data-lau-tagname')
        await applyTag(id, t, false)
        updateCardTagbar(id); refreshSide()
      }
    })
  }

  // 新建标签后刷新 popover 的已有标签列表
  function rebuildPopoverList(pop, id) {
    const snap = state.snapshots.find((s) => s.id === id)
    const own = new Set((snap && snap.tags) || [])
    const all = allTags(state.snapshots).map(([t]) => t)
    const listEl = pop.querySelector('.lau-tagpop-list')
    if (!listEl) return
    listEl.innerHTML = all.length
      ? all.map((t) =>
          `<div class="lau-tagpop-item ${own.has(t) ? 'checked' : ''}" data-tp-toggle="${esc(t)}">
             <span>${esc(t)}</span><span>${own.has(t) ? '✓' : ''}</span>
           </div>`).join('')
      : '<div class="lau-tagpop-empty">还没有标签，下方输入新建</div>'
    listEl.querySelectorAll('[data-tp-toggle]').forEach((it) => {
      it.onclick = async (e) => {
        e.stopPropagation()
        const name = it.getAttribute('data-tp-toggle')
        const willAdd = !own.has(name)
        await applyTag(id, name, willAdd)
        updateCardTagbar(id); refreshSide(); rebuildPopoverList(pop, id)
      }
    })
  }

  let openPop = null // 当前打开的 popover（同一时刻只一个）
  function closeTagPopover() {
    if (openPop && openPop.el) openPop.el.remove()
    if (openPop && openPop.onDoc) document.removeEventListener('mousedown', openPop.onDoc, true)
    // 取消所有卡片的 pinned 态
    if (state.root) state.root.querySelectorAll('.lau-card-pinned').forEach((c) => c.classList.remove('lau-card-pinned'))
    openPop = null
  }

  // 在锚点附近打开标签选择器：已有标签可勾选、底部输入可新增
  function openTagPopover(anchor, id) {
    closeTagPopover()
    const root = state.root
    if (!root) return
    const snap = state.snapshots.find((s) => s.id === id)
    const own = new Set((snap && snap.tags) || [])
    const all = allTags(state.snapshots).map(([t]) => t)

    const pop = document.createElement('div')
    pop.className = 'lau-tagpop'
    const listHtml = all.length
      ? all.map((t) =>
          `<div class="lau-tagpop-item ${own.has(t) ? 'checked' : ''}" data-tp-toggle="${esc(t)}">
             <span>${esc(t)}</span><span>${own.has(t) ? '✓' : ''}</span>
           </div>`).join('')
      : '<div class="lau-tagpop-empty">还没有标签，下方输入新建</div>'
    pop.innerHTML = `
      <div class="lau-tagpop-list">${listHtml}</div>
      <input class="lau-tagpop-input" type="text" placeholder="新建标签，回车添加" />`

    // 关键：popover 打开时给卡片加 pinned 类，强制 overlay 保持可见。否则鼠标从
    // +标签 移向下方列表项时会离开 .lau-card:hover 区域 → overlay 淡出 → popover
    // 视觉上「一闪就消失」，根本点不到列表项（这是真正的病根）。
    const card = anchor.closest ? anchor.closest('.lau-card') : null
    if (card) card.classList.add('lau-card-pinned')

    // 定位：挂到 .lau-root（position:absolute，稳定定位上下文），viewport 坐标差换算。
    const lauRoot = root.querySelector('.lau-root') || root
    lauRoot.appendChild(pop)
    const ar = anchor.getBoundingClientRect()
    const rr = lauRoot.getBoundingClientRect()
    let left = ar.left - rr.left
    let top = ar.bottom - rr.top + 6
    const pw = 200
    if (left + pw > rr.width) left = Math.max(4, rr.width - pw - 4)
    pop.style.left = left + 'px'
    pop.style.top = top + 'px'

    // 勾选/取消已有标签 —— 局部更新，不重绘网格（否则卡片重建、hover 丢失、popover 被清）
    pop.querySelectorAll('[data-tp-toggle]').forEach((it) => {
      it.onclick = async (e) => {
        e.stopPropagation()
        const name = it.getAttribute('data-tp-toggle')
        const willAdd = !own.has(name)
        await applyTag(id, name, willAdd)
        // 同步 popover 内的勾选态
        if (willAdd) own.add(name); else own.delete(name)
        it.classList.toggle('checked', willAdd)
        const mark = it.querySelector('span:last-child')
        if (mark) mark.textContent = willAdd ? '✓' : ''
        // 只更新该卡片的标签栏 + 左侧标签统计，不动网格与 hover
        updateCardTagbar(id)
        refreshSide()
        // popover 保持打开，可连续勾选
      }
    })

    // 新建标签
    const input = pop.querySelector('.lau-tagpop-input')
    let composing = false
    input.addEventListener('compositionstart', () => { composing = true })
    input.addEventListener('compositionend', () => { composing = false })
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !composing) {
        const name = input.value.trim()
        if (!name) return
        await applyTag(id, name, true)
        input.value = ''
        // 局部更新：重建 popover 列表（含新标签）+ 卡片标签栏 + 左侧栏
        updateCardTagbar(id)
        refreshSide()
        rebuildPopoverList(pop, id)
      } else if (e.key === 'Escape') {
        closeTagPopover()
      }
    })
    setTimeout(() => input.focus(), 0)

    // 点外部关闭 —— 用几何命中判断，不用 composedPath/contains。
    // 关键：本面板的 shadow 是 closed mode，事件 composedPath 不暴露内部节点（顶层
    // 只到 host liaison-style-panel），所以 path.indexOf(pop) 永远 -1 → 每次 mousedown
    // 都误判为「外部」把 popover 关掉。这正是「一点就关」的真正病根。
    // 改判：点击坐标是否落在 popover 或 anchor 的矩形内。
    const inRect = (el, x, y) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    }
    const onDoc = (e) => {
      if (!inRect(pop, e.clientX, e.clientY) && !inRect(anchor, e.clientX, e.clientY)) closeTagPopover()
    }
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0)
    openPop = { el: pop, onDoc }
  }

  // ---- 对外接口 ----
  window.__liaisonAssetUI = {
    async mount(rootEl, ctx) {
      state.root = rootEl
      state.ctx = ctx || {}
      state.query = ''
      state.view = 'all'
      state.enterAnim = true   // 进全屏首次出卡片时播 Z 字型错峰渐显
      injectCss(rootEl)
      // 先用进全屏时传入的内存缓存立即渲染一帧，避免全屏铺开后、异步数据到达前的空白窗口。
      // 从 ctx.initialCache 拿（不依赖 window.__liaisonInspPanel 全局，file:// 页面取不到）。
      try {
        const cached = state.ctx && Array.isArray(state.ctx.initialCache) ? state.ctx.initialCache : null
        if (cached) {
          state.snapshots = cached.filter((s) => s && !s.deleted)
          if (!state.trash) state.trash = []
          if (!state.tagOrders) state.tagOrders = {}
          renderShell()
        }
      } catch (e) {}
      try {
        state.snapshots = window.__liaisonInsp ? await window.__liaisonInsp.list() : []
        state.trash = window.__liaisonInsp && window.__liaisonInsp.listTrash ? await window.__liaisonInsp.listTrash() : []
        state.tagOrders = window.__liaisonInsp && window.__liaisonInsp.getTagOrders ? await window.__liaisonInsp.getTagOrders() : {}
        // 卡片尺寸偏好优先读扩展全局存储（跨网站记住）；读不到再用 localStorage 兜底值
        if (window.__liaisonInsp && window.__liaisonInsp.getColW) {
          const gw = await window.__liaisonInsp.getColW()
          if (gw) state.colW = gw
        }
      } catch (e) { if (!Array.isArray(state.snapshots)) { state.snapshots = []; state.trash = []; state.tagOrders = {} } }
      // 若容器仍是本次挂载的（未被 unmount 换掉），用最新数据重渲染补齐
      if (state.root === rootEl) renderShell()
    },
    unmount() {
      closeTagPopover()
      if (typeof closeSidePop === 'function') closeSidePop()
      if (state.root) state.root.innerHTML = ''
      state.root = null
      state.query = ''
      state.view = 'all'
      state.composing = false
    },
  }
})()
