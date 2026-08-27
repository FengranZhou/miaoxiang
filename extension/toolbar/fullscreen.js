// ============================================================================
// 全屏时弱化选中标注覆盖层
// ----------------------------------------------------------------------------
// 「线上参考」全屏管理采集库时，网页上那个粉色选中标注框（handles/label/hover
// 等覆盖层）会浮在面板上挡住库卡片。这里在全屏态下把这些覆盖层「视觉隐藏」，
// 不触碰实际选中状态（选中数据由 bundle 内部维护，与这些框的显示无关），
// 退出全屏自动恢复。
// ============================================================================

;(function () {
  if (window.__liaisonFsOverlay) return
  window.__liaisonFsOverlay = true

  // 注入隐藏样式：<html> 带 liaison-fs-on 类时，隐藏各标注覆盖层
  const style = document.createElement('style')
  style.id = 'liaison-fs-overlay-style'
  style.textContent = [
    'html.liaison-fs-on liaison-handles,',
    'html.liaison-fs-on liaison-handle,',
    'html.liaison-fs-on liaison-label,',
    'html.liaison-fs-on liaison-offscreen-label,',
    'html.liaison-fs-on liaison-hover,',
    'html.liaison-fs-on liaison-corners,',
    'html.liaison-fs-on liaison-gridlines,',
    'html.liaison-fs-on liaison-distance,',
    'html.liaison-fs-on liaison-boxmodel,',
    'html.liaison-fs-on liaison-overlay,',
    'html.liaison-fs-on liaison-metatip {',
    '  opacity: 0 !important;',
    '  pointer-events: none !important;',
    '}',
  ].join('\n')
  document.documentElement.appendChild(style)

  // 监听 liaison-style-panel 的 data-fullscreen，同步到 <html> 类
  function sync() {
    const panel = document.querySelector('liaison-style-panel')
    const on = !!(panel && panel.hasAttribute('data-fullscreen'))
    document.documentElement.classList.toggle('liaison-fs-on', on)
  }

  const mo = new MutationObserver(sync)
  mo.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-fullscreen'],
  })
  sync()
})()
