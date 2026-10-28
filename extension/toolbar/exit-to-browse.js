// ============================================================================
// 退回浏览态（page world）
// ----------------------------------------------------------------------------
// 由 update-modal.js 在弹更新弹窗前以 <script src> 注入主世界。
//
// 为什么需要：「调整」等模式在 document 捕获阶段拦截点击（preventDefault +
// stopPropagation），弹窗里的「立即更新」按钮会点不动。必须把工作区真正退到
// browse，光藏面板 DOM 没用。
//
// 为什么在主世界：走 browse 路径前要直接写 tb._activeItem（set activeItem 会
// 忽略 "browse"），而这个属性只在主世界的元素对象上，隔离世界看不到。
// 做法与面板 × 按钮完全一致（见 CLAUDE.md「退出 / 清理 / 取选一律走 browse 路径」）。
//
// 首次唤起时弹窗可能早于 bundle 建好工具条，所以轮询等它出现（最多 5 秒）。
// ============================================================================
;(function () {
  var tries = 0
  function go() {
    var tb = document.querySelector('liaison-top-toolbar')
    if (!tb) {
      if (++tries < 50) setTimeout(go, 100)
      return
    }
    try {
      tb._activeItem = 'browse'
      tb.syncStateToDom && tb.syncStateToDom()
      tb.dispatchEvent(new CustomEvent('liaison-top-toolbar-browse', { bubbles: true, composed: true }))
    } catch (_) {}
  }
  go()
})()
