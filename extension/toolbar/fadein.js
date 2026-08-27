// 工具条渐显入场：splash 被「每次扩展加载只播一次」门闩跳过时，由 background
// 代替 splash.js 注入本脚本，让工具条不要硬生生蹦出来，而是 0.35s 渐显。
// 元素清单与 splash.js 的 hideStyle 保持一致。
;(() => {
  const STYLE_ID = 'liaison-fadein-style'
  if (document.getElementById(STYLE_ID)) return   // 防重复注入
  // splash 正在播的话（理论上不会同时注入），交给 splash 自己控制
  if (document.getElementById('liaison-splash-overlay')) return

  const SELECTOR = 'liaison-app, liaison-top-toolbar, #__li-toolbar-close-btn, #__li-hover-freeze-btn'

  // 阶段一：压透明。用 !important 样式表，盖过按钮 rAF 循环写的内联样式。
  const st = document.createElement('style')
  st.id = STYLE_ID
  st.textContent = SELECTOR + ' { opacity: 0 !important; }'
  ;(document.head || document.documentElement).appendChild(st)

  let done = false
  const reveal = () => {
    if (done) return
    done = true
    // 阶段二：换成只保留 transition 的规则，opacity 回落到元素自身值（1），
    // 因过渡此刻已挂在元素上，0 → 1 会以 0.35s 渐显完成入场。
    st.textContent = SELECTOR + ' { transition: opacity .35s ease !important; }'
    setTimeout(() => st.remove(), 500)
  }

  // 等工具条真的挂上 DOM（inject.js 构建 UI 需要一点时间），再等两帧放行；
  // 2.5s 兜底：任何异常都不能把 UI 永久压住。
  const t0 = performance.now()
  const tick = () => {
    if (done) return
    const ready = document.querySelector('liaison-top-toolbar') || document.querySelector('liaison-app')
    if (ready) {
      requestAnimationFrame(() => requestAnimationFrame(reveal))
      return
    }
    if (performance.now() - t0 > 2500) { reveal(); return }
    requestAnimationFrame(tick)
  }
  tick()
  setTimeout(reveal, 2500)
})()
