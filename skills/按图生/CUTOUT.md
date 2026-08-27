# 抠图（cutout.py）环境与用法基线

`cutout.py` 双后端去背景输出透明 PNG。**默认后端 v6.5.0 起换为 BiRefNet-massive**（复用 Eagle「AI 自动抠图」插件的本地模型），质量大幅优于旧 u2net；rembg 保留为回退。

## 用法

```bash
python3 ~/.claude/skills/按图生/cutout.py <input.png> <output.png> [model]
python3 ~/.claude/skills/按图生/cutout.py --stop-server   # 释放常驻推理服务
```

- **`birefnet`（默认）**——Eagle 插件的 BiRefNet-massive 本地 HTTP 推理服务
- `u2net` / `isnet-general-use` 等——rembg 后端（skill `.venv`，离线护栏：本地无模型直接报错不联网下）

## 后端 1：BiRefNet 服务（默认）

**来源**：Eagle「AI 自动抠图」插件（v1.0.8）自带的 arm64 可执行 + 844MB `.pth` 权重：
`~/Library/Application Support/Eagle/Plugins/ai-background-remover/modules/background-remover/bin/BiRefNet-massive-epoch_240{,.pth}`

**机制**（不依赖打开 Eagle）：可执行是 pyinstaller 打包的 FastAPI 服务——
`<bin> start --port 54800 --model-dir <pth>`（`--pid` 可省略）；`GET /api/v1/ping`；
`POST /api/v1/predict` 收 `{"image": <纯base64>}` 返回 PNG 字节；`POST /api/v1/shutdown`。
cutout.py 自动：ping 54800 → 在则复用，不在则 detached 拉起（~5s 就绪）→ curl 发 predict。
服务**常驻内存**摊薄启动成本（批量场景每张只花推理时间）；不用时 `--stop-server` 释放。

**实测**（2026-07-12，2048px，CPU）：热路径 ~8s/张，冷启动全程 ~12s；边缘半透明残留比 u2net 少 ~30%，接触阴影去除干净。

**失效回退**：插件路径不存在 / 服务启动失败 → 自动回退 rembg u2net 并在 stderr 打警告。Eagle 插件升级可能改路径——失效时先核对上面的 bin 路径。

### ⚠️ localhost 代理劫持坑（实测踩过）

本机常年设着 `HTTP_PROXY`/`HTTPS_PROXY`（大写）——**urllib 大小写都认，会把 localhost 请求劫持到远程代理（502/连接重置）；curl 只认小写所以没事**。cutout.py 内所有 localhost 请求已显式禁代理（urllib 用空 `ProxyHandler`、curl 加 `--noproxy '*'`）。以后凡写访问本机服务的代码，一律显式禁代理。

## 后端 2：rembg 回退（.venv 被 gitignore，~700MB 不入库）

```bash
cd ~/.claude/skills/按图生
python3 -m venv .venv
.venv/bin/pip install -r requirements-cutout.txt
```

依赖锁定见 `requirements-cutout.txt`（Python 3.9.6 实测组合）。**pip 代理坑**：本机 pip 走代理 SSL 会被切断，大包必失败——用 curl 断点续传下 wheel 后 `.venv/bin/pip install ./xxx.whl` 离线装。模型缓存在 `~/.u2net/`。

## 在按图生工作流里的位置

抠图不在生成-评审闭环内——按 CLAUDE.md 全局并行协议使用：图片评审通过/挑完后，`Bash run_in_background` 起 cutout.py（热路径 ~8s），白嫖在下一张生成的 90s 里，不串行等待。抠完 trim 透明边再 `cp` 进项目。批量任务开始前可先跑一张把服务预热起来。
