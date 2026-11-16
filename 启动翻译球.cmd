@echo off
chcp 65001 >nul
rem ── 翻译球 · 开发版一键启动 ─────────────────────────────────────
rem 双击即可。用本工程 node_modules 里的 Electron 直接跑源码，
rem 改完代码不用重新打包，关掉重开就是这个启动器。
rem
rem 为什么要清 ELECTRON_RUN_AS_NODE：
rem   某些终端/IDE（含 DSH 的 shell）会带这个变量，Electron 一旦读到它
rem   就降级成纯 Node 跑，源码里 app.setAppUserModelId 立刻报
rem   "Cannot read properties of undefined"，窗口一个都不出来。
rem   所以启动前必须干掉它。
rem ────────────────────────────────────────────────────────────────
cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="
set "PET_TR_ENGINE="

if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 找不到 Electron 运行时：node_modules\electron\dist\electron.exe
  echo        先在本目录执行：npm install
  pause
  exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" "."
exit /b 0
