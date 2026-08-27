#!/usr/bin/env python3
"""
去除 AI 生成图（豆包等）右下角的橙色水印。

三种算法（按背景类型选择）:
  inpaint  — TELEA 大半径 + 高斯羽化（复杂结构背景，默认稳）
  mirror   — 上方区域垂直翻转粘贴 + 羽化（水彩/纹理背景）
  gradient — 上下边线性插值 + 噪声（纯渐变背景）
  auto     — 根据水印上方区域的梯度方差 + 颜色差自动选

用法:
  python remove-watermark.py <input> [--output OUT] [--mode auto|inpaint|mirror|gradient]
  python remove-watermark.py <input> --bbox x1,y1,x2,y2 --mode inpaint
  python remove-watermark.py <input> --color-h 0,20 --color-s-min 100  # 调阈值
"""

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np


def detect_orange_watermark(img, zone, h_range=(0, 20), s_min=100, v_min=80):
    """HSV 阈值定位橙色水印像素，返回 bbox + mask。"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    lower = np.array([h_range[0], s_min, v_min])
    upper = np.array([h_range[1], 255, 255])
    mask = cv2.inRange(hsv, lower, upper)

    z = np.zeros_like(mask)
    x1, y1, x2, y2 = zone
    z[y1:y2, x1:x2] = 255
    mask = cv2.bitwise_and(mask, z)

    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return None, None

    bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    return bbox, mask


def remove_inpaint(img, mask, radius=15):
    """TELEA 大半径修复 + 边界羽化。复杂背景默认。"""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask_d = cv2.dilate(mask, kernel, iterations=1)
    result = cv2.inpaint(img, mask_d, radius, cv2.INPAINT_TELEA)

    blur_zone = cv2.dilate(
        mask_d,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)),
        iterations=2,
    )
    blur_zone_f = cv2.GaussianBlur(blur_zone.astype(np.float32) / 255.0, (15, 15), 0)[..., None]
    blurred = cv2.GaussianBlur(result, (5, 5), 1.2)
    return (result * (1 - blur_zone_f) + blurred * blur_zone_f).astype(np.uint8)


def remove_mirror(img, bbox, source="above", pad=20, fade=18):
    """从上方/下方镜像粘贴 + 羽化。纹理背景。"""
    H, W = img.shape[:2]
    x1, y1, x2, y2 = bbox
    x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
    x2, y2 = min(W, x2 + pad), min(H, y2 + pad)
    h, w = y2 - y1, x2 - x1

    if source == "above":
        src_y1, src_y2 = max(0, y1 - h), y1
    else:
        src_y1, src_y2 = y2, min(H, y2 + h)

    patch = img[src_y1:src_y2, x1:x2]
    if patch.shape[0] == 0 or patch.shape[1] == 0:
        raise RuntimeError("mirror 源区域不足，换 inpaint 模式")
    patch = cv2.flip(patch, 0)
    patch = cv2.resize(patch, (w, h))

    alpha = np.ones((h, w), dtype=np.float32)
    fade = min(fade, h // 4, w // 4)
    for i in range(fade):
        f = i / fade
        alpha[i, :] *= f
        alpha[-(i + 1), :] *= f
        alpha[:, i] *= f
        alpha[:, -(i + 1)] *= f
    alpha = alpha[..., None]

    result = img.copy()
    result[y1:y2, x1:x2] = (patch * alpha + img[y1:y2, x1:x2] * (1 - alpha)).astype(np.uint8)
    return result


def remove_gradient(img, bbox, pad=10, band=5, noise_std=1.5):
    """上下边线性插值 + 高斯噪声。渐变背景。"""
    H, W = img.shape[:2]
    x1, y1, x2, y2 = bbox
    x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
    x2, y2 = min(W, x2 + pad), min(H, y2 + pad)
    h, w = y2 - y1, x2 - x1

    top_band = img[max(0, y1 - band):y1, x1:x2].mean(axis=0)
    bottom_band = img[y2:min(H, y2 + band), x1:x2].mean(axis=0)

    fill = np.zeros((h, w, 3), dtype=np.float32)
    for i in range(h):
        t = i / (h - 1) if h > 1 else 0
        fill[i] = top_band * (1 - t) + bottom_band * t

    noise = np.random.normal(0, noise_std, fill.shape)
    fill = np.clip(fill + noise, 0, 255)

    result = img.copy()
    result[y1:y2, x1:x2] = fill.astype(np.uint8)
    return result


def auto_select_mode(img, bbox, verbose=True):
    """根据水印上方区域的梯度方差和颜色差，选 inpaint / mirror / gradient。"""
    H, W = img.shape[:2]
    x1, y1, x2, y2 = bbox
    h = y2 - y1
    sample_y1 = max(0, y1 - max(40, h))
    sample_y2 = y1
    if sample_y2 - sample_y1 < 10 or x2 - x1 < 10:
        return "inpaint"

    sample = img[sample_y1:sample_y2, x1:x2]
    gray = cv2.cvtColor(sample, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1)
    grad_std = float(np.sqrt(gx ** 2 + gy ** 2).std())

    top_color = sample[:5].mean(axis=(0, 1))
    bot_color = sample[-5:].mean(axis=(0, 1))
    color_diff = float(np.linalg.norm(top_color - bot_color))

    if verbose:
        print(f"  [auto] grad_std={grad_std:.2f} color_diff={color_diff:.2f}")

    # 渐变背景：低梯度 + 明显的上下颜色差
    if grad_std < 8 and color_diff > 6:
        return "gradient"
    # 纹理背景：中等梯度 + 颜色差不大
    if 8 <= grad_std < 25 and color_diff < 10:
        return "mirror"
    # 其他：复杂背景默认 inpaint
    return "inpaint"


def main():
    parser = argparse.ArgumentParser(
        description="去除 AI 生成图右下角的橙色水印（豆包等）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("input", help="输入图片路径")
    parser.add_argument("--output", "-o", help="输出路径（默认: 同目录 + -去水印.png）")
    parser.add_argument(
        "--mode", "-m",
        choices=["auto", "inpaint", "mirror", "gradient"],
        default="auto",
    )
    parser.add_argument("--bbox", help="手动指定水印 bbox: x1,y1,x2,y2（跳过自动检测）")
    parser.add_argument("--zone", help="搜索水印的区域: x1,y1,x2,y2（默认右下 40%×40%）")
    parser.add_argument("--color-h", default="0,20", help="水印 HSV H 范围（默认 0,20 橙）")
    parser.add_argument("--color-s-min", type=int, default=100, help="水印 HSV S 最小值")
    parser.add_argument("--color-v-min", type=int, default=80, help="水印 HSV V 最小值")
    parser.add_argument("--debug", action="store_true", help="额外输出 mask 和裁剪对照")
    args = parser.parse_args()

    img = cv2.imread(args.input)
    if img is None:
        print(f"无法读取 {args.input}", file=sys.stderr)
        sys.exit(1)

    H, W = img.shape[:2]
    print(f"图片尺寸: {W}x{H}")

    if args.zone:
        zone = tuple(map(int, args.zone.split(",")))
    else:
        zone = (int(W * 0.6), int(H * 0.6), W, H)

    if args.bbox:
        bbox = tuple(map(int, args.bbox.split(",")))
        mask = np.zeros((H, W), dtype=np.uint8)
        mask[bbox[1]:bbox[3], bbox[0]:bbox[2]] = 255
        print(f"手动 bbox: {bbox}")
    else:
        h_range = tuple(map(int, args.color_h.split(",")))
        bbox, mask = detect_orange_watermark(
            img, zone,
            h_range=h_range,
            s_min=args.color_s_min,
            v_min=args.color_v_min,
        )
        if bbox is None:
            print("未检测到水印，检查 --zone / --color-h 参数", file=sys.stderr)
            sys.exit(2)
        print(f"检测到水印 bbox: x={bbox[0]}..{bbox[2]} y={bbox[1]}..{bbox[3]}")

    mode = args.mode
    if mode == "auto":
        mode = auto_select_mode(img, bbox)
        print(f"  → auto 选择: {mode}")

    if mode == "inpaint":
        result = remove_inpaint(img, mask)
    elif mode == "mirror":
        try:
            result = remove_mirror(img, bbox)
        except RuntimeError as e:
            print(f"  mirror 失败 ({e})，回退 inpaint")
            result = remove_inpaint(img, mask)
    elif mode == "gradient":
        result = remove_gradient(img, bbox)
    else:
        print(f"未知模式 {mode}", file=sys.stderr)
        sys.exit(3)

    if args.output:
        out_path = args.output
    else:
        p = Path(args.input)
        out_path = str(p.parent / f"{p.stem}-去水印.png")

    cv2.imwrite(out_path, result)
    print(f"输出: {out_path}")

    if args.debug:
        dbg = Path(out_path).parent / "debug"
        dbg.mkdir(exist_ok=True)
        cv2.imwrite(str(dbg / "mask.png"), mask)
        x1, y1, x2, y2 = bbox
        pad = 60
        c1 = img[max(0, y1 - pad):min(H, y2 + pad), max(0, x1 - pad):min(W, x2 + pad)]
        c2 = result[max(0, y1 - pad):min(H, y2 + pad), max(0, x1 - pad):min(W, x2 + pad)]
        cv2.imwrite(str(dbg / "before.png"), c1)
        cv2.imwrite(str(dbg / "after.png"), c2)
        print(f"  debug 输出: {dbg}/")


if __name__ == "__main__":
    main()
