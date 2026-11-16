const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { checks: [] };
const ck = (name, pass, detail) => out.checks.push({ name, pass, detail: detail === undefined ? null : detail });

// 1) 档位下拉
const opts = Array.from(document.querySelectorAll("#scale option")).map((o) => o.value);
ck("档位8档且含0.2/0.4", opts.length === 8 && opts[0] === "0.2" && opts[1] === "0.4", opts);

// 2) 0.2x
let s = document.getElementById("scale");
s.value = "0.2";
s.dispatchEvent(new Event("change", { bubbles: true }));
await sleep(420);
let info = await window.petPanel.info();
ck("0.2x → ballSize 19", info.scale === 0.2 && info.ballSize === 19, { scale: info.scale, ballSize: info.ballSize });

// 3) 0.4x
s = document.getElementById("scale");
s.value = "0.4";
s.dispatchEvent(new Event("change", { bubbles: true }));
await sleep(420);
info = await window.petPanel.info();
ck("0.4x → ballSize 38", info.scale === 0.4 && info.ballSize === 38, { scale: info.scale, ballSize: info.ballSize });

// 复位 1.0
s = document.getElementById("scale");
s.value = "1";
s.dispatchEvent(new Event("change", { bubbles: true }));
await sleep(320);

// 4) 点按钮进入录制
const hk = document.getElementById("hotkey-value");
hk.click();
await sleep(200);
ck("点按钮进入录制", hk.dataset.recording === "1", hk.dataset.recording);

// 5) 按 Ctrl+Shift+F9
document.dispatchEvent(
  new KeyboardEvent("keydown", {
    code: "F9",
    key: "F9",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  }),
);
await sleep(750);
info = await window.petPanel.info();
ck("新组合生效", info.hotkey && info.hotkey.accelerator === "Control+Shift+F9", info.hotkey);
ck("按钮显示新组合", /Ctrl\+Shift\+F9/.test(hk.textContent), hk.textContent);
ck("录完退出录制", hk.dataset.recording === "0", hk.dataset.recording);

// 6) 关闭热键
const en = document.getElementById("hotkey-enabled");
en.checked = false;
en.dispatchEvent(new Event("change", { bubbles: true }));
await sleep(500);
info = await window.petPanel.info();
ck("关闭已生效", info.hotkeyEnabled === false && info.hotkey.enabled === false, {
  enabledCfg: info.hotkeyEnabled,
  enabledLive: info.hotkey && info.hotkey.enabled,
});
ck("关闭后显示「已关闭」", hk.textContent.trim() === "已关闭", hk.textContent);

// 7) 重新打开
en.checked = true;
en.dispatchEvent(new Event("change", { bubbles: true }));
await sleep(500);
info = await window.petPanel.info();
ck("重新打开已生效", info.hotkeyEnabled === true && info.hotkey.enabled === true, {
  enabledCfg: info.hotkeyEnabled,
  enabledLive: info.hotkey && info.hotkey.enabled,
});

// 8) 无修饰键被拒：按 F8（不带修饰），应弹提示且不改设置
hk.click();
await sleep(200);
const beforeAcc = (await window.petPanel.info()).hotkey.accelerator;
document.dispatchEvent(
  new KeyboardEvent("keydown", { code: "F8", key: "F8", bubbles: true, cancelable: true }),
);
await sleep(450);
info = await window.petPanel.info();
ck("无修饰键被拒", info.hotkey.accelerator === beforeAcc, { before: beforeAcc, after: info.hotkey.accelerator });
ck("拒绝后提示条可见", !document.getElementById("hotkey-note").hidden, document.getElementById("hotkey-note").textContent);

// 收尾：把热键恢复成默认，别把这个沙箱继续往下带
hk.click();
await sleep(150);
if (hk.dataset.recording === "1") {
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true, cancelable: true }));
}

out.passed = out.checks.filter((c) => c.pass).length;
out.total = out.checks.length;
out.ok = out.passed === out.total;
return out;
