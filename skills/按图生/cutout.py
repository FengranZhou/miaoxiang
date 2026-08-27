#!/usr/bin/env python3
"""Usage: cutout.py <input.png> <output.png> [model]
       cutout.py --stop-server

Removes the background and writes a transparent PNG.

model:
  birefnet (默认)      — Eagle「AI 自动抠图」插件自带的 BiRefNet-massive 本地推理服务
                         （端口 54800 常驻复用，首次自动拉起 ~6s，之后每张 ~8s；无需 venv）
  u2net / isnet-general-use / birefnet-general 等 — rembg 后端（skill .venv，离线护栏）

后端 1（BiRefNet 服务）说明：
  复用 Eagle 插件的 arm64 可执行 + .pth 权重（~/Library/Application Support/Eagle/
  Plugins/ai-background-remover/...），本脚本自己 spawn 常驻 HTTP 服务，不依赖打开
  Eagle。服务留驻内存供批量复用；用 `cutout.py --stop-server` 释放。
  大 body 用 curl 发（urllib 对 ~2.7MB base64 偶发 connection reset）。
  插件缺失 / 服务失败 → 自动回退 rembg u2net 并打印警告。

后端 2（rembg）自举：rembg 装在本 skill 自带的 .venv 里。若当前解释器导不到
rembg，就用 skill .venv 的 python 子进程重跑自己（显式传 rembg 模型名防循环）。
离线护栏：本地没有该模型 .onnx 就报错提示，绝不静默联网下载几百 MB。
"""
import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent
PORT = 54800
SERVER_LOG = "/tmp/birefnet-server.log"
PLUGIN_BIN = (
    Path.home()
    / "Library/Application Support/Eagle/Plugins/ai-background-remover/modules/background-remover/bin"
)
PROGRAM = PLUGIN_BIN / "BiRefNet-massive-epoch_240"
WEIGHTS = PLUGIN_BIN / "BiRefNet-massive-epoch_240.pth"


def ping(port: int, timeout: float = 2) -> bool:
    import urllib.request

    # ⚠️ 必须绕过代理：本机 HTTP_PROXY 环境变量会把 localhost 请求劫持到远程
    # 代理（502）。urllib 大小写 proxy 变量都认，curl 只认小写——这就是"curl 通、
    # urllib 不通"的根因。所有 localhost 请求一律显式禁代理。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        return (
            opener.open(f"http://localhost:{port}/api/v1/ping", timeout=timeout).status
            == 200
        )
    except Exception:
        return False


def stop_server() -> None:
    subprocess.run(
        ["curl", "-s", "--noproxy", "*", "-X", "POST", f"http://localhost:{PORT}/api/v1/shutdown"],
        capture_output=True,
        timeout=10,
    )
    print(f"已发送 shutdown 到 localhost:{PORT}")


def ensure_server() -> bool:
    """确保 BiRefNet 服务可用；返回 False = 插件不存在或启动失败。"""
    if ping(PORT):
        return True
    if not (PROGRAM.exists() and WEIGHTS.exists()):
        return False
    # detached 常驻：脚本退出后服务留驻，批量抠图摊薄 ~6s 启动成本
    subprocess.Popen(
        [str(PROGRAM), "start", "--port", str(PORT), "--model-dir", str(WEIGHTS)],
        stdout=open(SERVER_LOG, "a"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(60):
        time.sleep(1)
        if ping(PORT):
            return True
    return False


def birefnet_cutout(src: Path, dst: Path) -> bool:
    payload = json.dumps(
        {"image": base64.b64encode(src.read_bytes()).decode()}
    ).encode()
    for attempt in range(2):  # 冷启动后首个大请求偶发 reset，重试 1 次
        r = subprocess.run(
            [
                "curl", "-s", "--noproxy", "*", "-o", str(dst), "-w", "%{http_code}",
                "-X", "POST", "-H", "Content-Type: application/json",
                "--data-binary", "@-", "--max-time", "300",
                f"http://localhost:{PORT}/api/v1/predict",
            ],
            input=payload,
            capture_output=True,
        )
        ok = (
            r.stdout.decode().strip() == "200"
            and dst.exists()
            and dst.stat().st_size > 8
            and dst.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
        )
        if ok:
            return True
        time.sleep(2)
    return False


def rembg_cutout(src: Path, dst: Path, model: str) -> None:
    try:
        import rembg  # noqa: F401
    except ModuleNotFoundError:
        _py = SKILL_DIR / ".venv" / "bin" / "python"
        if _py.exists() and Path(sys.executable).resolve() != _py.resolve():
            # 子进程重入：显式传 rembg 模型名（≠birefnet），不会再走服务分支
            os.execv(str(_py), [str(_py), __file__, str(src), str(dst), model])
        raise SystemExit(
            "rembg 不可用，且 skill .venv 缺失。重建方法见 CUTOUT.md。"
        )

    from rembg import remove, new_session
    from PIL import Image

    # 离线护栏：只用本地已缓存的模型，绝不自动联网下载
    _model_dir = Path(os.environ.get("U2NET_HOME", Path.home() / ".u2net"))
    if not (_model_dir / f"{model}.onnx").exists():
        _have = sorted(p.stem for p in _model_dir.glob("*.onnx"))
        raise SystemExit(
            f"模型 '{model}' 不在本地（{_model_dir}），本脚本不会自动联网下载。\n"
            f"本地已有模型：{_have or '（无）'}。\n"
            f"→ 直接用本地模型：cutout.py <in> <out> {(_have[0] if _have else 'u2net')}\n"
            f"→ 或确实要下新模型：手动运行 "
            f"`.venv/bin/python -c \"from rembg import new_session; new_session('{model}')\"`"
        )

    session = new_session(model)
    with Image.open(src) as img:
        remove(img, session=session).save(dst)


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--stop-server":
        stop_server()
        return
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)

    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    model = sys.argv[3] if len(sys.argv) > 3 else "birefnet"
    if not src.exists():
        raise SystemExit(f"input not found: {src}")

    if model == "birefnet":
        if ensure_server() and birefnet_cutout(src, dst):
            print(f"saved {dst} ({dst.stat().st_size} bytes, backend=birefnet-eagle)")
            return
        print(
            "warning: BiRefNet 服务不可用（Eagle 插件缺失或启动失败，详见 "
            f"{SERVER_LOG}），回退 rembg u2net",
            file=sys.stderr,
        )
        model = "u2net"

    rembg_cutout(src, dst, model)
    print(f"saved {dst} ({dst.stat().st_size} bytes, backend=rembg/{model})")


if __name__ == "__main__":
    main()
