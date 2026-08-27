var platform = typeof browser === 'undefined'
  ? chrome
  : browser

var restore = () => {
  const liaison = document.createElement('liaison-app')
  // 与 inject.js 保持一致：bundle 靠 host 元素的 asset-base 拼静态资源 URL
  //（面板背景 / 空状态动图 / loading 动画）。restore 路径漏设会导致这些素材全部加载失败。
  liaison.setAttribute('asset-base', platform.runtime.getURL(''))
  document.body.prepend(liaison)
}

restore()
