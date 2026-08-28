# 参考元素复刻 — 历史案例库

> 本文件是 [`REFERENCE-REPLICATION.md`](./REFERENCE-REPLICATION.md) 的**案例附录**，从主文档拆出以给主文档瘦身。
>
> **定位**：主文档存"每次复刻都要遵守的判断性规则"（每次开工必读）；本文件存"翻车复盘案例"（**出错时回查**，不必每次读）。每条规则对应的教训根都能在这里找到详细现场。
>
> 主文档的规则若引用「见案例 #N」，就来这里查。

---

## 历史案例

### 案例 #1：尺寸脱节（2026-06-05）

**参考**：百度希岭「精编视频」卡片，220×192px

**线框图承诺**：
```
尺寸约 220×192（对齐参考比例）
← 顶部视觉区：高 ~108px（占总高 56%）
```

**实际代码**：
```css
.card {
  width: 100%;  /* ❌ 应该是 220px */
  max-width: 100%;
}
```

**根本问题**：写代码时没回头看线框图，凭印象觉得"响应式布局"更好，写了 100% 宽。

---

### 案例 #2：交互缺失（2026-06-05）

**参考**：百度希岭卡片，hover 时底部面板从下方滑入

**改动要点（正确）**：
- 底部面板（"16:9 / 9:16" 比例选项）
- Hover 效果...（但没明确写"从下方滑入"）

**实际代码（错误）**：
```css
.si-panel {
  /* ❌ 直接显示，没有 transform: translateY(100%) */
  background: rgba(255, 255, 255, 0.85);
  padding: 12px;
  /* 缺少 hover 滑入效果 */
}
```

**根本问题**：观察参考时只看了静态截图，没深入理解"底部面板"是 hover 态还是常驻；写代码时也没追问自己"这个面板什么时候显示？"

### 案例 #3：交互态漏采导致 hover 方向误判（2026-07-02）

**参考**：xy-fe-jx-web 任务团子页「排序」触发器，文字 hover 变品牌绿（`.xy_clickable:hover`）

**扩展采集（当时有盲区）**：交互态段只输出了一条无关的 `scrollbar-color`，真正的 hover 变绿规则挂在**孙子元素**（普通 `<span class="xy_clickable">`）上——旧版 `harvestDescendantInteractions` 只扫 `a/button/input/[role]/[tabindex]` 白名单，普通 span 被跳过。

**错误决策**：基于"交互态段为空"断定线上无 hover 效果，把目标改成了纯静态，用户看到后才纠偏。

**已做的根修**：2026-07-02 重写了 `harvestDescendantInteractions`（bundle.min.js，备份 `bak_descendant_interactions_20260702-111615`）——改为样式表驱动：扫页面 CSS 里所有 `X:hover/:focus/:active/:focus-visible` 规则，用 `querySelectorAll(X)` 在选中元素内部找命中节点，任何标签的子孙都不会再漏。

**残留纪律（防其他盲区）**：
- 交互态段为空或只有噪声规则时，**不要**直接断定"无交互"——对子孙元素中名字带交互暗示的 class（`clickable` / `btn` / `link` / `hover` 等）主动到项目里 grep `:hover` 规则
- 参考来自同产品线上环境时，优先在本地代码库里找同款组件的源码（本次真正的 ground truth 在 `DiscussPreview/style.less`，比采集数据更完整）

### 案例 #4：同库复刻三连漏——字形 / 间距 / 规则覆盖（2026-07-02）

**参考**：xy-fe-jx-web 讨论区 PointCard 帖子卡 → 目标：答疑区 QuestionCard 提问卡（**同一代码库**）

**三个漏点，同一根因（复刻粒度停在"大项"，未做子元素 Diff）**：

1. **图标字形没复刻**：参考 HTML 明确写着 `anticon-eye/like/message`，却把目标的 iconfont 图标当"业务自带"默认保留
2. **间距没复刻**：沿用了目标旧文件的 16px 项间距，参考实际是 12px
3. **规则覆盖看漏**：读参考 less 只取了第一条命中的 `margin-right: 8px`，没发现同文件 `.meta:nth-child(2) span:not(:last-child)` 的 12px 覆盖规则——源码读值不等于最终生效值

**另有一处沟通失误**：用户歧义回答被按字面解析执行，见 Checklist 第 4 条。

**教训对应的新增防线**：同库参考复用通道（主文档）+ Diff 表纪律（Checklist 第 0 条）+ 复述确认协议（Checklist 第 4 条）。

**采集端已根治（2026-07-27，v1.9.0）**：扩展新增 CDP「样式来源溯源」采集（`CSS.getMatchedStylesForNode`）——采集件的「## 参考元素 样式来源溯源」段会直接列出发生了层叠覆盖的关键属性：**最终生效值 + 赢家选择器 + 被谁覆盖**。「读第一条命中规则」「读通用 h1-h6 / 浏览器默认」这类翻车，现在采集件就把最终生效值标出来了，不需要复刻方再手动追层叠链。见案例 #6 的 CDP 升级段。

---

### 案例 #5：采集端抓错层导致字号偏小 —— 扩展 bundle 深度/宽度优化（2026-07-15）

**现象**：复刻 el-tree 章节树时，采集件报一级标题 `font-size: 14px`，但放大截图证明真实是 **16px / 600 字重**。照采集件把字号调小，翻车。

**根因（在采集端，不在复刻端）**：`toolbar/bundle.min.js` 的 `captureOneNode` 写死 `depth<2`，只抓「直接子 + 孙子」两层。el-tree 的文字节点 `DIV.label`（16px）藏在第 4~5 层，**从没被采集**，容器层的 14px 被当成了文字字号上报。这类"文字节点比容器深好几层"的组件（element-plus / antd 深层封装）都会踩。

**修复（分三轮，改 bundle.min.js）**：
1. 深度 `depth<2` → `depth<4`，够到 `容器 > content > label > p` 这种嵌套
2. **文字节点智能下钻**：到深度顶后，仍强制抓"纯文字标签（p/span/a/label/h1-6）且字号与父级不同"的子节点，兜住极深文字
3. **全局限流**：`getCS`（getComputedStyle，强制同步重排）预算 800 封顶，超了停挖 —— 防止大树递归时上千次 `getCS` 卡死浏览器（曾因下钻对每个节点无脑跑 `getCS` 卡死过一次）
4. 宽度 `Math.min(...,4)` → `6`，让一级下面 5~6 个资源节点采全（之前卡在 4 个）

**关键认知：采集深度"够用就好"，不是越大越好。** 深度×宽度是指数级，过深会 ① prompt 体积爆炸淹没关键信息 ② getCS 暴涨卡死 ③ 挖到的全是叶子噪音（svg path / 图标内部）。`depth<4 + 宽度6 + 预算800` 是"够到所有设计相关信息、又不爆量"的平衡点。

**教训对应的新增防线**：采集件的 computed style **数值不可尽信**——遇到深层封装组件，以放大截图为 ground truth 交叉校验字号/颜色；采集端已优化，但复刻前仍应对关键字号做一次截图核对。

---

### 案例 #6：跨域 hover 规则漏采导致 overlay 遮罩误判（2026-07-27）

**参考**：hogee.baidu.com 数字人「功能入口卡」，hover 时 overlay 淡入并**盖住**底层「图标 + 标题」，只露「描述 + 箭头」。

**现象**：复刻件把 overlay 底色照采集数据写成 `rgba(247,249,252,0.35)`（35% 透明），hover 后底层图标+标题透出来，两层文字糊在一起。

**根因（在采集端，和案例 #3 同类但不同盲区）**：参考站的 hover 效果是**双层机制**——overlay 淡入（`opacity:0→1`）+ 底层默认区**同步隐藏**（`.card:hover .content{opacity:0}` 这种「父态驱动子元素」规则）。但：
1. 扩展的 `harvest{InteractionStyles,HoverDescendants}` 靠遍历 `document.styleSheets` 读 `.cssRules` 提取 `:hover` 规则；
2. 参考站 CSS 是**跨域外链**（CDN `.css`），JS 读跨域 `.cssRules` 抛 `SecurityError` 被 catch **静默跳过** → hover 规则一条都没采到；
3. `getComputedStyle` 不受跨域限制，所以**默认态**样式齐全，唯独伪类**规则**缺失——采集件只给了 overlay 的 `opacity:0`（默认态）+ 35% 透明底，没给「hover 时底层同步消失」那条联动规则。

复刻方只看到「overlay 半透明 + opacity:0」，想当然认为「淡入这个半透明层就够了」，漏掉了配套的「底层也得同步隐藏」。

**已做的根修（2026-07-27，v1.7.0）**：方案 A′「background fetch CSS 文本兜底」——
- `liaison.js` 新增 `liaisonFetchCss` handler，background 用扩展 host 权限 `fetch` 跨域 CSS URL 回纯文本（绕开页面 CORS，不需要 debugger/CDP 权限）；
- `bundle.min.js` 新增 `enrichInteractionsViaFetch(snap,el)`：枚举读不到 `cssRules` 的跨域样式表 → fetch 文本 → 轻量解析器提取 `:hover/:focus/:active` 规则 → `el.matches`/`querySelectorAll` 对位 → 按原字段结构合并进 snap，不覆盖同源已采结果；
- `manifest.json` 加 `host_permissions: <all_urls>`。
- 已知限制：`@media` 内嵌的 hover 规则暂不解析，顶层 hover 规则（绝大多数联动动效所在）全覆盖。

**升级：CDP 通用解（2026-07-27，v1.8.0）——这才是彻底解，v1.7.0 fetch 方案降为第一层兜底。**

v1.7.0 的 fetch 方案只解决了「纯 CSS `:hover` + 规则在跨域外链表里」这一类。实测本案例这张卡的 hover 规则**根本不在 fetch 到的那个 CSS 里**（856KB CSS 扫出 723 条 hover 规则，无一匹配这张卡），fetch 方案对它无效。经 4 轮浏览器诊断确认根因：

- hover 效果 = 后代 `.overlay` 的 `opacity: 0→1`，是**纯 CSS `:hover` 驱动**的 transition；
- **JS `dispatchEvent(mouseenter/mouseover)` 触发不了 CSS `:hover`**（实测 force 全套 mouse/pointer 事件后 opacity 30 帧全是 0）——这是关键教训：CSS `:hover` 只认真实鼠标或 CDP，JS 事件无效；
- 默认态 `getComputedStyle` 读不到 hover 值，跨域 `cssRules` 读不到规则文本。

**唯一通用解 = CDP `CSS.forcePseudoState` 强制 `:hover` 伪类 + computed diff**。它对**任何实现方式**的 hover 都生效（CSS `:hover` / JS / CSS-in-JS / 跨域 / @media），因为读的是「强制 hover 后的真实计算值」，不关心实现方式。落地（4 文件）：
- `manifest.json` 加 `debugger` 权限（采集时弹「已开始调试此浏览器」黄条，用户已接受）；
- `liaison.js` 新增可复用 CDP 基础设施 `withCdpSession(tabId, worker)`（attach → DOM/CSS enable → work → `finally` 无条件 detach + 清 pseudo）+ `collectHover`（force `:hover` → **等 450ms 让 transition 跑完再读终态** → 与默认态 diff）+ `collectViaCdp` 能力分发 + `liaisonCdpCollect` handler（8s 超时 + 二次幂等 detach）；
- `inject.js` 桥加通用 `cdpCollect` action（payload 带 `capabilities` 列表，能力无关）；
- `bundle.min.js` 新增 `enrichHoverViaCDP`，在 fetch 方案之后 await，结果合并进 `snap.interactions`（不覆盖 fetch 已采）。
- **可复用地基**：`withCdpSession` + `cdpCollect` capabilities 设计成一次 attach 多能力的通用形态。后续把「样式来源溯源 `getMatchedStylesForNode`（治历史坑：读源码值≠最终生效值）/ 伪元素规则 / 真实字体 / 盒模型 / @media 当前生效规则」搬上 CDP，只在 `collectViaCdp` 加一个采集单元，**不动桥、不动权限、不重新 attach**。
- 已验证：采到干净终态 `overlay opacity:1`、`p transform:matrix(1,0,0,1,0,0)`、`arrow transform:matrix(1,0,0,1,0,0)`。

**残留纪律（防采集仍有盲区）**：
- 参考含 hover / 展开等动态行为时，**别只看采集件的「交互态」段就下结论**——尤其参考来自跨域外站（非 localhost / 同域）时，hover 联动规则可能因跨域 / @media 漏采。存疑时到浏览器 devtools 手动 hover 一次、看 overlay 是否**完全遮住**底层，或在 Styles 面板搜 `:hover` 确认。
- 看到 overlay / 蒙层类元素的默认态是 `opacity:0` + **半透明**底色时，警觉一下：它是「靠自身实心底遮住底层」还是「靠底层同步隐藏」？半透明底 + 没看到底层隐藏规则 = **大概率漏采了联动规则**，不是「只淡入半透明层就行」。

---
