# 安装英文 OCR 语言包（需要管理员）
# 右击 -> 以管理员身份运行 PowerShell，然后执行本脚本。
$ErrorActionPreference = "Continue"

Write-Host "=== 1. 检查当前 OCR 能力 ===" -ForegroundColor Cyan
Get-WindowsCapability -Online -Name "Language.OCR*" | ForEach-Object {
  Write-Host ("  " + $_.Name + "  -> " + $_.State)
}

Write-Host ""
Write-Host "=== 2. 安装 en-US OCR ===" -ForegroundColor Cyan
$name = "Language.OCR~~~en-US~0.0.1.0"
$cap = Get-WindowsCapability -Online -Name $name
if ($null -eq $cap) {
  Write-Host "找不到 $name，列出所有 OCR 能力：" -ForegroundColor Yellow
  Get-WindowsCapability -Online | Where-Object Name -like "*OCR*" | ForEach-Object { Write-Host ("  " + $_.Name) }
} elseif ($cap.State -eq "Installed") {
  Write-Host "已经装了，无需再装。" -ForegroundColor Green
} else {
  Add-WindowsCapability -Online -Name $name
  Write-Host "安装完成。" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== 3. 验证 ===" -ForegroundColor Cyan
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
  Write-Host ("  " + $l.LanguageTag + "  |  " + $l.DisplayName)
}
Write-Host ""
Write-Host "看到 en-US 就说明成功了。回到翻译球重新框选即可。" -ForegroundColor Green
Read-Host "按回车退出"