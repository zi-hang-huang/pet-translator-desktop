/**
 * 截图框选窗口的预加载脚本。
 *
 * 只暴露框选需要的最小面：拿初始化数据、把选框交回去、取消。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petShot", {
  /** 主进程把「截图 dataURL + 缩放比」推过来时调用。 */
  onInit: (handler) => {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on("shot:init", listener);
    return () => ipcRenderer.removeListener("shot:init", listener);
  },

  /** 把选框（CSS px）交给主进程裁剪。 @returns {Promise<object>} */
  commit: (rect) => ipcRenderer.invoke("shot:commit", rect),

  /** 用户放弃。 */
  cancel: () => ipcRenderer.send("shot:cancel"),

  /** 框选完成后让主进程收掉窗口。 */
  done: () => ipcRenderer.send("shot:done"),
});
