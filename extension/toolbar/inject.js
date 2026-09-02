// 幂等守卫 + IIFE 包裹（2026-09-02 同事侧 SyntaxError 修复）
//
// 症状：扩展卡片报 "Identifier 'hideRootScrollbar' has already been declared"，
// 整个 inject.js 在解析期就终止 —— 页面里的采集/存储/下载/CDP 桥全断。
//
// 根因：background 的重复注入守卫（state.loaded / state.injected）只活在
// service worker 内存里。MV3 的 SW 随时会被回收，回收后 state 归零，下次点
// 扩展图标就判定成「fresh start」，把 inject.js 二次注入进同一个页面。文件
// 顶层的 const 声明（hideRootScrollbar 等 6 个）撞上首次注入残留的绑定，
// SyntaxError 在解析阶段抛出 —— 注意这早于任何运行时判断，所以守卫必须让
// 那些 const 不在顶层，光加一个 if 拦不住。
//
// 修法：整个文件包进 IIFE（顶层声明降级为函数作用域，重复注入不再冲突），
// 入口再加一道 window 标记，二次注入直接空转返回。
;(function () {
  if (window.__liaisonInjectLoaded) {
    // 二次注入不能只是空转：SW 误判走 fresh-start 时，这条分支是用户点图标后
    // 唯一会创建 liaison-app 的路径。若此前已 eject（元素被移除），直接 return
    // 会让面板再也起不来。补建元素即可 —— 桥接、监听、页面世界的脚本首次注入
    // 时都已就位，不需要（也不能）重复挂。
    try {
      var _p = typeof browser === 'undefined' ? chrome : browser
      if (!document.querySelector('liaison-app')) {
        var _el = document.createElement('liaison-app')
        _el.setAttribute('asset-base', _p.runtime.getURL(''))
        document.body.prepend(_el)
      }
    } catch (_) {}
    return
  }
  window.__liaisonInjectLoaded = true

var platform = typeof browser === 'undefined'
  ? chrome
  : browser

// Bridge between page-world bundle (no chrome.* access) and content-script
// (has chrome.storage). Used by window.__liaisonInsp for persistent library.
window.addEventListener('message', async (event) => {
  if (event.source !== window) return
  const d = event.data
  if (!d || d._liaisonInspBridge !== true || !d.id) return
  try {
    let result
    if (d.action === 'get') {
      // Library storage now lives in the background service worker's IndexedDB
      // (extension origin → cross-site shared, no ~10MB quota). Forward to it.
      // First get triggers a one-time migration from legacy chrome.storage.local.
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonInspDbGet' }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'db get failed')
      result = resp.value
    } else if (d.action === 'set') {
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonInspDbSet', value: d.payload.value, verified: d.payload.verified === true }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'db set failed')
      result = true
    } else if (d.action === 'kvGet') {
      // 通用 kv 读（按 key），自检结果持久化用。走 background 的同一 IndexedDB。
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonKvGet', key: d.payload.key }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'kv get failed')
      result = resp.value
    } else if (d.action === 'kvSet') {
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonKvSet', key: d.payload.key, value: d.payload.value }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'kv set failed')
      result = true
    } else if (d.action === 'screenshot') {
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonInspCaptureVisibleTab' }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'screenshot failed')
      result = resp.dataUrl
    } else if (d.action === 'download') {
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonInspDownload', dataUrl: d.payload.dataUrl, filename: d.payload.filename }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'download failed')
      result = resp.path
    } else if (d.action === 'fetchCss') {
      // Page-world bundle can't reach chrome.runtime; bridge its cross-origin
      // CSS fetch to the background service worker (which has host permissions).
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonFetchCss', url: d.payload.url }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'fetchCss failed')
      result = resp.text
    } else if (d.action === 'cdpCollect') {
      // Page-world bundle can't reach chrome.debugger; bridge CDP-backed
      // collection (hover state now; future capabilities via same action) to
      // the background service worker. Capability-agnostic: payload carries
      // { capabilities, whitelist }, so new capabilities need no bridge change.
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonCdpCollect', capabilities: d.payload.capabilities, whitelist: d.payload.whitelist }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || 'cdpCollect failed')
      result = resp.result
    } else if (d.action === 'divergeDispatch') {
      // 「发散」：截图 + 提示词交给 background 转发本地桥（同样绕开页面 CSP）。
      // Variant 自动化耗时较长，这里单发单等，超时由 page world 侧的 190s 兜底。
      const resp = await new Promise((resolve) => {
        platform.runtime.sendMessage({ action: 'liaisonDivergeDispatch', payload: d.payload }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      if (!resp.ok) throw new Error(resp.error || '发散失败')
      result = resp
    } else if (d.action === 'selfAudit') {
      // 「自检」tab：走 background fetch（content script 直连 localhost 会被页面 CSP 挡；
      // background 用扩展权限不受页面 CSP 约束）。用「两段式短轮询」而非长连接/长回调：
      //   1) 让 background 发起审查 → 秒回 taskId（后台异步跑）
      //   2) 每 3s 让 background 查一次结果 → 秒回
      // 每次都是秒回的短请求，MV3 service worker 无需长时间存活、不会被 30s 空闲回收。
      const sendBg = (action, body) => new Promise((resolve) => {
        platform.runtime.sendMessage({ action, ...body }, (r) => {
          if (platform.runtime.lastError) resolve({ ok: false, error: platform.runtime.lastError.message })
          else resolve(r || { ok: false, error: 'no response' })
        })
      })
      const started = await sendBg('liaisonSelfAuditStart', { payload: d.payload })
      if (!started.ok || !started.taskId) throw new Error(started.error || '发起审查失败')
      const taskId = started.taskId
      const deadline = Date.now() + 200000
      let final = null
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000))
        const poll = await sendBg('liaisonSelfAuditPoll', { taskId })
        if (!poll.ok) throw new Error(poll.error || '查询结果失败')
        if (poll.status === 'running') continue
        if (poll.status === 'unknown') throw new Error('任务丢失（服务可能重启过）')
        final = poll // done / error
        break
      }
      if (!final) throw new Error('检测超时（>200s）')
      if (final.status === 'error' || !final.result) throw new Error(final.error || '服务未返回有效结果')
      result = final.result
    } else {
      return
    }
    window.postMessage({ _liaisonInspBridgeReply: true, id: d.id, ok: true, result }, '*')
  } catch (err) {
    window.postMessage({ _liaisonInspBridgeReply: true, id: d.id, ok: false, error: String(err && err.message || err) }, '*')
  }
})

// 面板固定停靠在窗口右缘（position:fixed），而宿主页 viewport 的原生垂直滚动条
// 也画在窗口最右侧。原生 viewport 滚动条不参与 z-index 层叠、永远绘制在最顶层，
// 所以无论面板 z-index 拉多高都压不住它，会穿透显示在面板之上（视觉上是面板里
// 冒出一条滚动条）。这里给宿主页注入一段 style，把「文档根」这一层的原生滚动条
// 隐藏掉——页面依旧可以滚动，只是不再显示那条会盖住面板的滚动条。
// 只针对 html/body（viewport 滚动），不动页面内部 overflow 容器的滚动条。
const hideRootScrollbar = document.createElement('style')
hideRootScrollbar.setAttribute('data-liaison-hide-root-scrollbar', 'true')
hideRootScrollbar.textContent =
  'html{scrollbar-width:none !important;}' +
  'html::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}' +
  'body::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}'
document.documentElement.appendChild(hideRootScrollbar)

// Full-screen asset-library grid UI (page world, shares window.__liaisonInsp).
// Injected before the bundle so window.__liaisonAssetUI is ready when the
// bundle's renderInspirationPanel() calls it in fullscreen mode.
const assetUiScript = document.createElement('script')
assetUiScript.src = platform.runtime.getURL('toolbar/asset-library-ui.js')
document.body.appendChild(assetUiScript)

// 界面视觉令牌（颜色 / 圆角 / 间距 / 字阶 / 阴影 / 层级 / 动效）。
// 必须先于所有 UI 模块注入 —— 它们的样式表都从 window.__liaisonUITokens 取值，
// 令牌没就绪就会拿到 undefined 拼进 CSS。规范查看器见 toolbar/ui-kit.html。
const uiTokensScript = document.createElement('script')
uiTokensScript.src = platform.runtime.getURL('toolbar/ui-tokens.js')
document.body.appendChild(uiTokensScript)

// 设计系统「组件」面板（xiaoya3.0 设计规范）。同样先于 bundle 注入，保证
// bundle 的 _setActiveTabRaw 切到 design tab 时 window.__liaisonDesignUI 已就绪。
const designUiScript = document.createElement('script')
designUiScript.src = platform.runtime.getURL('toolbar/design-system-ui.js')
document.body.appendChild(designUiScript)

// Owner 模式（私有功能门控）：storage 里有 liaisonOwnerMode=true（作者本机
// 一次性设置）才注入 page world 标志脚本；同事的全新安装没有该 key，bundle 里
// 以 window.__liaisonOwnerMode 为条件的私有 UI（灵感面板「线下库」tab）不渲染。
// 异步读不阻塞注入链：面板要等用户交互后才首次渲染 tab 栏，标志早就绪。
try {
  platform.storage.local.get('liaisonOwnerMode').then((r) => {
    if (r && r.liaisonOwnerMode === true) {
      const ownerScript = document.createElement('script')
      ownerScript.src = platform.runtime.getURL('toolbar/owner-mode.js')
      document.body.appendChild(ownerScript)
    }
  }).catch(() => {})
} catch (e) {}

const script = document.createElement('script')
script.type = 'module'
script.src = platform.runtime.getURL('toolbar/bundle.min.js')
document.body.appendChild(script)

const liaison = document.createElement('liaison-app')
// 扩展资源 base URL 通过 attribute 传给 page world bundle（inline script 会被页面 CSP 挡，
// 属性不受影响）。bundle 读 host 元素的 asset-base 拼接 loading 动画等静态资源路径。
liaison.setAttribute('asset-base', platform.runtime.getURL(''))

document.body.prepend(liaison)

platform.runtime.onMessage.addListener(request => {
  if (request.action === 'liaisonInspLibChanged') {
    // 跨标签页同步（兜底通道）：另一个 tab 写入了采集库，背景 tabs.sendMessage 到本 tab。
    // __liaisonInsp 活在 page world（拿不到 chrome.runtime），经 postMessage 转发进去。
    window.postMessage({ _liaisonInspLibChanged: true }, '*')
  }
})

// 跨标签页同步（主通道）：监听 chrome.storage 的「版本信号」变化。
// 背景在 DbSet 成功后写 liaisonInspLibVersion；storage.onChanged 对所有已注入内容脚本
// 的页面可靠广播，不依赖点对点连接（比 tabs.sendMessage 稳）。转发进 page world 刷新。
try {
  platform.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (!changes || !changes.liaisonInspLibVersion) return
    window.postMessage({ _liaisonInspLibChanged: true }, '*')
  })
} catch (e) {}
})();
