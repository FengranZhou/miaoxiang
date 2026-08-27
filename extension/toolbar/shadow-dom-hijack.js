/**
 * Shadow DOM 劫持脚本
 *
 * 必须在 document_start 阶段注入，早于宿主创建 liaison-style-panel。
 * 目的：强制将 closed shadow root 改写为 open，以便设计系统扩展能访问。
 */

;(function () {
  'use strict'

  // 保存原始的 attachShadow
  const originalAttachShadow = Element.prototype.attachShadow

  // 劫持 attachShadow
  Element.prototype.attachShadow = function (init) {
    // 强制将所有 closed 模式改为 open（针对 liaison-style-panel 等组件）
    if (init && init.mode === 'closed') {
      console.log('[shadow-hijack] 拦截到 closed shadow root，强制改为 open:', this.tagName)
      init = Object.assign({}, init, { mode: 'open' })
    }

    // 调用原始方法
    const shadowRoot = originalAttachShadow.call(this, init)

    // 如果是 liaison-style-panel，保存引用供后续使用
    if (this.tagName === 'LIAISON-STYLE-PANEL') {
      console.log('[shadow-hijack] liaison-style-panel shadow root 已开放')
      window.__liaisonStylePanelShadowRoot = shadowRoot
    }

    return shadowRoot
  }

  console.log('[shadow-hijack] Shadow DOM 劫持已就位')
})()
