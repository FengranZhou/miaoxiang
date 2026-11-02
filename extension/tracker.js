// ============================================================================
// 妙想 · 使用统计（飞书 v2 埋点，规范出自 chrome-pack-feishu skill）
// ----------------------------------------------------------------------------
// payload 13 字段与 feishu-tracker v2 同构：source=chrome / type=chrome-plugin /
// trigger=inline / session=浏览器会话 UUID / version=manifest.version。
// 身份由 options 页登记（chrome.storage.local.identity）；未登记时静默不发。
// 所有上报失败一律吞掉，绝不影响主功能。
//
// 事件表（名字起了不改，改名会断掉版本间对比）：
//   install       安装 / 更新（extra = reason）
//   start         唤起工具栏（不记录页面地址）
//   audit-done    AI 深度分析出结果（extra = 问题条数）
//   diverge       发散投递成功
//   collect       采集入库（快照数增加时，extra = 当前总数）
//   ref-imitate   线上库「模仿」下载参考图成功
//   checklist-copy / component-copy  见 toolbar/inject.js
//   register      身份登记（options.js 自己发）
//   feedback      用户反馈（extra = 反馈正文；未登记也发，见 feishuFeedback）
// ============================================================================
const FEISHU_WEBHOOK = 'https://yf2ljykclb.xfchat.iflytek.com/base/automation/webhook/event/Hj5SaSl8ZwzU8WhAuFuruP9szSg'
const FEISHU_ASSET = 'miaoxiang'
// 用户反馈单独落一张表「妙想用户反馈」（与上面的使用统计总表分开）。
// 表里的自动化只取 extra→问题描述、name→用户名、dept→部门、version→版本，
// 提交时间由表自动填；payload 仍发完整 13 字段，与统计同构。
const FEEDBACK_WEBHOOK = 'https://yf2ljykclb.xfchat.iflytek.com/base/automation/webhook/event/MqVRa6mWnwQL6xhFf2trMwlwz7d'

async function feishuSession() {
  try {
    const { feishu_session_id } = await chrome.storage.session.get(['feishu_session_id'])
    if (feishu_session_id) return feishu_session_id
    const id = crypto.randomUUID()
    await chrome.storage.session.set({ feishu_session_id: id })
    return id
  } catch (_) {
    return crypto.randomUUID()
  }
}

async function feishuPost(url, identity, event, extra) {
  const payload = JSON.stringify({
    user_id: identity.user_id || '',
    name: identity.name || '',
    dept: identity.dept || '',
    source: 'chrome',
    asset: FEISHU_ASSET,
    type: 'chrome-plugin',
    trigger: 'inline',
    session: await feishuSession(),
    user: '',
    host: (navigator.userAgent.match(/\(([^)]+)\)/) || [])[1] || 'chrome',
    extra: extra == null ? '' : String(extra),
    event: String(event == null ? '' : event),
    version: chrome.runtime.getManifest().version,
  })
  await fetch(url, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  })
}

export async function feishuTrack(event, extra) {
  try {
    const { identity } = await chrome.storage.local.get(['identity'])
    if (!identity || !identity.user_id) return
    await feishuPost(FEISHU_WEBHOOK, identity, event, extra)
  } catch (_) {}
}

// 用户反馈：和统计不同，未登记身份也照发（反馈本身有价值，姓名留空）。
// 返回是否发出。no-cors 拿不到响应状态，true 只代表请求到了网络层，
// 飞书侧是否收下要看表。
export async function feishuFeedback(text) {
  try {
    const { identity } = await chrome.storage.local.get(['identity'])
    await feishuPost(FEEDBACK_WEBHOOK, identity || {}, 'feedback', text)
    return true
  } catch (_) {
    return false
  }
}

// 安装 / 更新：上报 install；没登记身份时打开登记页。
// 已在用的同事走的是 reason=update，也要弹一次，否则他们永远不会有数据。
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  try {
    if (reason === 'install' || reason === 'update') {
      const { identity } = await chrome.storage.local.get(['identity'])
      if (!identity || !identity.user_id) chrome.runtime.openOptionsPage()
    }
  } catch (_) {}
  feishuTrack('install', reason)
})

// 源码内主动埋点桥（content script / 扩展页可发 {type:'feishu-track', event, extra}）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'feishu-track') {
    if (msg.event != null && msg.event !== '') feishuTrack(msg.event, msg.extra)
    else feishuTrack(msg.extra == null ? 'unknown' : msg.extra, '')
  }
  // 不 return true：不占用 sendResponse，不影响其它 listener
})
