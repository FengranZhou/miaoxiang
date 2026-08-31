// 开屏动画：每次唤起工具条（首次注入 / 切回显示）时全屏播一遍品牌动画。
// 由 background 在 toggle-in 的两条路径上 executeScript 注入，与 inject.js /
// restore.js 并行执行，互不依赖。
;(() => {
  const platform = typeof browser === 'undefined' ? chrome : browser

  const OVERLAY_ID = 'liaison-splash-overlay'
  const HIDE_STYLE_ID = 'liaison-splash-hide'
  if (document.getElementById(OVERLAY_ID)) return   // 防重复注入

  // 动画期间先藏起工具条和猫按钮，播完再放出来（避免动画没完 UI 先冒出来）。
  // 用 !important 样式表压制，因为按钮有 rAF 循环在不断写内联 display。
  const hideStyle = document.createElement('style')
  hideStyle.id = HIDE_STYLE_ID
  // 工具条(liaison-top-toolbar)和面板(liaison-style-panel)都是挂在 body 下的独立顶层元素，
  // 不在 liaison-app 里，要单独列。面板还被 __liRaiseChrome 提进 popover top layer，
  // 顶层不受 z-index 约束，光靠 overlay 的 z-index 压不住，只能用 opacity 压制。
  hideStyle.textContent = 'liaison-app, liaison-top-toolbar, liaison-style-panel, #__li-toolbar-close-btn, #__li-hover-freeze-btn { opacity: 0 !important; pointer-events: none !important; }'
  ;(document.head || document.documentElement).appendChild(hideStyle)

  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  // 全部内联样式 + 显式钉死可继承属性，避免宿主页样式渗入
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'background:#000',   // 开场是黑底液态金属，起手不能闪白
    'display:flex', 'align-items:center', 'justify-content:center',
    'opacity:0', 'transition:opacity 1s ease',   // 第 1 段：背景+三角锥渐显
    'cursor:pointer', 'line-height:normal', 'margin:0', 'padding:0',
  ].join(';')

  // ===== 四周边缘流光 =====
  // 复用采集占位卡片 .insp-skel-edge 的机制：一个 conic-gradient 扇形慢速自转，
  // 用四向 mask 只保留视口边缘一圈、中间挖空，blur + screen 混出流光感。
  // 以下数值均为「开场流光调参台」定稿导出，改动请回调参台调完再覆盖。
  const EDGE_W = 65             // 辉光从视口边缘往内渗透的宽度(px)
  const EDGE_BLUR = 160         // 模糊半径(px)：远大于带宽，边界被彻底揉开
  const EDGE_SIZE = 200         // 扇形层尺寸(%)，越大转动时四角越不易露空
  const EDGE_SPIN_MS = 6000     // 自转一圈时长(ms)
  const EDGE_BREATHE_MS = 10000 // 呼吸一个来回时长(ms)
  const EDGE_OP_MIN = 0.66      // 呼吸透明度下限
  const EDGE_OP_MAX = 1         // 呼吸透明度上限
  // 扇形色标：蓝 → 亮青 → 近白 → 青绿 → 绿，两端由 transparent 收口
  const EDGE_STOPS = [
    'rgba(56,189,248,0.48) 20deg',
    'rgba(120,220,255,0.57) 70deg',
    'rgba(216,251,255,0.4) 98deg',
    'rgba(56,230,200,0.55) 126deg',
    'rgba(16,224,192,0.17) 180deg',
  ].join(',')
  // 四条方向渐变叠加(mask-composite:add)，等价于「只在边缘 EDGE_W 内可见」
  const EDGE_MASK = [
    'linear-gradient(to bottom,#000 0,transparent ' + EDGE_W + 'px)',
    'linear-gradient(to top,#000 0,transparent ' + EDGE_W + 'px)',
    'linear-gradient(to right,#000 0,transparent ' + EDGE_W + 'px)',
    'linear-gradient(to left,#000 0,transparent ' + EDGE_W + 'px)',
  ].join(',')
  const EDGE_OFF = (100 - EDGE_SIZE) / 2   // 扇形层居中所需的负偏移(%)
  const edgeStyle = document.createElement('style')
  edgeStyle.textContent = [
    '#' + OVERLAY_ID + ' .li-splash-edge{',
    'position:absolute;inset:0;z-index:1;overflow:hidden;pointer-events:none;',
    '-webkit-mask:' + EDGE_MASK + ';mask:' + EDGE_MASK + ';',
    '-webkit-mask-composite:source-over;mask-composite:add;}',
    // 转的是这一层
    '#' + OVERLAY_ID + ' .li-splash-edge::before{',
    'content:"";position:absolute;pointer-events:none;',
    'left:' + EDGE_OFF + '%;top:' + EDGE_OFF + '%;',
    'width:' + EDGE_SIZE + '%;height:' + EDGE_SIZE + '%;',
    'background:conic-gradient(from 0deg,transparent 0deg,' + EDGE_STOPS + ',transparent 360deg);',
    'filter:blur(' + EDGE_BLUR + 'px);mix-blend-mode:screen;',
    'animation:li-splash-edge-spin ' + EDGE_SPIN_MS + 'ms linear infinite,',
    'li-splash-edge-breathe ' + EDGE_BREATHE_MS + 'ms ease-in-out infinite alternate;}',
    '@keyframes li-splash-edge-spin{to{transform:rotate(360deg);}}',
    '@keyframes li-splash-edge-breathe{from{opacity:' + EDGE_OP_MIN + ';}to{opacity:' + EDGE_OP_MAX + ';}}',
  ].join('')
  const edge = document.createElement('div')
  edge.className = 'li-splash-edge'

  // ===== 整段节奏 =====
  //   [0]      挂载，overlay + canvas 同时开始渐显
  //   [1000]   渐显完成 → 缩放时间轴起算（T0）
  //   +0       S_DELAY 静置（已取消，渐显完成即开始缩放）
  //   +1500    三角锥 6.4 → 2.6 缩放，同时纵向 -93 → -35
  //   -1300    缩放收尾前 1300ms 视频起播，渐显 1.5s、收缩 1.5→1
  //   视频 ended → 全部渐隐消散
  const FADE_IN_MS = 1000      // 与 overlay 的 transition 时长一致，改一处要同步改
  const VID_LEAD_MS = 1300     // 视频提前于缩放结束的量
  const VID_FADE_MS = 1500     // 视频自身渐显时长（在提前量里跑完）
  const VID_FADE_DELAY = 500   // 渐显比起播晚起步的量(ms)，起止整段顺延
  const VID_SCALE_FROM = 1.5   // 视频入场起始缩放，收到 1 即当前尺寸
  const VID_SCALE_MS = 1000    // 收缩时长，与渐显各走各的，互不牵连
  const VID_SCALE_DELAY = 500  // 缩放比渐显晚起步的量(ms)，整段随之顺延
  // 先快后慢：起手冲得猛、尾段拖长收住（ease-out-expo）
  const VID_SCALE_EASE = 'cubic-bezier(0.16,1,0.3,1)'

  // 素材 480×480 内含上下两块，中间 y=180~219 是整片空白：
  //   上半 y  77~179  「妙想」文字 —— 裁掉，改由下方 DOM 文字层承担
  //   下半 y 220~424   猫头
  // 从空白带正中(y=200，即 41.7%)往下裁，裁切线落在空隙里不伤内容。
  const VID_CLIP_TOP = 0.417
  // 裁掉上半后方盒仍是正方形，若继续按盒居中，猫头会整体下沉。
  // 上移「被裁掉部分的一半」，使剩余可见区的中心重回视口中心。
  const VID_CLIP_SHIFT = VID_CLIP_TOP / 2

  // ===== 「喵想 → 妙想」文字层 =====
  // 视频里的文字被 clip-path 裁掉，改由这一层承担，好处是能做扫光换字。
  // 机制复刻自 DiaTextReveal：一条 300% 宽的渐变横扫过文字，
  // background-clip:text 使其只在字形内可见；渐变构成为
  //   [实色 0~33.33%] [彩带 40~60%] [透明 66.67~100%]
  // 把 background-position 由 100% 扫到 0%，字即被「擦」出来，opacity 同步跟上。
  // 素材里文字块在 y=77~179，即盒高 16.0%~37.3%；对齐它的顶部
  const TXT_TOP_RATIO = 0.16     // 文字块相对视频盒顶部的位置
  const TXT_SIZE_RATIO = 0.21    // 字号 / 视频盒边长
  const TXT_FADE_MS = 900        // 入场渐显时长（两个字同时，不扫光）
  const TXT_SWEEP_MS = 1500      // 换字扫光时长
  const TXT_SWEEP_EASE = 'cubic-bezier(0.23,1,0.32,1)'   // 原组件默认曲线
  const TXT_BAND = 20            // 彩带宽度(%)，即渐变 40~60%
  const TXT_COLOR = '#12151A'    // 文字底色
  // 入场只要纯白扫过，彩带同色即退化为无彩色过渡
  const TXT_COLORS_IN = [TXT_COLOR]
  // 换字时才出彩：DiaTextReveal 原版配色
  const TXT_COLORS_SWAP = ['#c679c4', '#fa3d1d', '#ffb005', '#e1e1fe', '#0358f7']

  // 与原组件 buildGradient 等价
  const txtGradient = (colors) => {
    const s = 50 - TXT_BAND / 2, e = 50 + TXT_BAND / 2
    const stops = colors.map((c, i) => {
      const t = colors.length === 1 ? 0.5 : i / (colors.length - 1)
      return c + ' ' + (s + t * (e - s)).toFixed(2) + '%'
    }).join(', ')
    return 'linear-gradient(90deg,' + TXT_COLOR + ' 0%,' + TXT_COLOR + ' 33.33%,' +
      stops + ',transparent 66.67%,transparent 100%)'
  }

  const txtStyle = document.createElement('style')
  txtStyle.textContent = [
    '#' + OVERLAY_ID + ' .li-splash-txt{',
    'position:absolute;z-index:3;pointer-events:none;',
    // 两个字都是等高的定宽盒，用 center 对齐即可严格同线
    'display:flex;align-items:center;justify-content:center;',
    // 显式钉死可继承属性，防宿主页样式渗入
    'font-weight:700;line-height:1.15;letter-spacing:0.04em;',
    'font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
    'font-style:normal;text-align:center;white-space:nowrap;}',
    // 每个字独立扫光，首字换字时只重放它自己
    '#' + OVERLAY_ID + ' .li-splash-g{',
    // 与槽位等高，两个字才在同一条水平线上
    'display:flex;align-items:center;justify-content:center;height:1.15em;',
    'background-size:300% 100%;',
    '-webkit-background-clip:text;background-clip:text;',
    '-webkit-text-fill-color:transparent;color:transparent;',
    'background-position:100% 50%;opacity:0;',
    'will-change:background-position,opacity;}',
    // 首字是会切换的槽位：宽度锁死，换字时不推挤后面的「想」。
    // 槽内的字是 absolute、脱离文档流，父级的 baseline 对齐管不到它，
    // 所以槽位本身按 inline-block 参与基线对齐，内部用 inset:0 + flex 居中，
    // 两个字才会落在同一条水平线上。
    '#' + OVERLAY_ID + ' .li-splash-slot{',
    'position:relative;display:inline-block;',
    'width:1.04em;height:1.15em;vertical-align:top;}',
    '#' + OVERLAY_ID + ' .li-splash-slot .li-splash-g{',
    'position:absolute;inset:0;width:100%;',
    'display:flex;align-items:center;justify-content:center;}',
  ].join('')

  const txt = document.createElement('div')
  txt.className = 'li-splash-txt'
  const slot = document.createElement('span')
  slot.className = 'li-splash-slot'
  const tail = document.createElement('span')
  tail.className = 'li-splash-g'
  tail.textContent = '想'
  txt.appendChild(slot)
  txt.appendChild(tail)

  // 入场：不扫光，纯白直接渐显。整段只有 opacity 在动。
  const fadeIn = (el) => {
    el.style.backgroundImage = 'none'
    el.style.webkitTextFillColor = TXT_COLOR
    el.style.color = TXT_COLOR
    return el.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: TXT_FADE_MS, easing: 'ease', fill: 'both' })
  }

  // 换字用的扫光：渐变由 100% 扫到 0%，opacity 同步 0→1
  const sweepIn = (el, colors) => {
    // 从 fadeIn 的纯白态切回渐变态，两个填充属性都要还原
    el.style.webkitTextFillColor = 'transparent'
    el.style.color = 'transparent'
    el.style.backgroundImage = txtGradient(colors || TXT_COLORS_IN)
    return el.animate(
      [
        { backgroundPosition: '100% 50%', opacity: 0 },
        { backgroundPosition: '0% 50%', opacity: 1 },
      ],
      { duration: TXT_SWEEP_MS, easing: TXT_SWEEP_EASE, fill: 'both' },
    )
  }

  let glyph = document.createElement('span')   // 当前首字
  glyph.className = 'li-splash-g'
  glyph.textContent = '喵'
  slot.appendChild(glyph)

  // 「喵」→「妙」：旧字原地淡出，新字扫光进场
  const swapGlyph = () => {
    if (gone) return
    const next = document.createElement('span')
    next.className = 'li-splash-g'
    next.textContent = '妙'
    const old = glyph
    slot.appendChild(next)
    glyph = next
    old.animate([{ opacity: 1 }, { opacity: 0 }],
      { duration: 320, easing: 'ease-in-out', fill: 'both' })
      .onfinish = () => { try { old.remove() } catch (_) {} }
    sweepIn(next, TXT_COLORS_SWAP)   // 只有换字这一下出彩
  }

  const video = document.createElement('video')
  video.muted = true
  video.autoplay = false   // 起播时机由缩放时间轴反推，见 showShader()
  video.playsInline = true
  video.src = platform.runtime.getURL('toolbar/assets/splash.webm')
  video.style.cssText = [
    // 位置和尺寸由 placeVideo() 按视口短边实时反算，居中显示
    'position:absolute', 'display:block', 'pointer-events:none',
    'margin:0', 'padding:0', 'border:0', 'background:transparent',
    // 起播压在缩放收尾前 VID_LEAD_MS，用前 VID_FADE_MS 渐显淡入；
    // 收缩从 VID_SCALE_FROM 到 1，比渐显晚 VID_SCALE_DELAY 起步，起止整段顺延。
    // transform 基点默认为中心，与 left/top 的居中定位一致，收缩时猫头不位移。
    // 注意：两条过渡之间是逗号，必须拼成一个数组元素——
    // 拆成两个会被 join(';') 插入分号，整条 transition 语法失效而被丢弃
    'opacity:0', 'transform:scale(' + VID_SCALE_FROM + ')',
    'transition:opacity ' + VID_FADE_MS + 'ms ease ' + VID_FADE_DELAY + 'ms, ' +
      'transform ' + VID_SCALE_MS + 'ms ' + VID_SCALE_EASE + ' ' + VID_SCALE_DELAY + 'ms',
    // 裁掉上半的文字，只留猫头；文字改由 .li-splash-txt 承担
    'clip-path:inset(' + (VID_CLIP_TOP * 100).toFixed(1) + '% 0 0 0)',
  ].join(';')

  // ===== 睁眼视频段 =====
  // 视频盒为正方形，边长取视口短边的一个比例，居中显示。
  const VID_SIZE_RATIO = 0.16   // 视频盒边长 / 视口短边
  const VID_NUDGE_Y = 8         // 视频单独下移的像素，文字层不跟

  const placeVideo = () => {
    const vw = window.innerWidth, vh = window.innerHeight
    const V = Math.round(Math.min(vw, vh) * VID_SIZE_RATIO)
    video.style.width = V + 'px'
    video.style.height = V + 'px'
    video.style.left = Math.round((vw - V) / 2) + 'px'
    const top = Math.round((vh - V) / 2 - V * VID_CLIP_SHIFT)
    // 视频单独下移 VID_NUDGE_Y，文字层不跟：两者的 top 各自算，互不牵连
    video.style.top = (top + VID_NUDGE_Y) + 'px'
    // 文字层顶到猫头上方，占位与被裁掉的原素材文字块一致
    txt.style.left = Math.round((vw - V) / 2) + 'px'
    txt.style.width = V + 'px'
    txt.style.top = Math.round(top + V * TXT_TOP_RATIO) + 'px'
    txt.style.fontSize = Math.round(V * TXT_SIZE_RATIO) + 'px'
  }

  // 摇头前的停顿加长：素材 85 帧 @24fps（原始序列 _00011 起编号）
  //   帧 30    睁眼完成、正脸稳定态，即原素材 合成 1_00040.png
  //   帧 31    差分骤升到 14.5，摇头起手
  //   帧 54~85 差分归 0，静止的尾巴
  // 做法是播到帧 30 定住 VID_PAUSE_MS 再放。定的是睁眼完成后的稳定画面，
  // 不是渐变中途，所以是「停顿」而非「卡帧」。摇头及之后一帧不变。
  // 取 26 而非 30：currentTime 跨过阈值时，解码/合成还会往后走几帧才真正上屏，
  // 卡在 30 实测已经歪头了。往前留 4 帧余量，停下来才是干净的正脸。
  const VID_PAUSE_AT = 26 / 24    // 摇头起手前那一刻(s)
  const VID_PAUSE_MS = 500        // 在此处多停多久
  let held = false                 // 只在第一次经过时定住

  const startVideo = () => {
    if (gone) return
    video.style.opacity = '1'
    video.style.transform = 'scale(1)'
    // 文字与视频同步登场：延迟对齐视频渐显，两者一起亮起来
    setTimeout(() => {
      if (gone) return
      fadeIn(glyph)
      fadeIn(tail)
    }, VID_FADE_DELAY)
    // 用 rAF 而非 timeupdate 轮询：后者约 250ms 才触发一次，而帧 30→31
    // 的窗口只有 42ms，很可能整个跳过、停到摇头中途去。
    const watch = () => {
      if (held || gone) return
      if (video.currentTime >= VID_PAUSE_AT) {
        held = true
        video.pause()
        setTimeout(() => {
          if (gone) return
          swapGlyph()   // 停顿结束、摇头起手的同一刻换字
          const r = video.play()
          if (r && typeof r.catch === 'function') r.catch(dismiss)
        }, VID_PAUSE_MS)
        return
      }
      requestAnimationFrame(watch)
    }
    requestAnimationFrame(watch)
    const p = video.play()
    if (p && typeof p.catch === 'function') p.catch(dismiss)
  }

  // ===== Prism 棱镜背景（WebGL shader）。失败即静默退回纯黑底 =====
  // 移植自 React Bits 的 Prism 组件：raymarch 一个各向异性八面体的上半部（金字塔），
  // 沿射线累加正弦色带形成体积光。原实现依赖 React + ogl，这里剥离为原生 WebGL1。
  let stopShader = null
  let showShader = null   // 渐显完成时调用，开启缩放时间轴
  try {
    const canvas = document.createElement('canvas')
    // canvas 不单独渐显：与 overlay 一起被父级的 opacity 过渡带出来，
    // 保证「背景 + 三角锥」是同一条渐显曲线，不会出现底色先亮一拍
    // z-index 0：canvas 是 alpha:false 的不透明底，必须压在边缘流光(1)和视频(2)之下
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;margin:0;padding:0;border:0;z-index:0;'
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false })
    if (gl) {
      // 调参台定稿值
      // scale 不在此列：它是动画量，由下方 S_FROM/S_TO 驱动
      const P_TIMESCALE = 0.3, P_HEIGHT = 1, P_BASEWIDTH = 2.3
      const P_HUESHIFT = 0.358, P_COLORFREQ = 0.9
      // 纵向位置：随缩放曲线从 O_FROM 同步移动到 O_TO（CSS 方向，负值为上）。
      // 两值设成相同即退化为整段固定偏移。
      const O_FROM = -93, O_TO = -15   // 起点偏高，随推进下沉到终点
      const P_GLOW = 1.5, P_BLOOM = 0.72, P_NOISE = 0, P_SATURATION = 1.3

      // ===== 三角锥缩放动画（调参台定稿）=====
      // scale 语义与调参台一致：值越大 → 视野越广 → 锥体看着越小。
      // 6.0 → 2.0 即由远及近推进。时间轴从渐显完成起算，见上方「整段节奏」。
      const S_FROM = 5.5
      const S_TO = 2.6
      const S_DELAY = 0           // 起播前的静置时长(ms)；0 = 渐显完成即开始缩放
      const S_DUR = 1500          // 缓动时长(ms)
      const S_EASE = [0.534, -0.035, 0, 1.009]   // cubic-bezier，起手轻微回抽

      // 三次贝塞尔求值：给定 CSS cubic-bezier(x1,y1,x2,y2) 与进度 x，牛顿迭代解出 y
      const bezier = (x1, y1, x2, y2) => {
        const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
        const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
        const fx = (t) => ((ax * t + bx) * t + cx) * t
        const dfx = (t) => (3 * ax * t + 2 * bx) * t + cx
        return (x) => {
          if (x <= 0) return 0
          if (x >= 1) return 1
          let t = x
          for (let i = 0; i < 6; i++) {
            const d = dfx(t)
            if (Math.abs(d) < 1e-6) break
            const e = fx(t) - x
            if (Math.abs(e) < 1e-6) break
            t -= e / d
          }
          t = Math.min(1, Math.max(0, t))
          return ((ay * t + by) * t + cy) * t
        }
      }
      const easeScale = bezier(S_EASE[0], S_EASE[1], S_EASE[2], S_EASE[3])
      let scaleT0 = 0             // showShader() 时打点；为 0 表示尚未起播

      const VERT = 'attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0.,1.);}'
      const FRAG = [
        'precision highp float;',
        'uniform vec2 iResolution;',
        'uniform float iTime;',
        'uniform float uHeight;',
        'uniform float uBaseHalf;',
        'uniform float uGlow;',
        'uniform vec2 uOffsetPx;',
        'uniform float uNoise;',
        'uniform float uSaturation;',
        'uniform float uHueShift;',
        'uniform float uColorFreq;',
        'uniform float uBloom;',
        'uniform float uCenterShift;',
        'uniform float uInvBaseHalf;',
        'uniform float uInvHeight;',
        'uniform float uMinAxis;',
        'uniform float uPxScale;',
        'uniform float uTimeScale;',
        'vec4 tanh4(vec4 x){ vec4 e2x = exp(2.0*x); return (e2x - 1.0) / (e2x + 1.0); }',
        'float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453123); }',
        'float sdOctaAnisoInv(vec3 p){',
        '  vec3 q = vec3(abs(p.x)*uInvBaseHalf, abs(p.y)*uInvHeight, abs(p.z)*uInvBaseHalf);',
        '  float m = q.x + q.y + q.z - 1.0;',
        '  return m * uMinAxis * 0.5773502691896258;',
        '}',
        'float sdPyramidUpInv(vec3 p){ return max(sdOctaAnisoInv(p), -p.y); }',
        'mat3 hueRotation(float a){',
        '  float c = cos(a), s = sin(a);',
        '  mat3 W = mat3(0.299,0.587,0.114, 0.299,0.587,0.114, 0.299,0.587,0.114);',
        '  mat3 U = mat3(0.701,-0.587,-0.114, -0.299,0.413,-0.114, -0.300,-0.588,0.886);',
        '  mat3 V = mat3(0.168,-0.331,0.500, 0.328,0.035,-0.500, -0.497,0.296,0.201);',
        '  return W + U*c + V*s;',
        '}',
        'void main(){',
        '  vec2 f = (gl_FragCoord.xy - 0.5*iResolution.xy - uOffsetPx) * uPxScale;',
        '  float z = 5.0;',
        '  float d = 0.0;',
        '  vec3 p;',
        '  vec4 o = vec4(0.0);',
        // animationType=rotate：只做 shader 内 base wobble，不做整体旋转
        '  float t = iTime * uTimeScale;',
        '  float c0 = cos(t), c1 = cos(t + 33.0), c2 = cos(t + 11.0);',
        '  mat2 wob = mat2(c0, c1, c2, c0);',
        '  for (int i = 0; i < 100; i++) {',
        '    p = vec3(f, z);',
        '    p.xz = wob * p.xz;',
        '    vec3 q = p;',
        '    q.y += uCenterShift;',
        '    d = 0.1 + 0.2 * abs(sdPyramidUpInv(q));',
        '    z -= d;',
        '    o += (sin((p.y + z) * uColorFreq + vec4(0.0,1.0,2.0,3.0)) + 1.0) / d;',
        '  }',
        '  o = tanh4(o * o * (uGlow * uBloom) / 1e5);',
        '  vec3 col = o.rgb;',
        '  if (uNoise > 0.000001) col += (rand(gl_FragCoord.xy + vec2(iTime)) - 0.5) * uNoise;',
        '  col = clamp(col, 0.0, 1.0);',
        '  float L = dot(col, vec3(0.2126,0.7152,0.0722));',
        '  col = clamp(mix(vec3(L), col, uSaturation), 0.0, 1.0);',
        '  if (abs(uHueShift) > 0.0001) col = clamp(hueRotation(uHueShift) * col, 0.0, 1.0);',
        '  gl_FragColor = vec4(col, 1.0);',
        '}',
      ].join('\n')
      const compile = (type, src) => {
        const sh = gl.createShader(type)
        gl.shaderSource(sh, src)
        gl.compileShader(sh)
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed')
        return sh
      }
      const prog = gl.createProgram()
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'program link failed')
      gl.useProgram(prog)
      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      const loc = gl.getAttribLocation(prog, 'a_pos')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

      const U = (n) => gl.getUniformLocation(prog, n)
      const uRes = U('iResolution'), uTime = U('iTime'), uPxScale = U('uPxScale')
      const uOffsetPx = U('uOffsetPx')
      const H = Math.max(0.001, P_HEIGHT), BH = Math.max(0.001, P_BASEWIDTH) * 0.5
      // 与分辨率无关的常量只需设一次
      gl.uniform1f(U('uHeight'), H)
      gl.uniform1f(U('uBaseHalf'), BH)
      gl.uniform1f(U('uGlow'), P_GLOW)
      gl.uniform1f(U('uNoise'), P_NOISE)
      gl.uniform1f(U('uSaturation'), P_SATURATION)
      gl.uniform1f(U('uHueShift'), P_HUESHIFT)
      gl.uniform1f(U('uColorFreq'), P_COLORFREQ)
      gl.uniform1f(U('uBloom'), P_BLOOM)
      gl.uniform1f(U('uCenterShift'), H * 0.25)
      gl.uniform1f(U('uInvBaseHalf'), 1 / BH)
      gl.uniform1f(U('uInvHeight'), 1 / H)
      gl.uniform1f(U('uMinAxis'), Math.min(BH, H))
      gl.uniform1f(U('uTimeScale'), P_TIMESCALE)

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      // 缓动进度：0 = 停在起点（含渐显期与 S_DELAY 静置），1 = 抵达终点。
      // scale 与纵向位移共用这一个值，保证两者严格同步。
      const easedAt = (now) => {
        if (!scaleT0) return 0
        const e = now - scaleT0 - S_DELAY
        if (e <= 0) return 0
        if (e >= S_DUR) return 1
        return easeScale(e / S_DUR)
      }
      // uPxScale 依赖 drawingBuffer 高度和当前 scale，uOffsetPx 依赖 dpr —— 都随进度重算
      const applyAnim = (k) => {
        const s = S_FROM + (S_TO - S_FROM) * k
        gl.uniform1f(uPxScale, 1 / ((canvas.height || 1) * 0.1 * Math.max(0.001, s)))
        gl.uniform2f(uOffsetPx, 0, (O_FROM + (O_TO - O_FROM) * k) * dpr)
      }
      const resize = () => {
        const w = Math.max(1, Math.round(window.innerWidth * dpr))
        const h = Math.max(1, Math.round(window.innerHeight * dpr))
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
          gl.viewport(0, 0, w, h)
        }
        gl.uniform2f(uRes, canvas.width, canvas.height)
        applyAnim(easedAt(performance.now()))
      }
      resize()
      window.addEventListener('resize', resize)
      let raf = 0
      const t0 = performance.now()
      const frame = () => {
        resize()
        gl.uniform1f(uTime, (performance.now() - t0) * 0.001)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)
      stopShader = () => {
        cancelAnimationFrame(raf)
        window.removeEventListener('resize', resize)
        const ext = gl.getExtension('WEBGL_lose_context')
        if (ext) { try { ext.loseContext() } catch (_) {} }
      }
      overlay.appendChild(canvas)
      // 由 mount() 在渐显完成时调用，作为缩放时间轴的 T0
      showShader = () => {
        scaleT0 = performance.now()
        // 视频压在缩放收尾前 VID_LEAD_MS 起播，让推进的尾劲接上睁眼
        const lead = Math.max(0, S_DELAY + S_DUR - VID_LEAD_MS)
        setTimeout(startVideo, lead)
      }
      // 视频在最上层：canvas(0) < 边缘流光(1) < 视频(2)
      video.style.zIndex = '2'
    }
  } catch (_) { stopShader = null }

  // 边缘流光垫在 canvas 之上、视频之下：三角锥的辉光和它叠加，睁眼动画不被遮。
  // style 挂在 overlay 内部而非 document.head，随 overlay.remove() 一起回收，不留残留。
  overlay.appendChild(edgeStyle)
  overlay.appendChild(edge)
  overlay.appendChild(video)
  // 文字层压在视频之上：canvas(0) < 边缘流光(1) < 视频(2) < 文字(3)。
  // style 挂在 overlay 内部，随 overlay.remove() 一起回收，不留残留。
  overlay.appendChild(txtStyle)
  overlay.appendChild(txt)

  let gone = false
  const dismiss = () => {
    if (gone) return
    gone = true
    overlay.style.opacity = '0'
    const hs = document.getElementById(HIDE_STYLE_ID)
    if (hs) hs.remove()   // 放出工具条
    setTimeout(() => {
      overlay.remove()
      if (stopShader) { try { stopShader() } catch (_) {} }
    }, 400)
  }

  window.addEventListener('resize', () => {
    if (gone) return
    placeVideo()
  })

  video.addEventListener('ended', dismiss)
  video.addEventListener('error', dismiss)
  overlay.addEventListener('click', dismiss)   // 点一下跳过
  // 兜底：任何异常都不能把页面盖死。渐显 1s + 静置 .8s + 缩放 1.2s - 提前量 .7s + 睁眼 3.55s ≈ 5.85s，留一截余量
  setTimeout(dismiss, 8000)

  const mount = () => {
    ;(document.body || document.documentElement).appendChild(overlay)
    placeVideo()
    // 渐显：下一帧再把透明度拉起来，让 transition 生效
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!gone) overlay.style.opacity = '1'
      // 渐显完成才开缩放时间轴（视频起播由该时间轴反推）
      setTimeout(() => {
        if (gone) return
        if (showShader) { try { showShader() } catch (_) { startVideo() } }
        else startVideo()   // shader 不可用：直接起播，不能把开场卡死
      }, FADE_IN_MS)
    }))
  }

  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
})()
