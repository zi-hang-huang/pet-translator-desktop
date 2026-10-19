# 取词链路端到端自测。
#
#     pwsh -File scripts/e2e-pickup.ps1 [-Engine stub|real] [-DelayMs 8000]
#
# 它做的事：
#   1. 开一个记事本，写一段英文，全选（模拟「用户选中了文字」）
#   2. 启动被测程序，带 --pickup-selftest：等 DelayMs 后自动取词
#   3. 程序取到词 → 等价于点球确认 → 翻译 → 打一行 JSON 事实 → 退出
#   4. 打印程序的 stdout / stderr
#
# 为什么要有这个脚本：`手在别的程序里选中文字` 这一步没法在代码里做，
# 但它之前一步（记事本全选）和之后每一步都是真的，中间没有 mock。
#
# 教训：**永远不要用 -Wait 等一个可能不退出进程**。上一版就是这么挂死的：
#       程序里一个未捕获的异常让它永不退出，-Wait 于是永远等下去。
#       这里用 WaitForExit(超时)，超时就强杀。

param(
  [ValidateSet("stub", "real")]
  [string]$Engine = "stub",
  [int]$DelayMs = 8000,
  [int]$TimeoutMs = 90000,
  # 确认之后等多久再收尾。真引擎要等网页加载 + 生成，得留够
  [int]$WaitMs = 0,
  # 测打包版：直接给 翻译球.exe 的路径。打包版不接「应用目录」这个参数。
  # 注意：PowerShell 变量名不区分大小写，所以这个参数**不能**叫 $Exe —— 会和下面的 $exe 撞成同一个变量
  [string]$ExePath = ""
)

if ($WaitMs -le 0) { $WaitMs = if ($Engine -eq "stub") { 2500 } else { 25000 } }

$ErrorActionPreference = "Continue"

$exe = "D:\document\FET\project_data\dsh\pet-translator\dsh-pet-translator\node_modules\electron\dist\electron.exe"
$root = "D:\document\FET\project_data\dsh\pet-translator\pet-translator-desktop"
# 打包版：可执行文件不自带应用目录参数
$appArgs = @($root, "--pickup-selftest")
if ($ExePath -ne "") {
  $exe = $ExePath
  $appArgs = @("--pickup-selftest")
}
Write-Host "[e2e] 可执行文件: $exe"
Write-Host "[e2e] 参数: $($appArgs -join ' ')"
$log = Join-Path $env:TEMP "pet-tr-pickup.log"
$err = Join-Path $env:TEMP "pet-tr-pickup.err"
$sample = Join-Path $env:TEMP "pet-tr-sample.txt"

Remove-Item $log, $err -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath $sample -Encoding UTF8 -Value (
  "Attention is all you need. The dominant sequence transduction models are based on complex recurrent or convolutional neural networks."
)

$notepad = $null
try {
  # 1) 记事本 + 英文段落
  $notepad = Start-Process notepad.exe -ArgumentList $sample -PassThru
  Start-Sleep -Milliseconds 1200

  # 2) 全选（用 Windows PowerShell 5.1，它一定有 System.Windows.Forms）
  & powershell.exe -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^a')" | Out-Null
  Start-Sleep -Milliseconds 400

  # 3) 启动被测程序
  #    先确保没有上一个实例：球是单实例的，抢不到锁的新进程会立刻退出，
  #    而它的表现不是报错，是 Electron 打一段 CLI 帮助 —— 极难从现场看出原因。
  Get-Process -Name "翻译球", "electron" -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-30) } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800

  $env:PET_TR_SELFTEST_DELAY = "$DelayMs"
  $env:PET_TR_SELFTEST_WAIT = "$WaitMs"
  if ($Engine -eq "stub") {
    $env:PET_TR_ENGINE = "stub"
  } else {
    Remove-Item Env:PET_TR_ENGINE -ErrorAction SilentlyContinue
  }
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

  $app = Start-Process -FilePath $exe -ArgumentList $appArgs `
    -RedirectStandardOutput $log -RedirectStandardError $err -PassThru

  if (-not $app.WaitForExit($TimeoutMs)) {
    Write-Host "[e2e] 超时 ${TimeoutMs}ms，强杀 pid=$($app.Id)" -ForegroundColor Yellow
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  } else {
    $app.WaitForExit()  # 排空重定向流
    Write-Host "[e2e] 退出码 $($app.ExitCode)"
  }
} finally {
  if ($null -ne $notepad) { Stop-Process -Id $notepad.Id -Force -ErrorAction SilentlyContinue }
  Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-5) } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
}

Write-Host "=== stdout ==="
Get-Content $log -Encoding utf8 -ErrorAction SilentlyContinue
Write-Host "=== stderr ==="
Get-Content $err -Encoding utf8 -ErrorAction SilentlyContinue | Select-Object -First 20
