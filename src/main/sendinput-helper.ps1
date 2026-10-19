# 常驻的按键发送器。
#
# 为什么需要它：Windows 没有「读取当前选中文字」的 API，唯一通用的办法是
# 在目标程序里合成一次 Ctrl+C。而 Electron 的 sendInputEvent 只能发给自己的
# 渲染进程，发不到别的程序；纯 JS 也没有键盘注入能力。
#
# 为什么不每次 spawn 一个新进程：`powershell.exe -Command ...` 每次启动要
# 300~500ms，按热键到球亮之间会有明显延迟。这里保持一个常驻进程，读 stdin
# 逐条执行，单次往返只要几十毫秒。
#
# 协议（一行一条命令，一行一个回复）：
#   -> ping     <- ready
#   -> ctrl+c   <- ok      或 fail
#
# 用 SendKeys 而不是自编译 P/Invoke：`Add-Type` 编译 C# 要一两秒，
# 而 System.Windows.Forms 是现成程序集，加载即用。

Add-Type -AssemblyName System.Windows.Forms

# 告诉主进程：可以开始收命令了
[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }

  switch ($line.Trim()) {
    "ping" {
      [Console]::Out.WriteLine("ready")
    }
    "ctrl+c" {
      try {
        [System.Windows.Forms.SendKeys]::SendWait("^c")
        [Console]::Out.WriteLine("ok")
      } catch {
        [Console]::Out.WriteLine("fail")
      }
    }
    default {
      [Console]::Out.WriteLine("unknown")
    }
  }
  [Console]::Out.Flush()
}
