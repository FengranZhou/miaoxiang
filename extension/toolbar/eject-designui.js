// 主世界清理脚本：由 eject.js 注入（隔离世界读不到主世界的 window，
// design-system-ui.js / bundle 都跑在主世界）。
//
// 独立成文件而非 inline：严格 CSP 的站点会拦截 inline script —— 项目里其余
// 5 处注入也都用 src 加载扩展文件。
//
// 做法遵循项目铁律「完整退出统一走 browse 路径」：向 liaison-top-toolbar 派发
// liaison-top-toolbar-browse → activateWorkspace("browse")，一次完成取选、
// 收面板、clearActiveFeature/exitComponent teardown（跟随光标的模式提示消失、
// 鼠标复原）、syncTopToolbar 清高亮。别自己拼散装调用 —— 那个「选择调整对象」
// 提示由常驻 mousemove 监听驱动，删 DOM 节点没用，鼠标一动就会重建；它的显示
// 条件第一行就是 workspace_mode === "browse" 时返回 null。
//
// 派发前必须直接置 tb._activeItem="browse"：set activeItem 只认
// design/dscomp/reference/inspection，"browse" 走 setter 会被静默忽略。
;(function () {
  try {
    var tb = document.querySelector('liaison-top-toolbar')
    if (tb) {
      try { tb._activeItem = 'browse' } catch (_) {}
      try { if (tb.syncStateToDom) tb.syncStateToDom() } catch (_) {}
      tb.dispatchEvent(new CustomEvent('liaison-top-toolbar-browse', {
        bubbles: true, composed: true,
      }))
    }
  } catch (_) {}

  // 兜底：browse 路径未生效时（工具条已被移除等），至少把组件模式收掉。
  try {
    var d = window.__liaisonDesignUI
    if (d && d.exitComponent) d.exitComponent()
  } catch (_) {}

  // 兜底：直接隐藏模式提示（bundle 暴露的关闭函数）。
  try {
    if (window.__liaisonHideModeTip) window.__liaisonHideModeTip()
  } catch (_) {}
})()
