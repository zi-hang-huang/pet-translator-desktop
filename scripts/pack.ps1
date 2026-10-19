# 绿色打包：把 App 装进 Electron 运行时，产出一个可双击的文件夹。
#
#     powershell -ExecutionPolicy Bypass -File scripts/pack.ps1
#
# 为什么不走 electron-builder：
#   这台机器上没有 npm（Node 是精简运行时），而 electron-builder 还会从 GitHub
#   拉 winCodeSign / nsis，国内网络经常卡住。绿色打包不依赖网络，几十秒出结果，
#   而且产物能立刻双击验证 —— 对「先跑起来」这个目标更实在。
#   `package.json` 里的 build 段仍然留着，将来 `npm i` 之后可以用它出安装包。
#
# 产物结构（和 electron-builder 的 win-unpacked 一样）：
#
#     dist\翻译球\
#     ├─ 翻译球.exe              ← 改过名的 electron.exe
#     ├─ *.dll / *.pak / locales\  ← Electron 运行时
#     └─ resources\
#        └─ app\
#           ├─ package.json     ← main 指向 src/main/index.cjs
#           ├─ src\             ← 我们的代码
#           └─ assets\          ← 只带运行时要用的（tokens / tray / icon）

param(
  [string]$ElectronDist = "D:\document\FET\project_data\dsh\pet-translator\dsh-pet-translator\node_modules\electron\dist",
  [string]$OutDir = "",
  # 只保留中英文语言包：locales 里几十个 .pak 每个约 1MB，全留纯属浪费
  [switch]$KeepAllLocales = $false
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if ($OutDir -eq "") { $OutDir = Join-Path $root "dist\翻译球" }

if (-not (Test-Path $ElectronDist)) {
  throw "找不到 Electron 运行时：$ElectronDist（用 -ElectronDist 指定）"
}

Write-Host "[pack] 源: $ElectronDist"
Write-Host "[pack] 目标: $OutDir"

# ── 1. 清空目标 ─────────────────────────────────────────────────────────
if (Test-Path $OutDir) {
  Write-Host "[pack] 清理旧产物"
  Remove-Item -Recurse -Force $OutDir
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ── 2. 复制 Electron 运行时（排除默认应用） ─────────────────────────────
Write-Host "[pack] 复制 Electron 运行时…"
$robo = Start-Process robocopy -ArgumentList @(
  "`"$ElectronDist`"", "`"$OutDir`"", "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
  "/XF", "default_app.asar"
) -Wait -PassThru -NoNewWindow
# robocopy: 0-7 都算成功
if ($robo.ExitCode -ge 8) { throw "robocopy 失败，退出码 $($robo.ExitCode)" }

# 2b. 裁语言包
if (-not $KeepAllLocales) {
  $localeDir = Join-Path $OutDir "locales"
  if (Test-Path $localeDir) {
    $keep = @("zh-CN.pak", "zh-TW.pak", "en-US.pak", "en-GB.pak")
    $removed = 0
    Get-ChildItem $localeDir -Filter *.pak | Where-Object { $keep -notcontains $_.Name } | ForEach-Object {
      Remove-Item $_.FullName -Force
      $removed++
    }
    Write-Host "[pack] 裁掉 $removed 个语言包（保留 zh-CN/zh-TW/en-US/en-GB）"
  }
}

# ── 3. 装入我们的应用 ───────────────────────────────────────────────────
$appDir = Join-Path $OutDir "resources\app"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# package.json：去掉 devDependencies，把 main 指对
$manifest = Get-Content (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$productName = "翻译球"
$shipped = [ordered]@{
  name       = $manifest.name
  productName = $productName
  version    = $manifest.version
  description = $manifest.description
  main       = "src/main/index.cjs"
  private    = $true
}
$shipped | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $appDir "package.json") -Encoding UTF8

Write-Host "[pack] 复制 src…"
Copy-Item -Recurse -Force (Join-Path $root "src") (Join-Path $appDir "src")

# assets 只带运行时要用的：tokens.css（界面色值）、tray（托盘图标）、icon.ico（窗口图标）
Write-Host "[pack] 复制 assets（只带运行时需要的）…"
$assetsOut = Join-Path $appDir "assets"
New-Item -ItemType Directory -Force -Path (Join-Path $assetsOut "tray") | Out-Null
Copy-Item -Force (Join-Path $root "assets\tokens.css") $assetsOut
Copy-Item -Force (Join-Path $root "assets\icon.ico") $assetsOut
Copy-Item -Force (Join-Path $root "assets\tray\*.png") (Join-Path $assetsOut "tray")

# ── 4. 改名 + 图标 ─────────────────────────────────────────────────────
$exeName = "$productName.exe"
Rename-Item -Path (Join-Path $OutDir "electron.exe") -NewName $exeName
Write-Host "[pack] 可执行文件: $exeName"

# ── 5. 附一份简短说明 ──────────────────────────────────────────────────
$readme = @"
翻译球 —— 桌面翻译球（Windows 10 / 11，64 位）

【怎么启动】
解压后双击「翻译球.exe」。启动后右下角会出现一只小球，浮在所有窗口之上；
托盘里也有一个球图标（球被关掉了可以从托盘叫回来）。

【第一次用必须先登录 DeepSeek】
本程序没有自己的翻译服务，它用的是 DeepSeek 网页版 —— 用你自己的账号，走你自己的额度。
  1. 右键球（或点托盘）→「打开面板」
  2. 面板右上角齿轮 → 设置 →「打开 DeepSeek 窗口」
  3. 在那个窗口里扫码或手机号登录；登录一次之后就不用再登了
     （登录态存在你自己电脑的 %APPDATA%\pet-translator-desktop 里，不会跟着文件夹走）

【怎么用】
  · 在任意程序里选中文字 → 按 Ctrl+Alt+T → 球亮一下 → 出译文
  · 选中文字后点球，效果一样
  · 面板：右键球 →「打开面板」（左键只负责翻译，不开面板）
  · 面板里也能直接打字翻译，Ctrl+Enter
  · 拖球 = 挪球；拖面板标题栏 = 挪面板；两者互不影响，位置各自记住
  · 右键球 →「缩放」= 改球的大小（0.6x ~ 1.8x）
  · Esc = 关面板 / 取消正在进行的翻译
  · 拖面板右下角那个小三角 = 改面板大小（260×320 ~ 760×900 之间，也受屏幕大小限制）
    拖大时左上角钉住，往右下长；松手后记住，下次打开还是这个大小

【几个提示】
  · 第一次运行 Windows 可能提示「已保护你的电脑」—— 因为这个 exe 没有数字签名。
    点「更多信息」→「仍要运行」即可。
  · 连着快速翻很多次可能被 DeepSeek 限流（回复只有几个字），等十几秒再翻。
  · 开机自启默认关；打开之后如果要挪动或删除这个文件夹，请先把它关掉。
  · 出问题看日志：%APPDATA%\pet-translator-desktop\app.log

【卸载】
关掉程序 → 删除这个文件夹 → 再删 %APPDATA%\pet-translator-desktop（里面有设置和登录态）。

【说明】
本程序通过自动化操作 DeepSeek 网页版实现翻译，不是官方 API；
如果 DeepSeek 改了页面结构，可能需要更新版本才能继续用。
"@
Set-Content -Path (Join-Path $OutDir "使用说明.txt") -Value $readme -Encoding UTF8

# ── 6. 报告 ────────────────────────────────────────────────────────────
$size = [math]::Round(((Get-ChildItem $OutDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host ""
Write-Host "[pack] 完成：$OutDir"
Write-Host "[pack] 体积：$size MB"
Write-Host "[pack] 启动：$OutDir\$exeName"
