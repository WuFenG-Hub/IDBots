// Isolated renderer preview: no production preload, wallet, daemon, or model calls.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, '../.proposal-demo-data'));
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1400, height: 960, minWidth: 950, minHeight: 700, title: 'IDBots · Proposal Studio (Preview)', backgroundColor: '#F5F7F9', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.loadFile(path.join(__dirname, '../dist-proposal-demo/proposal-demo.html'));
});
app.on('window-all-closed', () => app.quit());
