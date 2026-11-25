const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke('margin:' + channel, ...args);
const listen = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on('margin:' + channel, listener);
  return () => ipcRenderer.removeListener('margin:' + channel, listener);
};

contextBridge.exposeInMainWorld('marginDesktop', {
  open: call('open'),
  openImage: call('open-image'),
  claimFile: call('claim-file'),
  save: call('save'),
  pdf: call('pdf'),
  print: call('print'),
  external: call('external'),
  theme: call('theme'),
  ready: call('ready'),
  closeReady: call('close-ready'),
  onFile: listen('file'),
  onClose: listen('close-request'),
});
