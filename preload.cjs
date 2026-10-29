// Bridge for the UI pages: one request channel, three push events. Nothing else from Node/Electron leaks in.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['vf:changed', 'vf:show', 'vf:view'];
contextBridge.exposeInMainWorld('vf', {
  call: (msg) => ipcRenderer.invoke('vf', msg),
  on: (channel, fn) => { if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_, data) => fn(data)); },
});
