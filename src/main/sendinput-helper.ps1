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
#   -> ctrl+c   <- ok      合成成功
#               <- busy    修饰键一直按着没松，没敢按（主进程会稍后重试）
#               <- fail    合成时抛错
#
# 用 SendKeys 而不是自编译 P/Invoke：`Add-Type` 编译 C# 要一两秒，
# 而 System.Windows.Forms 是现成程序集，加载即用。

Add-Type -AssemblyName System.Windows.Forms

# GetAsyncKeyState 读的是「物理按键当前电平」，跨进程、跨线程都准；
# Control.ModifierKeys 底层是 GetKeyState（相对本线程消息队列），在没有消息泵的
# 控制台进程里理论上可能读到 None。这里用前者，最稳。
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PetKeyState {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  public static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  public static bool AnyModifierDown() {
    return Down(0x11) || Down(0x12) || Down(0x10) || Down(0x5B) || Down(0x5C);
  }
}
"@

# 告诉主进程：可以开始收命令了
[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()

# ── 关键：等修饰键松手 ────────────────────────────────────────────────
# 按 Ctrl+Alt+T 触发全局热键时，Windows 是在 T 按下的瞬间就把事件派发过来的，
# 此刻用户的 Ctrl / Alt 还是物理按住的。若立刻 SendKeys "^c"，合成出来的实际
# 是 Ctrl+Alt+C，目标程序不认，剪贴板不会变 —— 于是取词失败（no-selection）。
# 这就是「点球能翻译、热键时好时坏」的真正原因：松手快的那次就侥幸成功。
#
# 所以在真正按 Ctrl+C 之前，先轮询物理按键状态，等 Ctrl/Alt/Shift/Win 全部松开
# （最多等 900ms）。超时说明用户还按着，回 busy 让主进程稍后重试，绝不硬发。
function Wait-ModifiersReleased {
  $deadline = (Get-Date).AddMilliseconds(900)
  while ((Get-Date) -lt $deadline) {
    if (-not [PetKeyState]::AnyModifierDown()) {
      return $true
    }
    Start-Sleep -Milliseconds 12
  }
  return $false
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }

  switch ($line.Trim()) {
    "ping" {
      [Console]::Out.WriteLine("ready")
    }
    "ctrl+c" {
      try {
        if (-not (Wait-ModifiersReleased)) {
          [Console]::Out.WriteLine("busy")
        } else {
          Start-Sleep -Milliseconds 20
          [System.Windows.Forms.SendKeys]::SendWait("^c")
          [Console]::Out.WriteLine("ok")
        }
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
