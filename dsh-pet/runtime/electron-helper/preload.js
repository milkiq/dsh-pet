// preload 桥：只暴露点击穿透开关（宠物交互/漫游/余额/通知全部在 renderer 内自洽，
// 不再需要 close/hide/openWebUi/beep/refreshBalance 等桌面独有桥方法——与浏览器严格对齐后已删除）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petBridge', {
  setIgnoreMouse(ignore) {
    ipcRenderer.send('pet:set-ignore-mouse', { ignore: ignore === true });
  },
});
