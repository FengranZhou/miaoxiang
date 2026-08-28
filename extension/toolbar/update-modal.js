// ============================================================================
// 版本更新强提醒弹窗（content script，isolated world）
// ----------------------------------------------------------------------------
// 由 liaison.js（background）在工具栏注入链末尾 executeScript 进来。是否要弹
// 完全由 storage 里 background 写好的结论决定：
//
//   liaisonUpdateAvailable      有新版（远端 version > 本地）
//   liaisonUpdateModalEligible  本地 < 门槛线 notifyFloor（弹窗资格，background 算好）
//   liaisonUpdateNotifyFloor    门槛线原值（「跳过此版本」按它静音）
//   liaisonUpdateLatest / liaisonUpdateNotes / liaisonUpdateDownloadUrl
//
// 本文件自己写两个门闸 key：
//   liaisonUpdateModalLastShownDate  当天已弹过（YYYY-MM-DD，先写后弹，跨 tab 抢占）
//   liaisonUpdateModalDismissedFloor 用户点「跳过此版本」静音的门槛线
//
// 打扰频率三道闸：低于门槛线不弹（background 算）、每天最多一次、跳过后
// 直到下个大版本抬高门槛线才再弹。绝大多数注入走到判定就静默退出。
//
// 样式取值对齐 toolbar/ui-tokens.js（那份挂在 page world，这里够不着，
// 只能抄值——改令牌时记得两处同步）。独立 shadow root，不受宿主页样式污染。
// ============================================================================

;(() => {
  const platformRef = typeof browser === 'undefined' ? chrome : browser

  if (window.__liaisonUpdateModalOpen) return

  const localDateStr = (d = new Date()) => {
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  const normalizeNotes = (notes) => {
    let list = []
    if (Array.isArray(notes)) list = notes
    else if (typeof notes === 'string') list = notes.split('\n')
    list = list.map((s) => String(s).trim()).filter(Boolean)
    return list.length ? list : ['本次带来功能更新与体验优化，建议升级到最新版本。']
  }

  // 纯判定，storage 快照 + 今天日期进、{show, reason} 出。reason 仅供调试：
  // SW/页面 console 里 window.__liaisonUpdateDecide(快照, '2026-01-01') 即可复演。
  const decide = (s, today) => {
    if (!s.liaisonUpdateAvailable) return { show: false, reason: 'no-update' }
    if (!s.liaisonUpdateModalEligible) return { show: false, reason: 'below-floor' }
    if (s.liaisonUpdateModalDismissedFloor &&
        s.liaisonUpdateModalDismissedFloor === s.liaisonUpdateNotifyFloor)
      return { show: false, reason: 'dismissed' }
    if (s.liaisonUpdateModalLastShownDate === today) return { show: false, reason: 'shown-today' }
    return { show: true, reason: 'show' }
  }
  window.__liaisonUpdateDecide = decide

  const run = async () => {
    let s
    try {
      s = await platformRef.storage.local.get([
        'liaisonUpdateAvailable', 'liaisonUpdateModalEligible', 'liaisonUpdateLatest',
        'liaisonUpdateNotifyFloor', 'liaisonUpdateNotes', 'liaisonUpdateDownloadUrl',
        'liaisonUpdateModalDismissedFloor', 'liaisonUpdateModalLastShownDate',
      ])
    } catch (_) { return }

    const today = localDateStr()
    if (!decide(s, today).show) return

    // 后台 tab 里不弹（会白吃掉当天一次的配额），等首次可见再判一遍
    if (document.visibilityState === 'hidden') {
      const onVisible = () => {
        if (document.visibilityState !== 'hidden') {
          document.removeEventListener('visibilitychange', onVisible)
          run()
        }
      }
      document.addEventListener('visibilitychange', onVisible)
      return
    }

    // 抢到展示资格：先写日期再弹，并发 tab 的第二个读到即跳过
    try { await platformRef.storage.local.set({ liaisonUpdateModalLastShownDate: today }) } catch (_) {}

    mount(s)
  }

  const mount = (s) => {
    window.__liaisonUpdateModalOpen = true

    // gist 内容是自家维护的，但拼进 innerHTML 的值仍一律过消毒
    const esc = (v) => String(v).replace(/[<>&"']/g, '')
    let current = ''
    try { current = platformRef.runtime.getManifest().version } catch (_) {}
    current = esc(current)
    const latest = esc(s.liaisonUpdateLatest || '')
    const notes = normalizeNotes(s.liaisonUpdateNotes)
    const downloadUrl = typeof s.liaisonUpdateDownloadUrl === 'string' &&
      /^https?:\/\//.test(s.liaisonUpdateDownloadUrl)
        ? s.liaisonUpdateDownloadUrl.replace(/["'<>\\]/g, encodeURIComponent) : null

    const host = document.createElement('liaison-update-modal')
    const root = host.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .overlay {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(0,0,0,.52);
        display: flex; align-items: center; justify-content: center;
        font: 400 12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
        color: rgba(255,255,255,.92);
        opacity: 0; transition: opacity .2s ease;
      }
      .overlay.in { opacity: 1; }
      .card {
        width: 400px; max-width: calc(100vw - 48px);
        background: #0F1B26;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 12px;
        box-shadow: 0 10px 34px rgba(0,0,0,.46);
        padding: 24px;
        position: relative;
        transform: translateY(8px) scale(.98);
        transition: transform .22s cubic-bezier(.2,.8,.3,1);
      }
      .overlay.in .card { transform: none; }
      .close {
        position: absolute; top: 12px; right: 12px;
        width: 24px; height: 24px; border: 0; border-radius: 6px;
        background: transparent; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        color: rgba(255,255,255,.42);
      }
      .close:hover { background: rgba(255,255,255,.06); color: rgba(255,255,255,.92); }
      .head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
      .head img { width: 36px; height: 36px; border-radius: 8px; display: block; }
      .title { font: 600 14px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; }
      .vers { margin-top: 2px; color: rgba(255,255,255,.62); font: 400 11px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; }
      .vers .new { color: #65FFB6; font-weight: 500; }
      .notes {
        list-style: none;
        background: rgba(255,255,255,.06);
        border-radius: 8px;
        padding: 12px 16px;
        margin-bottom: 16px;
        display: flex; flex-direction: column; gap: 8px;
      }
      .notes li { position: relative; padding-left: 14px; }
      .notes li::before {
        content: ''; position: absolute; left: 0; top: 7px;
        width: 5px; height: 5px; border-radius: 999px; background: #65FFB6;
      }
      .hint { color: rgba(255,255,255,.42); margin-bottom: 16px; }
      .actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
      .skip {
        border: 0; background: transparent; cursor: pointer;
        color: rgba(255,255,255,.42); border-radius: 6px; padding: 6px 10px;
        font: 400 12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
      }
      .skip:hover { color: rgba(255,255,255,.62); background: rgba(255,255,255,.06); }
      .go {
        display: inline-block; text-decoration: none; cursor: pointer;
        background: #65FFB6; color: #12151A;
        border: 0; border-radius: 6px; padding: 6px 16px;
        font: 500 12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
      }
      .go:hover { background: #7AFFC4; }
      .go:disabled { opacity: .6; cursor: default; }
      .result {
        margin-top: 12px; font: 400 11px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
        color: rgba(255,255,255,.62); text-align: right;
      }
      .result.err { color: #FF6B6B; }
      .result.ok { color: #65FFB6; }
    `
    root.appendChild(style)

    let iconUrl = ''
    try { iconUrl = platformRef.runtime.getURL('icons/icon48.png') } catch (_) {}

    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.innerHTML = `
      <div class="card" role="dialog" aria-label="妙想版本更新">
        <button class="close" type="button" aria-label="关闭">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        <div class="head">
          ${iconUrl ? `<img src="${iconUrl}" alt="">` : ''}
          <div>
            <div class="title">妙想有新版本</div>
            <div class="vers">v${current} → <span class="new">v${latest}</span></div>
          </div>
        </div>
        <ul class="notes"></ul>
        ${downloadUrl
          ? ''
          : '<div class="hint">请向工具分发者获取最新安装包。</div>'}
        <div class="actions">
          <button class="skip" type="button">跳过此版本</button>
          <button class="go" type="button" data-update>立即更新</button>
        </div>
        <div class="result"></div>
      </div>
    `
    // 图标加载失败（如 web_accessible_resources 未放行）就整个摘掉，不留裂图
    const iconImg = overlay.querySelector('.head img')
    if (iconImg) iconImg.addEventListener('error', () => iconImg.remove())

    const ul = overlay.querySelector('.notes')
    notes.forEach((t) => {
      const li = document.createElement('li')
      li.textContent = t
      ul.appendChild(li)
    })

    root.appendChild(overlay)
    ;(document.body || document.documentElement).appendChild(host)

    const close = () => {
      window.__liaisonUpdateModalOpen = false
      window.removeEventListener('keydown', onKey, true)
      overlay.classList.remove('in')
      setTimeout(() => host.remove(), 220)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }

    // X / Esc / 点遮罩 / 去更新 = 只今天不弹（日期已写）；
    // 「跳过此版本」= 记住当前门槛线，下个大版本抬线前不再弹
    overlay.querySelector('.close').addEventListener('click', close)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
    window.addEventListener('keydown', onKey, true)
    overlay.querySelector('.skip').addEventListener('click', () => {
      try {
        platformRef.storage.local.set({ liaisonUpdateModalDismissedFloor: s.liaisonUpdateNotifyFloor || '' })
      } catch (_) {}
      close()
    })
    // 「立即更新」：经 background 转发到本地桥执行更新程序。用户全程零手工，
    // 不需要知道 ~/.miaoxiang 存在，也不用记命令——这是自动更新之外的唯一自救入口。
    const go = overlay.querySelector('[data-update]')
    const result = overlay.querySelector('.result')
    if (go) go.addEventListener('click', () => {
      go.disabled = true
      go.textContent = '更新中…'
      result.className = 'result'
      result.textContent = '正在下载最新版本，可能需要一两分钟'
      const fail = (msg) => {
        go.disabled = false
        go.textContent = '重试'
        result.className = 'result err'
        result.textContent = msg
      }
      try {
        platformRef.runtime.sendMessage({ action: 'liaisonSelfUpdate' }, (r) => {
          if (platformRef.runtime.lastError) return fail('更新失败：' + platformRef.runtime.lastError.message)
          if (!r || !r.ok) return fail('更新失败：' + ((r && r.error) || '未知原因') + '。可联系分发者')
          go.textContent = '完成'
          result.className = 'result ok'
          result.textContent = '更新完成，重启 Chrome 后生效'
        })
      } catch (e) { fail('更新失败：' + String(e && e.message || e)) }
    })

    // 过渡起始态要先被绘制提交，强制 reflow 后再加 .in，否则动画不播
    void overlay.offsetHeight
    overlay.classList.add('in')
  }

  run()
})()
