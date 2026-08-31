// 退出：除了移除 liaison-app，还要收掉挂在 documentElement 上的组件模式 UI。
// design-system-ui.js 把拾取层 / 指令浮层 / 拖拽框等 12 处直接挂在
// documentElement 上，不在 liaison-app 子树里 —— 只 remove liaison-app 会把
// 它们留在页面上，表现为「关掉妙想后鼠标仍是打点态、还能点出『输入"/"调用组件』」。
//
// 注意作用域：design-system-ui.js 是 inject.js 用 <script> 标签注进「页面主世界」的，
// 而本文件由 executeScript 注入「隔离世界」，两个 window 不互通 —— 直接读
// window.__liaisonDesignUI 永远是 undefined。必须往主世界注脚本去调它。
try {
  const platform = typeof browser === 'undefined' ? chrome : browser
  const s = document.createElement('script')
  s.src = platform.runtime.getURL('toolbar/eject-designui.js')
  s.onload = () => s.remove()
  ;(document.head || document.documentElement).appendChild(s)
} catch (_) {}

document.querySelectorAll('liaison-app')
  .forEach(node => {
    node.animate(
      [{transform: 'translateX(-200%)', opacity:0}],
      {
        duration: 300,
        easing: 'ease-out',
      }).onfinish = e => node.remove()
  })
