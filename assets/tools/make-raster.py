#!/usr/bin/env python
"""翻译球 · 位图素材生成器

从 CSS 里的真值渲染托盘图标与矢量兜底 PNG（不依赖任何矢量库，纯 numpy + Pillow）。

    球体渐变   radial-gradient(circle at 32% 26%, #7cc4ff 0%, #3a8dff 45%, #1f5fd0 100%)
    顶部内高光 inset 0 6px 12px rgba(255,255,255,.35)
    底部内转折 inset 0 -6px 12px rgba(0,20,60,.35)

用法（在项目根目录）：
    python assets/tools/make-raster.py

输出：
    assets/tray/tray-16.png  tray-24.png  tray-32.png   托盘图标（简化眼）
    assets/ball-512.png                                 矢量兜底（真实眼几何）
    assets/icon.ico                                     应用图标（打包用，多尺寸）

为什么托盘图标要单独画：16px 下真实眼睛只有 2.5px，缩放后糊成一团。
托盘版把眼睛放大到 22% 边长，并去掉投影 —— 见 DESIGN.md §4。

为什么 icon.ico 要从一张 256 渲染出来再交给 Pillow 分尺寸：
Windows 会在标题栏（16）、任务栏（32）、桌面（48-256）各挑一档，
只有一张 256 的话，16 那档会糊。
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

# 渐变：光源 32% 26%，farthest-corner 半径
LIGHT = (0.32, 0.26)
STOPS = (
    (0.00, np.array([0x7C, 0xC4, 0xFF], dtype=np.float64)),
    (0.45, np.array([0x3A, 0x8D, 0xFF], dtype=np.float64)),
    (1.00, np.array([0x1F, 0x5F, 0xD0], dtype=np.float64)),
)
EYE_COLOR = np.array([0x0D, 0x1A, 0x33], dtype=np.float64)
UNDER_COLOR = np.array([0x00, 0x14, 0x3C], dtype=np.float64)

# 真实眼几何，来自插件：48.25/84.09, 59.71, 9.85 × 11.07（除以 128）
REAL_EYES = ((48.25 / 128, 59.71 / 128, 9.85 / 128, 11.07 / 128),
             (84.09 / 128, 59.71 / 128, 9.85 / 128, 11.07 / 128))

SUPERSAMPLE = 8


def gradient_radius() -> float:
    """farthest-corner：CSS 默认的径向渐变半径。"""
    corners = ((0, 0), (1, 0), (0, 1), (1, 1))
    return max(math.hypot(cx - LIGHT[0], cy - LIGHT[1]) for cx, cy in corners)


def render(size: int, *, tray: bool) -> Image.Image:
    big = size * SUPERSAMPLE
    ys, xs = np.mgrid[0:big, 0:big].astype(np.float64)
    x = (xs + 0.5) / big
    y = (ys + 0.5) / big

    # ── 主体渐变 ─────────────────────────────────────────────────────
    r = np.hypot(x - LIGHT[0], y - LIGHT[1]) / gradient_radius()
    r = np.clip(r, 0.0, 1.0)
    rgb = np.empty((big, big, 3), dtype=np.float64)
    for channel in range(3):
        rgb[..., channel] = np.interp(
            r, [s[0] for s in STOPS], [s[1][channel] for s in STOPS]
        )

    # ── 顶部内高光（白，向下 46/128 衰减干净） ───────────────────────
    sheen = np.clip(1.0 - y / (46 / 128), 0.0, 1.0)[..., None]
    rgb = rgb * (1 - 0.42 * sheen) + 255.0 * (0.42 * sheen)

    # ── 底部内转折 ──────────────────────────────────────────────────
    t = np.clip((y - 0.58) / 0.42, 0.0, 1.0)
    shade = (0.42 * t * t)[..., None]
    rgb = rgb * (1 - shade) + UNDER_COLOR * shade

    # ── 圆外透明 ────────────────────────────────────────────────────
    dist = np.hypot(x - 0.5, y - 0.5)
    inside = dist <= 0.5
    alpha = np.where(inside, 255.0, 0.0)

    # ── 眼睛 ────────────────────────────────────────────────────────
    if tray:
        # 简化：直径 22% 边长，位置 38% / 62%，比真实几何大，保证 16px 可辨
        eyes = ((0.38, 0.46, 0.11, 0.11), (0.62, 0.46, 0.11, 0.11))
    else:
        eyes = REAL_EYES
    for cx, cy, rx, ry in eyes:
        dot = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0
        dot &= inside
        rgb[dot] = EYE_COLOR

    out = np.dstack([rgb, alpha]).clip(0, 255).astype(np.uint8)
    image = Image.fromarray(out, mode="RGBA")
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    tray_dir = ROOT / "tray"
    tray_dir.mkdir(parents=True, exist_ok=True)
    for size in (16, 24, 32):
        path = tray_dir / f"tray-{size}.png"
        render(size, tray=True).save(path, optimize=True)
        print("wrote", path.relative_to(ROOT))

    fallback = ROOT / "ball-512.png"
    render(512, tray=False).save(fallback, optimize=True)
    print("wrote", fallback.relative_to(ROOT))

    # 应用图标：打包时 electron-builder 要 .ico，Windows 会按场景自己挑尺寸
    icon_base = render(256, tray=False)
    icon = ROOT / "icon.ico"
    icon_base.save(
        icon,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("wrote", icon.relative_to(ROOT))


if __name__ == "__main__":
    main()
