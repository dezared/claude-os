// What the page may ask of the window. Sandboxed: only the electron module, nothing of Node.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, value) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('claudeDesktop', {
  canFullscreen: process.platform === 'win32',
  onCloseRequest: (cb) => on('close-request', cb),
  answerClose: (choice) => ipcRenderer.send('close-answer', choice),
  notify: (notice) => ipcRenderer.send('notify', notice),
  onOpenTab: (cb) => on('open-tab', cb),
  setLabels: (labels) => ipcRenderer.send('labels', labels),
  isFullscreen: () => ipcRenderer.invoke('fullscreen-get'),
  setFullscreen: (on_) => ipcRenderer.send('fullscreen-set', on_),
  onFullscreen: (cb) => on('fullscreen', cb),
  minimize: () => ipcRenderer.send('minimize'),
  currentApps: () => ipcRenderer.invoke('apps-get'),
  onApps: (cb) => on('apps', cb),
  activateApp: (id) => ipcRenderer.send('apps-activate', id),
  openPopout: (req) => ipcRenderer.send('popout-open', req),
  returnPopout: (key) => ipcRenderer.send('popout-return', key),
  popouts: () => ipcRenderer.invoke('popouts-get'),
  onPopouts: (cb) => on('popouts', cb),
  onShowView: (cb) => on('show-view', cb),
  showInMain: (view) => ipcRenderer.send('popout-go', view),
  popoutPin: () => ipcRenderer.invoke('popout-pin-get'),
  setPopoutPin: (value) => ipcRenderer.send('popout-pin', value),
  popoutWindow: (action) => ipcRenderer.send('popout-window', action),
});
