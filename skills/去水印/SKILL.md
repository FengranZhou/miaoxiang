---
name: 去水印
description: 去除 AI 生成图（豆包等）右下角的"豆包AI生成"水印（橙色或白色半透明均可）。当用户说"去水印"、"去掉水印"、"把这个水印擦了"、"抹掉水印"、"remove watermark"并给出图片时触发。底层用 OpenCV，按背景类型（渐变/纹理/复杂结构）选 gradient/mirror/inpaint 算法。
---

# 去水印

去除 AI 生成图（豆包等）右下角的"豆包 AI 生成"水印（橙色或白色半透明）。底层用 OpenCV，按背景类型选不同算法。

---

## 触发方式

用户说"去掉水印" / "去水印" / "把这个水印擦了" + 给出图片路径。

---

## 执行流程

### Step 1: 看图判断背景类型

用 Read 工具读图，对水印所在区域的背景做分类：

| 背景类型 | 特征 | 算法 |
|---|---|---|
| **复杂结构** | 物体边缘、几何形状、多色块 | `inpaint`（TELEA 大半径 + 羽化） |
| **纹理/水彩** | 颗粒纹理、笔刷感、规律重复 | `mirror`（上方区域翻转粘贴） |
| **纯渐变** | 平滑过渡、无明显纹理 | `gradient`（上下边线性插值 + 噪声） |
| 拿不准 | — | `auto`（脚本根据梯度方差自动选） |

### Step 2: 执行脚本

OpenCV venv 已在固定目录 `~/.claude/skills/去水印/.venv/`（重启不丢；若不存在见下方「venv 准备」离线重建）。

```bash
~/.claude/skills/去水印/.venv/bin/python ~/.claude/skills/去水印/remove-watermark.py \
  <输入图> \
  --mode <auto|inpaint|mirror|gradient> \
  [--output <输出路径>]
```

**不要默认带 `--debug`**——它会在输入图同目录生成 `debug/` 文件夹（mask/before/after），污染用户桌面。仅当一次去除效果存疑、需要排查时才临时加，用完提醒用户删 `debug/`。

默认输出到同目录 `<原文件名>-去水印.png`。

### Step 3: 验证

Read 输出图，**裁剪水印原位置 ±60px 区域**，确认：
- 水印文字完全消失
- 边界无明显接缝、色块、ghosting

如果效果不行 → 换另一种 mode 重试。

### Step 4: 只保留最佳结果（强制收尾）

试多种 mode 对比时，会在用户目录产生多个候选输出（如 `-去水印-inpaint.png`、`-去水印-gradient.png` 等）。**交付前必须删掉所有非最佳的候选文件，桌面/原目录只留一个最终结果**——文件名收敛为默认的 `<原文件名>-去水印.png`（必要时把选中的最佳候选重命名/覆盖到这个名字）。

不要把"删哪个"留给用户决定，也不要交付后才反问"要不要删 xxx"——自己挑定最佳、自己清场。中间裁剪/调试产物一律走 scratchpad，不落用户目录。

---

## venv 准备（固定目录，重启不丢）

venv 已建在 `~/.claude/skills/去水印/.venv/`，wheel 离线包存在 `~/.claude/skills/去水印/.wheels/`。正常情况下**直接能用，无需任何安装**。

仅当 `.venv` 丢失（极少见，如手动删过）时，**离线重建**（不联网——本机 pip 走代理时 SSL 握手会被切断，联网装必失败）：

```bash
SKILL=~/.claude/skills/去水印
test -d "$SKILL/.venv" || (
  python3 -m venv "$SKILL/.venv" && \
  "$SKILL/.venv/bin/pip" install --no-index --no-deps "$SKILL"/.wheels/*.whl
)
"$SKILL/.venv/bin/python" -c "import cv2,numpy;print('OK',cv2.__version__)"
```

**若连 `.wheels/` 也没了**（需重新下 wheel）：本机 `pip install` 走代理会被 SSL 切断，必须用 `curl` 断点续传下载 wheel 再离线装：
1. 取直链：`curl -s https://pypi.org/pypi/<pkg>/json` 解析出 macosx arm64 的 `.whl` url（numpy 选 cp313、opencv-python-headless 选 cp37-abi3）
2. **断点续传到完整**：`curl -sL -C - --max-time 60 -o <真实whl文件名> <url>`，循环重试直到 `wc -c` 达到 `content-length`（代理会中途切断，单次下不全 → wheel 损坏报 `BadZipFile`，必须续传补满）
3. 文件名必须保留 PEP427 格式（`numpy-2.5.0-cp313-cp313-macosx_11_0_arm64.whl`），不能重命名成 `numpy.whl`
4. 离线装：`pip install --no-index --no-deps *.whl`

---

## 高级参数

- `--bbox x1,y1,x2,y2` — 跳过自动检测，手动指定水印位置（颜色阈值失败时用）
- `--zone x1,y1,x2,y2` — 限定搜索范围（默认右下 40%×40%）
- `--color-h 0,20` — 调整水印颜色 H 范围（白色水印、其他色水印时改这里）
- `--debug` — 输出 `debug/mask.png`、`before.png`、`after.png`

---

## 算法原理（debug 时回顾）

### inpaint
1. HSV 阈值得到水印精确像素 mask
2. 5×5 椭圆核轻度膨胀 1 次（覆盖反走样）
3. TELEA inpaint，半径 15（大半径柔化笔画痕迹）
4. 在 mask 外围 9×9 膨胀 2 次得到羽化带，对该带做高斯模糊混合

### mirror
1. 取水印 bbox 上方等高区域
2. 垂直翻转
3. 18px 边缘羽化 alpha 混合粘贴到水印位置

### gradient
1. 取水印 bbox 上下各 5px 条带的平均颜色
2. 垂直方向线性插值填充整个 bbox
3. 加入 σ=1.5 的高斯噪声打破"色卡"感

### auto
- 计算 bbox 上方区域的 Sobel 梯度标准差和上下颜色差
- 低梯度 + 大颜色差 → gradient
- 中梯度 + 颜色相近 → mirror
- 其他 → inpaint（默认稳定）

---

## 失败模式与对策

| 现象 | 原因 | 对策 |
|---|---|---|
| "未检测到水印" | 颜色不在橙色阈值内 | `--color-h` 改范围，或 `--bbox` 手动指定 |
| inpaint 后留下波纹 | 背景有规律纹理 | 换 `mirror` 模式 |
| mirror 后出现"接缝" | 上方源区域和水印区域结构差异大 | 换 `inpaint` 或 `gradient` |
| gradient 后出现"色块" | 背景不是纯渐变，有局部纹理 | 换 `inpaint` |
| 多个水印 | 一次处理一个 | 多次调用，每次 `--bbox` 指定一个 |

---

## 不做的事

- 不做去除带 alpha 通道的半透明水印（需要先解 alpha 反演，超出本 skill 范围）
- 不做大面积 Logo 水印（>15% 画面，inpaint 会失真，需要 AI 模型）
- 不做版权破坏（仅用于个人测试/AI 自己生成图的标签去除）
