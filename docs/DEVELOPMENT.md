# 开发与调试

面向改代码的人。只想用的话看 [README](../README.md)。

## 环境

- Node.js 20 或更高
- Electron 44（`devDependencies`，`npm install` 会装）

```powershell
npm install     # 约 100 MB，只装一次
npm start       # 等同 npx electron .
```

**`ELECTRON_RUN_AS_NODE` 会让程序静默退出。** 这个变量只要存在，哪怕值是 `"0"`，
Electron 也会按纯 Node 运行，不初始化 GUI。表现为双击后进程秒退、日志里什么都没有：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

## 目录

```
src/main/       主进程
  index.cjs           装配：窗口、热键、IPC、翻译编排
  ball-window.cjs     球窗口（位置真值是球圆的屏幕坐标，不是窗口坐标）
  panel-window.cjs    面板窗口（尺寸、拖动、右下角拉伸）
  panel-geometry.cjs  纯函数几何，不 import electron，可以直接跑断言
  pickup.cjs          取词：剪贴板快照 → 合成 Ctrl+C → 轮询 → 还原
  sendinput-helper.ps1 常驻 PowerShell，用 SendKeys 发 Ctrl+C
  hotkey.cjs          globalShortcut 封装
  deepseek-window.cjs 隐藏的 DeepSeek 网页窗口
  store.cjs           settings.json 读写
src/engine/    翻译后端（界面不知道后端是网页还是接口）
  web-page.cjs        编排：开页 → 填字 → 等稳定 → 发送 → 轮询 → 返回
  page-scripts.cjs    注入到远程页面的 DOM 脚本，网页改版只改这个文件
  stub.cjs            占位引擎，调 UI 时用
src/ui/        渲染进程（HTML/CSS/JS，不用框架）
src/preload/   ball.cjs / panel.cjs，两套窄接口
```

## 开发命令

| 命令 | 作用 |
|---|---|
| `npm start` | 正常启动，球在右下角 |
| `npm start -- --demo` | 四态轮播（待机 / 倾听 / 翻译中 / 出错） |
| `npm start -- --smoke` | 显示 1.5 秒 → 截图 → 打印事实快照 → 退出 |
| `npx electron scripts/selftest.cjs` | 几何与窗口断言 |
| `npx electron scripts/selftest-deepseek.cjs` | 网页后端连通性 |
| `npx electron scripts/probe-deepseek.cjs` | **网页改版时先跑这个**：报告输入框、发送键、消息节点还在不在 |
| `npx electron scripts/probe-deepseek.cjs --visible --wait-login` | 打开网页窗口等人登录，登录后自动探结构 |
| `npx electron scripts/probe-pickup.cjs` | 只跑取词、不开球窗口，把「取词坏了」和「窗口焦点问题」分开 |
| `powershell -ExecutionPolicy Bypass -File scripts/e2e-pickup.ps1` | 端到端取词自测：记事本全选 → 程序取词 → 翻译 |
| `$env:F="1.5"; npx electron scripts/probe-drag-dpi.cjs` | DPI 回归探针：连续 20 次拖动后，球与面板的宽高必须零漂移 |

`probe-deepseek.cjs` 里有 `app.setPath("userData", …\pet-translator-desktop)`，
目的是和 App 共用 `persist:deepseek` 分区，否则它看到的是一套没登录的新页面。

### 冒烟环境变量

用来产出验收截图和事实快照，可组合。

| 变量 | 作用 |
|---|---|
| `PET_TR_PANEL=1` | 截图前先展开面板 |
| `PET_TR_VIEW=settings` | 切到设置视图（需同时 `PET_TR_PANEL=1`） |
| `PET_TR_AUTOTYPE="要翻译的文字"` | 往输入框塞字并点「翻译」，走渲染进程真实点击路径 |
| `PET_TR_AUTOTYPE2="..."` | 紧接着再来一轮，验连续翻译不串台 |
| `PET_TR_WAIT_MS=25000` | 每轮等多久再截图（真引擎要给页面加载留时间） |
| `PET_TR_ENGINE=stub` | 换回占位引擎，不碰网络 |
| `PET_TR_ENGINE=error` | 占位引擎强制失败，看错误态 |
| `PET_TR_STATE=listening\|busy\|error` | 强制球的静态状态 |
| `PET_TR_ARMED=1` | 摆成「取词完成、等待确认」的样子 |
| `PET_TR_SHOT=<路径>` | 截图落到哪里，面板会落到同名的 `-panel.png` |
| `PET_TR_NO_GPU=1` | 透明窗口黑底时退回软件渲染 |

## 打包

```powershell
powershell -ExecutionPolicy Bypass -File scripts\pack.ps1
```

不需要 npm、不需要联网。做法是把 `dsh-pet-translator` 里的 Electron 运行时
复制过来、改名为 `翻译球.exe`、塞进 `resources/app`，再裁掉用不到的语言包
（只留 zh-CN / zh-TW / en-US / en-GB，368 MB → 322 MB）。产出 `dist\翻译球\`。

- `-KeepAllLocales`：保留全部语言包（+46 MB）
- `-ElectronDist <路径>`：指定 Electron 运行时来源

**`app.setPath("userData", …)` 不能动。** 它把打包版和开发版钉在同一套 profile 上，
换掉会让升级后丢失 DeepSeek 登录态和窗口位置。详见 `src/main/index.cjs:55` 的注释。

`package.json` 里也写了 electron-builder 配置，`npm run dist` 能出 portable / nsis 安装包，备用。

## 提交前

打包版和开发版的 profile 是同一个目录，同时跑会互相覆盖设置，也会互相抢锁。
截图或自测前先确认没有另一个实例在跑：

```powershell
Get-Process 翻译球 -ErrorAction SilentlyContinue
```

## 已知的坑

**DeepSeek 按钮没有 aria-label。** 发送键只能按结构判据找：`ds-button--primary` 加
`--circle`。附件键是 `--iconLabelPrimary`，不会误匹配。这条判据写在
`src/engine/page-scripts.cjs`，网页改版时最先坏的就是它。

**「是否还在生成」没有可靠信号。** 早期版本用按钮 tooltip 判断，结果恒为 false，
把回复截成一两个字，还让下一次发送点到了「停止」按钮。现在不用任何生成信号：
等消息条数稳定 2.4 秒，外加「回复短得离谱就报 `short-reply`」兜底。

**这个 Electron 构建的 clipboard 是异步的。** `clipboard.readText()` 返回 Promise，
`clipboard.write({…})` 是空操作，`writeHTML()` 会让剪贴板半死（之后连读都不返回）。
取词只能用 `clear()` + `writeText()`，还原也只能还原纯文本。

**`clipboard.availableFormats()` 是 Linux 专有**，Windows 上 undefined，别拿它判空。

**PowerShell 变量名不区分大小写。** `param($Exe)` 和局部 `$exe` 是同一个变量，
脚本里混用会得到莫名其妙的值（`e2e-pickup.ps1` 因此把参数改名 `-ExePath`）。

**`sendinput-helper.ps1` 必须存成 UTF-8 BOM。** PowerShell 5.1 否则按 GBK 读，
中文注释会把语法撑爆。

**不要用真实账号压测。** 连续几十次请求会触发服务端限流，冷却一百秒左右才恢复，
排查期间很容易把限流当成 bug。

**移动窗口只能用 `setBounds`，不能只用 `setPosition`。** 窗口宽 138 DIP 时，
200% 缩放是 276 物理像素、整除，看不出问题；125% 是 172.5，那半个像素被进位，
于是每调用一次 `setPosition`，Windows 就把窗口矩形重新算大 1 DIP。拖动是按帧调用的，
表现就是「按住鼠标球一直变大，松手就停」。`setBounds` 每次都带上 `width` / `height`，
能把被撑大的尺寸拉回请求值。回归探针：`scripts/probe-drag-dpi.cjs`，
用 `$env:F` 指定缩放因子跑，连续 20 次拖动后球与面板的宽度都必须零漂移。

**不要 `getPosition()` 读回来当输入。** 非整数缩放下系统回报的位置和请求值能差 1 DIP，
一旦回流就会被下一次拖动继承，越拖越偏。球和面板都各自记着 `state.origin`
（最后一次要求的位置），拖动拿它当原点，落盘也用它。

## 日志

`%APPDATA%\pet-translator-desktop\app.log`，超过 1 MB 轮转成 `app.log.1`。
一次翻译会记下走的哪条路径、等了几秒、每 2 秒的轮询状态（条数 / 文本长度 / 稳定计数）。
渲染进程的 console 也会转发进来，前缀 `[ball-renderer:*]` / `[panel-renderer:*]`。
