const DATABASE = 'margin-workspace';
const LAST_DOCUMENT = 'margin-active-document';
const SETTINGS = 'margin-settings';
const RECOVERY = 'margin-recovery';

export const defaults = {
  theme: 'dark', spellcheck: true, zoom: 100, ruler: true, sidebar: true, outline: true,
  font: 'Georgia', focus: false,
};

export const documentFonts = ['Georgia', 'Arial', 'Calibri', 'Cambria', 'Consolas', 'Times New Roman', 'Verdana', 'Segoe UI'];
export const defaultPage = { paper: 'Letter', landscape: false, margin: 1, font: 'Georgia' };

export function readSmall(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

export function writeSmall(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

export const loadSettings = () => ({ ...defaults, ...readSmall(SETTINGS, {}) });
export const saveSettings = (settings) => writeSmall(SETTINGS, settings);
export const activeId = () => readSmall(LAST_DOCUMENT, null);
export const setActiveId = (id) => writeSmall(LAST_DOCUMENT, id);

function openWorkspace() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('documents', { keyPath: 'id' });
      request.result.createObjectStore('workspace');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other Margin windows and try again.'));
  });
}

function transaction(db, stores, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const result = operation(tx);
    tx.oncomplete = () => resolve(result?.result);
    tx.onabort = () => reject(tx.error || new Error('Workspace storage was interrupted.'));
    tx.onerror = () => reject(tx.error);
  });
}

export function makeDocument(title = 'Untitled document', html = '<p></p>', page = defaultPage) {
  const time = Date.now();
  return { id: crypto.randomUUID(), title, html, page: cleanPage(page), created: time, updated: time, deleted: false };
}

export function cleanPage(page = {}) {
  page ||= {};
  const margin = Number(page.margin);
  return {
    paper: page.paper === 'A4' ? 'A4' : 'Letter',
    landscape: page.landscape === true,
    margin: Number.isFinite(margin) && margin >= .35 && margin <= 1.6 ? margin : 1,
    font: documentFonts.includes(page.font) ? page.font : defaultPage.font,
  };
}

const sampleBrief = `<h1>A quieter place<br>to write.</h1>
<p>Good writing needs room to breathe. This brief lays out what we want our writing space to feel like, how it should work, and what we’ll build first.</p>
<blockquote><p>“A good tool makes the work feel closer.”</p></blockquote>
<h2>What we’re building</h2>
<p>A small, thoughtful workspace for big ideas. Margin is where notes become drafts, drafts become decisions, and the tools stay out of the way.</p>
<h2>Working principles</h2>
<ul><li><p><strong>Start with the page.</strong> Put the document at the center of every decision.</p></li><li><p><strong>Make the common things quick.</strong> Keep formatting a keystroke away.</p></li><li><p><strong>Keep work close.</strong> Save locally and make files easy to take with you.</p></li></ul>
<h2>Next steps</h2>
<table><tbody><tr><th><p>Milestone</p></th><th><p>What to check</p></th></tr><tr><td><p>First draft</p></td><td><p>Share the brief for feedback.</p></td></tr><tr><td><p>Ready to share</p></td><td><p>Export the final copy as a PDF.</p></td></tr></tbody></table>`;

const meetingNotes = `<h1>Meeting notes</h1><p><em>Add a date, attendees, and the purpose of the meeting.</em></p><h2>Agenda</h2><ul><li><p>Start with the decision we need to make.</p></li></ul><h2>Decisions</h2><p></p><h2>Action items</h2><table><tbody><tr><th><p>Action</p></th><th><p>Owner</p></th><th><p>Due date</p></th></tr><tr><td><p></p></td><td><p></p></td><td><p></p></td></tr></tbody></table>`;

export async function startStore() {
  const db = await openWorkspace();
  const all = () => transaction(db, 'documents', 'readonly', (tx) => tx.objectStore('documents').getAll());
  const save = (record) => transaction(db, 'documents', 'readwrite', (tx) => tx.objectStore('documents').put(record));
  const initialized = await transaction(db, 'workspace', 'readonly', (tx) => tx.objectStore('workspace').get('initialized'));
  if (!initialized) {
    const primary = makeDocument('The writing brief', sampleBrief);
    const secondary = makeDocument('Meeting notes', meetingNotes);
    secondary.updated = primary.updated - 1;
    await transaction(db, ['workspace', 'documents'], 'readwrite', (tx) => {
      const documents = tx.objectStore('documents');
      documents.put(primary);
      documents.put(secondary);
      tx.objectStore('workspace').put(true, 'initialized');
    });
  }
  const documents = await all();
  const recovery = readSmall(RECOVERY, null);
  if (recovery?.id && typeof recovery.html === 'string') {
    const previous = documents.find((record) => record.id === recovery.id);
    if (previous && !previous.deleted && previous.updated < recovery.updated) {
      Object.assign(previous, recovery);
      await save(previous);
    }
    clearRecovery();
  }
  return { documents, save };
}

export const journal = (record) => writeSmall(RECOVERY, record);
export const clearRecovery = () => {
  try { localStorage.removeItem(RECOVERY); } catch {}
};
