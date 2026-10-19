# src/ — 代码

## 已经有的（M4，最初要的那个体验已经能跑）

```
src/
├─ main/
│  ├─ index.cjs            生命周期、单实例、IPC、取词编排、--smoke / --demo / --pickup-selftest
│  ├─ ball-window.cjs      窗口几何真值：球在哪、面板放哪、窗口多大、拖动、缩放、置顶、穿透
│  ├─ panel-window.cjs     **独立的面板窗口**（位置单独存，拖动只动它自己）
│  ├─ panel-geometry.cjs   几何纯函数（球窗尺寸 / 面板落点 / 夹取，可单测）
│  ├─ deepseek-window.cjs  网页后端窗口：persist 分区、记住会话地址、诊断状态
│  ├─ pickup.cjs           取词：剪贴板快照/还原 + 合成 Ctrl+C
│  ├─ sendinput-helper.ps1 常驻按键器（PowerShell 子进程，走 stdin 收命令）
│  ├─ hotkey.cjs           全局热键注册与「是否被占用」的报告
│  ├─ autostart.cjs        开机自启（默认关，只在打包版真正写启动项）
│  ├─ tray.cjs             托盘与菜单
│  └─ store.cjs            设置持久化（原子写 + BOM 容错 + 丢弃过期键）
├─ engine/
│  ├─ web-page.cjs         方案 A 页面代理：开页 → 等输入框 → 填字 → 等稳定 → 发送 → 收译文
│  ├─ page-scripts.cjs     注入页面的 DOM 脚本（选择器阶梯都在这里，改版只改这一处）
│  └─ stub.cjs             占位引擎（PET_TR_ENGINE=stub 时用，调 UI 不碰网络）
├─ preload/
│  └─ ball.cjs             窄 API（contextBridge，逐方法白名单）
└─ ui/
   ├─ index.html           球窗口（只有球）
   ├─ panel.html           面板窗口（翻译 + 设置两个视图）
   ├─ ball.css             两个窗口共用的样式，色值一律 var(--tr-*)
   └─ ball.js              拖动 / 缩放 / 右键 / 穿透 / 取词状态 / 面板渲染
```

## 还没写的

| 文件 | 归属 | 干什么 |
|---|---|---|
| `main/packaging` | M6 | electron-builder 打包、开机自启 |
| `engine/prompt.cjs` | M5 | 提示词抽出来单独维护（现在是 `web-page.cjs` 里的 `promptFor`） |
| `engine/web-api.cjs` + `pow.cjs` | M6 | 方案 B：私有接口 + 官方 wasm PoW（可选快车道） |

## 五条不许破的规矩

1. **`ui/` 里不许出现十六进制色值**，一律 `var(--tr-*)`。要改视觉只改 `assets/tokens.css`。
2. **`engine/` 之外不许出现 "DeepSeek" 字样**。球和面板不知道后端是谁，换后端不该改 UI。
3. **窗口几何只有一处真值**：`ball-window.cjs` 的 `state.circle`（球圆的屏幕坐标）。
   窗口位置、球的内偏移、面板放哪一侧，全部由它推导 —— 别再引入第二个坐标来源。
   改窗口相关的逻辑后，跑 `electron scripts/selftest.cjs`，那 13 条断言就是防回归的网。
4. **碰网页 DOM 之前先等它准备好**。M3 有两个 bug 都是同一个病根：页面 `loadURL` 完成
   ≠ 输入框挂好、≠ 历史渲染完。改动 `web-page.cjs` 时，任何「读页面」
   的地方都要先问一句：这时机凭什么确定它已经就绪？
5. **`clipboard` 的每个调用都必须有超时，且不许 `await` 返回值**。这个 Electron 构建里
   剪贴板是异步的（`readText()` 返回 Promise），而 `writeHTML()` 会让它进入半死状态、
   之后连读都不返回。写操作用「写完读回来验证」，不要等 Promise。
