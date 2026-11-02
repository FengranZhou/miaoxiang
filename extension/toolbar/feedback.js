// ============================================================================
// 用户反馈弹窗（content script，isolated world）
// ----------------------------------------------------------------------------
// 入口：工具条「…」菜单 →「用户反馈」。bundle 里的菜单项只负责派发
// liaison-feedback-open（composed，穿出 closed shadow 冒到 document），
// 本文件在 document 上接住它并弹窗 —— DOM 事件跨世界共享，同 inject.js 的
// checklist-copy / component-copy 转发是一个路子。
//
// 提交：sendMessage({action:'liaisonFeedbackSubmit', text}) → background 的
// feishuFeedback()（tracker.js）→ 飞书 Webhook，event=feedback、extra=正文。
// 走 background 而不是这里直接 fetch：Webhook 地址和 13 字段拼装只在 tracker.js
// 一处维护，且不受宿主页 CSP 影响。
//
// 由 liaison.js 在首次唤起的注入链里 executeScript 进来；隔离世界随页面存活，
// 重复注入靠 __liaisonFeedbackReady 去重。弹窗挂在 body 上、不在 liaison-app
// 子树里，eject.js 负责清掉。
//
// 样式取值对齐 toolbar/ui-tokens.js（同 update-modal.js：那份在 page world，
// 这里够不着，只能抄值——改令牌时记得同步）。
// ============================================================================

;(() => {
  if (window.__liaisonFeedbackReady) return
  window.__liaisonFeedbackReady = true

  const platformRef = typeof browser === 'undefined' ? chrome : browser
  const MAX = 2000
  // 草稿留在内存里：误关弹窗不丢字，提交成功才清
  let draft = ''
  let host = null
  let closeCurrent = null

  const open = () => {
    if (host && host.isConnected) return
    // 弹窗开着时被 eject.js 直接摘掉了节点：先把上一次的键盘监听收掉
    if (closeCurrent) closeCurrent()

    // 弹窗前先退回浏览态：「调整」等模式会在捕获阶段吞掉页面点击（见 exit-to-browse.js）
    try {
      const sc = document.createElement('script')
      sc.src = platformRef.runtime.getURL('toolbar/exit-to-browse.js')
      sc.onload = sc.onerror = () => sc.remove()
      ;(document.head || document.documentElement).appendChild(sc)
    } catch (_) {}

    host = document.createElement('liaison-feedback-modal')
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
        width: 440px; max-width: calc(100vw - 48px);
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
      .title { font: 600 14px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; }
      .sub { margin: 4px 0 16px; color: rgba(255,255,255,.62); }
      textarea {
        display: block; width: 100%; height: 160px; resize: none;
        padding: 10px 12px;
        background: rgba(0,0,0,.24);
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 8px;
        color: rgba(255,255,255,.92);
        font: 400 12px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
        outline: none;
        transition: border-color .14s ease;
      }
      textarea::placeholder { color: rgba(255,255,255,.42); }
      textarea:focus { border-color: rgba(255,255,255,.22); }
      textarea:disabled { opacity: .6; }
      .count { margin-top: 6px; text-align: right; color: rgba(255,255,255,.42); font-size: 11px; }
      .actions { margin-top: 16px; display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
      .result { flex: 1; min-width: 0; font-size: 11px; color: rgba(255,255,255,.62); }
      .result.err { color: #FF6B6B; }
      .result.ok { color: #65FFB6; }
      .cancel {
        border: 0; background: transparent; cursor: pointer;
        color: rgba(255,255,255,.62); border-radius: 6px; padding: 6px 12px;
        font: 400 12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
      }
      .cancel:hover { color: rgba(255,255,255,.92); background: rgba(255,255,255,.06); }
      .submit {
        border: 0; border-radius: 6px; padding: 6px 16px; cursor: pointer;
        background: #65FFB6; color: #12151A;
        font: 500 12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
      }
      .submit:hover { background: #7AFFC4; }
      .submit:disabled { opacity: .4; cursor: default; background: #65FFB6; }
    `
    root.appendChild(style)

    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.innerHTML = `
      <div class="card" role="dialog" aria-label="用户反馈">
        <button class="close" type="button" aria-label="关闭">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        <div class="title">用户反馈</div>
        <div class="sub">遇到的问题、想要的功能，都可以写在这里</div>
        <textarea maxlength="${MAX}" placeholder="请描述你遇到的问题或建议"></textarea>
        <div class="count"></div>
        <div class="actions">
          <div class="result"></div>
          <button class="cancel" type="button">取消</button>
          <button class="submit" type="button">提交</button>
        </div>
      </div>
    `
    root.appendChild(overlay)
    ;(document.body || document.documentElement).appendChild(host)

    const ta = overlay.querySelector('textarea')
    const count = overlay.querySelector('.count')
    const submit = overlay.querySelector('.submit')
    const result = overlay.querySelector('.result')
    let sending = false

    const sync = () => {
      count.textContent = `${ta.value.length} / ${MAX}`
      submit.disabled = sending || !ta.value.trim()
    }
    ta.value = draft
    sync()
    ta.addEventListener('input', () => {
      draft = ta.value
      result.className = 'result'
      result.textContent = ''
      sync()
    })

    // 键盘隔离：bundle 的快捷键在 document 捕获阶段判「是否在输入框里」，
    // 靠 e.target.closest('textarea')，而 shadow 里的 textarea 冒到 document 时
    // target 已被重定向成宿主 —— 不拦的话打字会触发妙想快捷键。
    // window 捕获阶段早于 document，在这里截停；只 stopPropagation 不
    // preventDefault，字照常输入。
    const onKey = (e) => {
      const path = e.composedPath ? e.composedPath() : []
      if (!path.includes(host)) return
      e.stopImmediatePropagation()
      if (e.type !== 'keydown' || e.isComposing) return
      if (e.key === 'Escape') close()
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
    }
    const KEYS = ['keydown', 'keyup', 'keypress']
    KEYS.forEach((t) => window.addEventListener(t, onKey, true))

    const close = () => {
      if (!host) return
      KEYS.forEach((t) => window.removeEventListener(t, onKey, true))
      const h = host
      host = null
      overlay.classList.remove('in')
      closeCurrent = null
      setTimeout(() => h.remove(), 220)
    }
    closeCurrent = close

    const send = () => {
      const text = ta.value.trim()
      if (sending || !text) return
      sending = true
      ta.disabled = true
      submit.textContent = '提交中…'
      sync()
      result.className = 'result'
      result.textContent = ''
      const done = (ok, msg) => {
        sending = false
        ta.disabled = false
        submit.textContent = '提交'
        sync()
        result.className = ok ? 'result ok' : 'result err'
        result.textContent = msg
      }
      try {
        platformRef.runtime.sendMessage({ action: 'liaisonFeedbackSubmit', text }, (r) => {
          if (platformRef.runtime.lastError || !r || !r.ok) {
            return done(false, '提交失败，请检查网络后重试')
          }
          draft = ''
          ta.value = ''
          done(true, '已收到，感谢反馈')
          setTimeout(close, 1200)
        })
      } catch (_) {
        // 扩展重载后旧页面里的 runtime 会失联
        done(false, '提交失败，请刷新页面后重试')
      }
    }

    overlay.querySelector('.close').addEventListener('click', close)
    overlay.querySelector('.cancel').addEventListener('click', close)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
    submit.addEventListener('click', send)

    // 过渡起始态要先被绘制提交，强制 reflow 后再加 .in，否则动画不播
    void overlay.offsetHeight
    overlay.classList.add('in')
    ta.focus()
  }

  document.addEventListener('liaison-feedback-open', open)
})()
