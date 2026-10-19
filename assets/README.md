# 素材清单

这一目录是「翻译球 · 桌面独立版」的全部视觉素材。**数值全部来自前身插件的源码**，
不是重新设计——目的是让新程序和已完成的插件看起来是同一个东西。

打开 `preview.html` 可以一眼看全（浏览器直接双击，无需构建）。

---

## 1. 文件表

| 文件 | 类型 | 规格 | 用途 | 是否随程序发布 |
|---|---|---|---|---|
| `tokens.css` | CSS 变量 | `--tr-*` 共 70 项 | 颜色/尺寸/动效的唯一来源，业务 CSS 只准用 var() | ✅ |
| `ball.svg` | 矢量 | 128×128 viewBox | **球体主素材**，运行时会用到 | ✅ |
| `ball-512.png` | 位图 | 512×512 RGBA | 矢量兜底（README/商店截图/不支持 SVG 的场景） | 可选 |
| `ball-states.svg` | 矢量 | 720×268 | 四态规范图（待机/倾听/翻译中/出错） | ❌ 规范图 |
| `panel-wireframe.svg` | 矢量 | 760×580 | 面板结构 + 尺寸标注 | ❌ 规范图 |
| `icons/gear.svg` | 矢量 | 16×16 | 设置 | ✅ |
| `icons/close.svg` | 矢量 | 16×16 | 关闭面板 | ✅ |
| `icons/back.svg` | 矢量 | 16×16 | 设置 → 翻译 | ✅ |
| `icons/copy.svg` | 矢量 | 16×16 | 复制译文 | ✅ |
| `icons/speaker.svg` | 矢量 | 16×16 | 朗读 | ✅ |
| `icons/pin.svg` | 矢量 | 16×16 | 常驻置顶 | ✅ |
| `icons/swap.svg` | 矢量 | 16×16 | 中英互换 | ✅ |
| `tray/tray-16.png` | 位图 | 16×16 | 托盘（100% 缩放） | ✅ |
| `tray/tray-24.png` | 位图 | 24×24 | 托盘（150%） | ✅ |
| `tray/tray-32.png` | 位图 | 32×32 | 托盘（200%） | ✅ |
| `preview.html` | HTML | — | 素材总览 / 视觉验收页 | ❌ |
| `preview/asset-sheet.png` | 位图 | 1280×1950 | 总览页快照（评审用） | ❌ |
| `tools/make-raster.py` | Python | — | 重新生成托盘图标与 ball-512 | ❌ 构建工具 |

---

## 2. 数值从哪来（可逐条核对）

| 素材里的值 | 来源 |
|---|---|
| 渐变 `#7cc4ff / #3a8dff / #1f5fd0`，圆心 `32% 26%` | `../dsh-pet-translator/lib/client.js` → `CSS` 块 `.…-ball` 的 `background` |
| 三层 box-shadow | 同上 `.…-ball` 的 `box-shadow` |
| 眼睛 `15.4% × 17.3%`、`top 38%`、`left 30% / 58%`、`#0d1a33` | 同上 `.…-eye`（`8px/52px`、`9px/52px`） |
| 呼吸 4.2s、眨眼 5.6s、转圈 1.1s、脉冲 520ms | 同上 `@keyframes` |
| 出错红眼 `#7a1d1d` | `../dsh-pet-translator/desktop/ui/style.css` `.ball.angry .eye` |
| 面板 340 宽 / 圆角 14 / `rgba(22,26,34,.97)` | 同上 `CSS` 块 `.…-panel` |
| 原文块 / 译文块底色与文字色 | 同上 `.…-src` `.…-out` |
| 按钮渐变 `#4c9bff → #2f7ae0` | 同上 `.…-go` |

**没有改过的值**：以上全部原样搬运。**唯一新增的**是四个通路状态灯颜色（`--tr-status-*`），
因为网页版后端会掉登录，这是新产品才有的状态，插件没有对应物。

---

## 3. 怎么用

### 球（渲染层）

`ball.svg` 是「静态外观」。真实动效由 DOM 驱动（眼睛要单独眨眼），所以产品里推荐：

```html
<button class="ball listening">
  <span class="ring"></span>
  <span class="eyes"><span class="eye l"></span><span class="eye r"></span></span>
</button>
```

```css
@import "assets/tokens.css";
.ball {
  width: 96px; height: 96px; border: 0; padding: 0; border-radius: 50%;
  background: var(--tr-ball-gradient);
  box-shadow: var(--tr-ball-lift);
  animation: breathe var(--tr-breathe-duration) var(--tr-ease-in-out) infinite;
}
.eye {
  position: absolute; top: var(--tr-eye-top);
  width: var(--tr-eye-width); height: var(--tr-eye-height);
  border-radius: 50%; background: var(--tr-eye-color);
}
.eye.l { left: var(--tr-eye-left); }
.eye.r { left: var(--tr-eye-right); }
```

只在**静态场景**（关于页、安装包图标、README）才用 `ball.svg` / `ball-512.png`。

### 托盘

```js
const { nativeImage } = require("electron");
const tray = new Tray(nativeImage.createFromPath("assets/tray/tray-32.png"));
```

Windows 会按 DPI 自动挑合适的位图；三个尺寸都给，别只给 32（16px 缩下来会糊）。

### 图标

内联进 HTML 才能继承 `currentColor`：

```html
<span class="icon"><!-- assets/icons/gear.svg 的内容 --></span>
```

### 重新生成位图

```powershell
# 改了渐变或几何之后，重跑一次
python assets/tools/make-raster.py
```

依赖仅 `numpy` + `Pillow`（DSH 运行时自带）。脚本里 `SUPERSAMPLE = 8` 表示先 8 倍渲染再 Lanczos 缩小——
16px 图标不能用浏览器截图代替，边缘会脏。

---

## 4. 已知取舍

1. **托盘图标是简化眼**：真实几何在 16px 下只有 2.5px，缩放后是一团。
   托盘版把眼睛放大到边长的 22%，并去掉投影（详见 `../DESIGN.md` §4）。
2. **外投影没烘焙进 `ball.svg`**：它要跟随 hover / 拖拽变化，交给 CSS 的 `--tr-ball-lift`。
   需要「一张图贴上去就能用」的场合请用 `ball-512.png`（同样没有投影）或自行加。
3. **只做暗色**：桌面浮层压在浅色系统上也用暗面板，避免背景噪点透上来。浅色令牌位已预留。
4. **`ball-states.svg` 与 `panel-wireframe.svg` 是规范图**，带文字标注，不要打进发布包。
5. **`prefers-reduced-motion` 已处理**：`tokens.css` 里把四类动效时长归零，系统开了「减少动画」就自动静止。
