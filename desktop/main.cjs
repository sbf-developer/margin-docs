const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fileURLToPath } = require('node:url');

const APP_ID = 'com.margin.docs';
const DOCUMENTS = ['margin', 'docx', 'odt', 'pdf', 'md', 'markdown', 'txt', 'html', 'htm'];
const FORMATS = {
  margin: 'Margin document', docx: 'Word document', pdf: 'PDF document',
  md: 'Markdown document', txt: 'Plain text', html: 'HTML document',
};
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const entry = path.resolve(__dirname, '../dist/index.html');
const limit = 48 * 1024 * 1024;
const grants = new Map();
const launchFiles = [];
let win;
let links = {};
let linksWrite = Promise.resolve();
let closeAllowed = false;
let closePending = false;
let ready = false;
let quitRequested = false;

app.setName('Margin');
app.setAppUserModelId(APP_ID);
const profileArgument = app.commandLine.getSwitchValue('user-data-dir');
if (profileArgument && path.isAbsolute(profileArgument)) {
  require('node:fs').mkdirSync(profileArgument, { recursive: true });
  app.setPath('userData', profileArgument);
}

function trusted(event) {
  const frame = event.senderFrame;
  try {
    return event.sender === win?.webContents && frame === win.webContents.mainFrame && fileURLToPath(frame.url) === entry;
  } catch {
    return false;
  }
}

function handle(name, handler) {
  ipcMain.handle('margin:' + name, async (event, ...args) => {
    if (!trusted(event)) throw new Error('Unrecognized application window.');
    try {
      return await handler(...args);
    } catch (error) {
      if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw new Error('Windows could not access this file. Close it in other apps and check its permissions.');
      if (error.code === 'ENOSPC') throw new Error('There is not enough space to save this file.');
      throw error;
    }
  });
}

const extension = (name) => path.extname(name).slice(1).toLowerCase();
const validId = (id) => typeof id === 'string' && /^[\w-]{1,70}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const linksPath = () => path.join(app.getPath('userData'), 'file-links.json');

async function atomicWrite(target, contents) {
  const temporary = path.join(path.dirname(target), '.margin-' + randomUUID() + '.tmp');
  try {
    await fs.writeFile(temporary, contents, { flag: 'wx', flush: true });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeLinks() {
  const snapshot = JSON.stringify(links);
  linksWrite = linksWrite.catch(() => {}).then(() => atomicWrite(linksPath(), snapshot));
  await linksWrite;
}

async function readFile(file, image = false) {
  const ext = extension(file);
  if (image ? !IMAGE_TYPES[ext] : !DOCUMENTS.includes(ext)) throw new Error('This file type is unsupported.');
  const stats = await fs.stat(file);
  if (!stats.isFile() || stats.size > (image ? 14 * 1024 * 1024 : limit)) throw new Error('This file is too large or could not be read.');
  const data = await fs.readFile(file);
  const association = !image && ext === 'margin' ? randomUUID() : null;
  if (association) {
    if (grants.size >= 50) grants.delete(grants.keys().next().value);
    grants.set(association, file);
  }
  return { name: path.basename(file), data, association, mime: image ? IMAGE_TYPES[ext] : undefined };
}

async function chooseOpen(image) {
  const filters = image
    ? [{ name: 'Images', extensions: Object.keys(IMAGE_TYPES) }]
    : [{ name: 'Supported documents', extensions: DOCUMENTS }, { name: 'Margin documents', extensions: ['margin'] }, { name: 'PDF documents', extensions: ['pdf'] }, { name: 'Word documents', extensions: ['docx'] }];
  const result = await dialog.showOpenDialog(win, { title: image ? 'Insert an image' : 'Open a document', properties: ['openFile'], filters });
  return result.canceled ? null : readFile(result.filePaths[0], image);
}

async function savePath(format, title) {
  if (!Object.hasOwn(FORMATS, format)) throw new Error('Unknown export format.');
  const name = String(title ?? 'Untitled document').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, '').slice(0, 135) || 'Untitled document';
  const result = await dialog.showSaveDialog(win, {
    title: format === 'margin' ? 'Save Margin document' : 'Export ' + FORMATS[format],
    defaultPath: path.join(app.getPath('documents'), name + '.' + format),
    filters: [{ name: FORMATS[format], extensions: [format] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (result.canceled || !result.filePath) return null;
  if (extension(result.filePath) !== format) throw new Error('Use the .' + format + ' extension for this file.');
  return result.filePath;
}

handle('open', () => chooseOpen(false));
handle('open-image', () => chooseOpen(true));
handle('claim-file', async (id, grant) => {
  if (!validId(id) || !grants.has(grant)) return false;
  links[id] = grants.get(grant);
  grants.delete(grant);
  await writeLinks();
  return true;
});
handle('save', async ({ format, title, bytes, id, copy } = {}) => {
  if (format === 'pdf' || !Object.hasOwn(FORMATS, format) || !(ArrayBuffer.isView(bytes) || bytes instanceof ArrayBuffer)) throw new Error('Invalid file data.');
  const data = Buffer.from(ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes);
  if (data.length > limit) throw new Error('This document exceeds the 48 MB export limit.');
  const attach = format === 'margin' && validId(id);
  const previous = attach && Object.hasOwn(links, id) ? links[id] : null;
  const file = (!copy && previous) || await savePath(format, title);
  if (!file) return null;
  await atomicWrite(file, data);
  if (attach && previous !== file) {
    links[id] = file;
    await writeLinks();
  }
  return path.basename(file);
});

async function withPrintWindow(html, callback) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > limit) throw new Error('The print document exceeds the 48 MB limit.');
  const file = path.join(app.getPath('temp'), 'margin-print-' + randomUUID() + '.html');
  const printWindow = new BrowserWindow({
    show: false, paintWhenInitiallyHidden: true,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  printWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  try {
    await fs.writeFile(file, html, { flag: 'wx' });
    await printWindow.loadFile(file);
    return await callback(printWindow.webContents);
  } finally {
    printWindow.destroy();
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

handle('pdf', async ({ title, html } = {}) => {
  const file = await savePath('pdf', title);
  if (!file) return null;
  const pdf = await withPrintWindow(html, (contents) => contents.printToPDF({
    preferCSSPageSize: true, printBackground: true, generateTaggedPDF: true, generateDocumentOutline: true,
  }));
  await atomicWrite(file, pdf);
  return path.basename(file);
});
handle('print', ({ html, paper, landscape, margin } = {}) => withPrintWindow(html, (contents) => new Promise((resolve, reject) => {
  const marginPx = Math.round(Math.min(2, Math.max(0, Number(margin) || 0)) * 96);
  contents.print({ silent: false, printBackground: true, pageSize: paper === 'A4' ? 'A4' : 'Letter', landscape: landscape === true,
    margins: { marginType: 'custom', top: marginPx, bottom: marginPx, left: marginPx, right: marginPx } }, (success, reason) => {
    if (success) resolve(true);
    else if (/cancel/i.test(reason)) resolve(false);
    else reject(new Error(reason || 'The document could not be printed.'));
  });
})));
handle('external', async (url) => {
  if (typeof url !== 'string' || url.length > 3000) return;
  const resolved = new URL(url);
  if (/^(https?:|mailto:)$/.test(resolved.protocol)) await shell.openExternal(resolved.href);
});
handle('theme', (mode) => {
  const light = mode === 'light';
  win.setTitleBarOverlay({ color: light ? '#f7f7fa' : '#17171a', symbolColor: light ? '#282433' : '#ededf0', height: 51 });
});
handle('ready', async () => {
  ready = true;
  return Promise.all(launchFiles.splice(0).map((file) => readFile(file).catch(() => null)));
});
handle('close-ready', (ok) => {
  closePending = false;
  if (ok) {
    closeAllowed = true;
    if (quitRequested) app.quit();
    else win.close();
  } else {
    quitRequested = false;
  }
});

function queueUserFiles(argv) {
  for (const file of argv) {
    if (!path.isAbsolute(file) || !DOCUMENTS.includes(extension(file))) continue;
    if (ready && win) readFile(file).then((data) => win?.webContents.send('margin:file', data)).catch(() => {});
    else launchFiles.push(file);
  }
}

function createWindow() {
  const light = !nativeTheme.shouldUseDarkColors;
  closeAllowed = false;
  closePending = false;
  ready = false;
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 740, minHeight: 540, show: false,
    icon: path.resolve(__dirname, '../build/icon.png'), backgroundColor: '#202024', title: 'Margin',
    titleBarStyle: 'hidden', titleBarOverlay: { color: light ? '#f7f7fa' : '#17171a', symbolColor: light ? '#282433' : '#ededf0', height: 51 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_sender, _permission, respond) => respond(false));
  win.once('ready-to-show', () => win?.show());
  win.on('close', (event) => {
    if (closeAllowed || !ready || win.webContents.isCrashed()) return;
    event.preventDefault();
    if (!closePending) {
      closePending = true;
      win.webContents.send('margin:close-request');
    }
  });
  win.on('closed', () => { win = null; ready = false; });
  win.loadFile(entry);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  queueUserFiles(process.argv.slice(1));
  app.on('second-instance', (_event, arguments_) => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
    queueUserFiles(arguments_.slice(1));
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const stored = await fs.readFile(linksPath(), 'utf8').then(JSON.parse).catch(() => ({}));
    links = Object.fromEntries(Object.entries(stored ?? {}).filter(([id, file]) => validId(id) && typeof file === 'string' && path.isAbsolute(file) && extension(file) === 'margin'));
    createWindow();
  });
  app.on('before-quit', (event) => {
    if (win && !closeAllowed && ready && !win.webContents.isCrashed()) {
      event.preventDefault();
      quitRequested = true;
      win.close();
    }
  });
  app.on('window-all-closed', () => app.quit());
}
