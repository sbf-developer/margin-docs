import './app.css';
import { icon, mountIcons } from './icons.js';
import { makeEditor, replaceSearch, searchState, updateSearch } from './editor.js';
import { activeId, cleanPage, clearRecovery, documentFonts as fonts, journal, loadSettings, makeDocument, saveSettings, setActiveId, startStore } from './store.js';
import { downloadFile, escapeHTML, exportDocument, fileBytes, openDocument, printDocument, safeLink } from './formats.js';

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const root = document.documentElement;
const desktop = window.marginDesktop;
const settings = loadSettings();
const toolbar = $('#toolbar');
const dialog = $('#dialog');
const menu = $('#menu');
const canvas = $('#canvas');
const surface = $('#editor');
const findBar = $('#find-bar');
const findInput = $('#find-query');
const replaceInput = $('#replace-query');
const styleNames = ['Body text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'];
const zoomSteps = [50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200];
const systemLight = matchMedia('(prefers-color-scheme: light)');
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
let workspace;
let documents = [];
let current;
let editor;
let dirty = false;
let saveTimer;
let metadataTimer;
let toolbarFrame;
let writeTail = Promise.resolve();
let toastTimer;
let menuAnchor;
let busy = false;
let matchCase = false;

mountIcons();

function toast(message, type = 'info', duration = 3600) {
  const element = $('#toast');
  clearTimeout(toastTimer);
  element.textContent = message;
  element.hidden = false;
  element.dataset.type = type;
  if (duration) toastTimer = setTimeout(() => { element.hidden = true; }, duration);
}

function report(error) {
  const message = error?.message || String(error);
  toast(message.replace(/^Error invoking remote method '[^']+': Error: /, ''), 'error', 6500);
}

function saveState(state, label) {
  $('#save-status').dataset.state = state;
  $('#save-label').textContent = label;
}

function persist(record) {
  const snapshot = structuredClone(record);
  writeTail = writeTail.catch(() => {}).then(() => workspace.save(snapshot));
  return writeTail;
}

function checkpoint() {
  if (!dirty || !current || !editor) return null;
  current.html = editor.getHTML();
  current.updated = Date.now();
  return current;
}

async function flush() {
  clearTimeout(saveTimer);
  const record = checkpoint();
  if (!record) return writeTail;
  dirty = false;
  const updated = record.updated;
  try {
    await persist(record);
    if (current === record && !dirty && current.updated === updated) {
      clearRecovery();
      saveState('saved', 'Saved locally');
    }
  } catch (error) {
    if (current === record) {
      dirty = true;
      journal(record);
      saveState('error', 'Save failed');
    }
    throw error;
  }
}

function scheduleSave() {
  dirty = true;
  if ($('#save-status').dataset.state !== 'saving') saveState('saving', 'Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush().catch(report), 360);
  clearTimeout(metadataTimer);
  metadataTimer = setTimeout(renderMetadata, 125);
}

function normalizedZoom(value) {
  return Math.max(45, Math.min(200, Number(value) || 100));
}

function applySettings() {
  const light = settings.theme === 'light' || (settings.theme === 'system' && systemLight.matches);
  root.dataset.theme = light ? 'light' : 'dark';
  desktop?.theme(root.dataset.theme).catch(() => {});
  root.classList.toggle('sidebar-hidden', !settings.sidebar || settings.focus);
  root.classList.toggle('focus-mode', settings.focus);
  $('#outline').hidden = !settings.outline;
  $('[data-action="outline"]').setAttribute('aria-expanded', String(settings.outline));
  $('[data-action="sidebar"]').setAttribute('aria-pressed', String(settings.sidebar && !settings.focus));
  $('[data-action="focus"]').setAttribute('aria-pressed', String(settings.focus));
  $('#ruler').hidden = !settings.ruler;
  const zoom = normalizedZoom(settings.zoom);
  root.style.setProperty('--zoom', zoom / 100);
  $('#zoom-label').textContent = zoom + '%';
  editor?.view.dom.setAttribute('spellcheck', String(settings.spellcheck));
}

function changeSettings(patch) {
  Object.assign(settings, patch);
  if (!saveSettings(settings)) toast('Settings could not be saved.', 'error');
  applySettings();
  refreshToolbar();
}

function pageDimensions() {
  const page = cleanPage(current?.page);
  const [short, long] = page.paper === 'A4' ? [8.27, 11.69] : [8.5, 11];
  return {
    width: (page.landscape ? long : short) * 96,
    height: (page.landscape ? short : long) * 96,
    margin: page.margin * 96,
    rulerWidth: page.landscape ? long : short,
  };
}

function renderPage() {
  const { width, height, margin, rulerWidth } = pageDimensions();
  surface.style.fontFamily = '"' + cleanPage(current?.page).font + '", serif';
  for (const [name, value] of [['width', width], ['height', height], ['margin', margin]]) root.style.setProperty('--paper-' + name, value + 'px');
  $('.ruler-ticks').innerHTML = Array.from({ length: Math.ceil(rulerWidth) }, (_, index) =>
    '<span class="ruler-unit" style="flex-grow:' + Math.min(1, rulerWidth - index) + '">' + (index || '') + '</span>').join('');
}

function renderTitle() {
  $('#document-title').textContent = current.title;
  document.title = current.title + ' — Margin';
}

function sortedDocuments(deleted = false) {
  return documents.filter((record) => Boolean(record.deleted) === deleted)
    .sort((a, b) => b.updated - a.updated || a.title.localeCompare(b.title));
}

function renderDocuments() {
  const nav = $('#documents');
  nav.replaceChildren();
  const records = sortedDocuments();
  for (const record of records.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'document-row' + (current?.id === record.id ? ' active' : '');
    row.innerHTML = '<button data-document="' + record.id + '" ' + (current?.id === record.id ? 'aria-current="page"' : '') + '>' + icon('file-text') + '<span>' + escapeHTML(record.title) + '</span></button>'
      + '<button class="icon-button" data-menu="row" data-id="' + record.id + '" aria-label="Options for ' + escapeHTML(record.title) + '">' + icon('ellipsis') + '</button>';
    nav.append(row);
  }
  if (records.length > 12) nav.insertAdjacentHTML('beforeend', '<button class="sidebar-link" data-action="library">View all documents</button>');
}

let outlineSignature = '';

function renderMetadata() {
  if (!editor) return;
  const text = editor.getText({ blockSeparator: '\n' }).trim();
  let words = 0;
  for (const segment of wordSegmenter.segment(text)) if (segment.isWordLike) words++;
  const characters = [...text].length;
  $('#word-count').textContent = words.toLocaleString() + (words === 1 ? ' word' : ' words');
  $('#character-count').textContent = characters.toLocaleString() + (characters === 1 ? ' character' : ' characters');

  const headings = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'heading' && node.textContent.trim()) {
      const title = node.textBetween(0, node.content.size, ' ', ' ').trim();
      headings.push({ title, position, level: node.attrs.level });
    }
  });
  const signature = JSON.stringify(headings);
  if (signature === outlineSignature) return;
  outlineSignature = signature;
  const outline = $('#outline');
  outline.replaceChildren();
  if (!headings.length) {
    outline.innerHTML = '<div class="empty-hint">Headings appear here</div>';
    return;
  }
  const base = Math.min(...headings.map(({ level }) => level));
  for (const { title, level, position } of headings) {
    const button = document.createElement('button');
    button.className = 'outline-item';
    button.textContent = title;
    button.title = title;
    button.dataset.heading = position;
    button.style.setProperty('--level', Math.min(5, level - base));
    outline.append(button);
  }
}

async function openRecord(record, focus = false) {
  if (!record || record.deleted || current?.id === record.id) return;
  await flush();
  closeFind(false);
  editor?.destroy();
  current = record;
  setActiveId(record.id);
  dirty = false;
  saveState('saved', 'Saved locally');
  editor = makeEditor(surface, record.html, settings.spellcheck, {
    update: scheduleSave,
    transaction: () => {
      if (!toolbarFrame) toolbarFrame = requestAnimationFrame(() => {
        toolbarFrame = 0;
        refreshToolbar();
        renderFind();
      });
    },
    openLink: (href) => desktop ? desktop.external(href).catch(report) : window.open(href, '_blank', 'noopener,noreferrer'),
  });
  outlineSignature = '';
  renderTitle();
  renderDocuments();
  renderPage();
  renderMetadata();
  refreshToolbar();
  canvas.scrollTo(0, 0);
  if (focus) editor.commands.focus('start');
}

async function addRecord(record, focus = false) {
  await flush();
  await persist(record);
  documents.push(record);
  await openRecord(record, focus);
  return record;
}

async function newDocument() {
  await addRecord(makeDocument(undefined, undefined, { font: settings.font }), true);
}

function refreshToolbar() {
  if (!editor) return;
  const heading = [1, 2, 3, 4, 5, 6].find((level) => editor.isActive('heading', { level })) ?? 0;
  const style = editor.getAttributes('textStyle');
  $('#style-label').textContent = editor.isActive('blockquote') ? 'Quote' : editor.isActive('codeBlock') ? 'Code block' : styleNames[heading];
  $('#font-label').textContent = (style.fontFamily || cleanPage(current.page).font).replace(/["']/g, '');
  $('#size-label').textContent = style.fontSize?.replace(/pt$/, '') || (heading ? [12, 41, 19, 15, 13, 12, 11][heading] : 12);
  for (const [command, mark] of Object.entries({ bold: 'bold', italic: 'italic', underline: 'underline', bullet: 'bulletList', numbered: 'orderedList' })) {
    $('[data-cmd="' + command + '"]').setAttribute('aria-pressed', String(editor.isActive(mark)));
  }
  $('[data-cmd="undo"]').disabled = !editor.can().undo();
  $('[data-cmd="redo"]').disabled = !editor.can().redo();
  $('[data-menu="highlight"]').setAttribute('aria-pressed', String(editor.isActive('highlight')));
  $('[data-action="link"]').setAttribute('aria-pressed', String(editor.isActive('link')));
  $('[data-menu="table"]').setAttribute('aria-pressed', String(editor.isActive('table')));
  const alignment = ['center', 'right', 'justify'].find((value) => editor.isActive({ textAlign: value })) || 'left';
  const align = $('[data-menu="alignment"]');
  if (align.dataset.icon !== 'align-' + alignment) {
    align.dataset.icon = 'align-' + alignment;
    align.innerHTML = icon(align.dataset.icon);
  }
}

const editorCommand = (name, ...args) => () => editor?.chain().focus()[name](...args).run();
const commands = {
  undo: editorCommand('undo'), redo: editorCommand('redo'),
  bold: editorCommand('toggleBold'), italic: editorCommand('toggleItalic'), underline: editorCommand('toggleUnderline'),
  bullet: editorCommand('toggleBulletList'), numbered: editorCommand('toggleOrderedList'),
};

function setSpacing(value) {
  const node = editor.isActive('heading') ? 'heading' : 'paragraph';
  editor.chain().focus().updateAttributes(node, { lineSpacing: value }).run();
}

function toggleBlock(type, level) {
  const command = editor.chain().focus();
  if (editor.isActive('blockquote')) command.unsetBlockquote();
  if (type === 'heading') command.setHeading({ level }).run();
  else if (type === 'quote') editor.chain().focus().toggleBlockquote().run();
  else if (type === 'code') command.toggleCodeBlock().run();
  else command.setParagraph().run();
}

function showFind() {
  closeMenu();
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
  runFind();
}

function closeFind(refocus = true) {
  findBar.hidden = true;
  if (!editor) return;
  updateSearch(editor, { query: '', index: 0 }, false);
  if (refocus) editor.commands.focus();
}

function runFind() {
  if (!editor || findBar.hidden) return;
  updateSearch(editor, { query: findInput.value, index: 0, matchCase });
  renderFind();
}

function renderFind() {
  if (!editor || findBar.hidden) return;
  const state = searchState(editor);
  const total = state.matches.length;
  $('#find-count').textContent = total ? (state.index + 1) + ' / ' + total : state.query ? '0 results' : '';
  for (const action of ['previous-match', 'next-match', 'replace', 'replace-all']) {
    $('[data-action="' + action + '"]').disabled = !total;
  }
}

function moveFind(delta) {
  updateSearch(editor, { index: searchState(editor).index + delta });
  renderFind();
}

function replaceFound(all) {
  const count = replaceSearch(editor, replaceInput.value, all);
  if (all && count) toast('Replaced ' + count + (count === 1 ? ' match.' : ' matches.'));
  else editor.view.dom.querySelector('.search-hit-current')?.scrollIntoView({ block: 'nearest' });
  renderFind();
}

function closeMenu(restore = false) {
  if (!menuAnchor) return;
  menuAnchor.setAttribute('aria-expanded', 'false');
  if (restore && menuAnchor.isConnected) menuAnchor.focus({ preventScroll: true });
  menuAnchor = null;
  menu.hidden = true;
  menu.replaceChildren();
}

const option = (label, run, properties = {}) => ({ label, run, ...properties });
const flagged = (value) => ({ checked: value });
const colors = ['#252525', '#555552', '#83837f', '#b7b7b3', '#dbdbd8', '#ffffff', '#a93237', '#a35d26', '#866417', '#32694e', '#326d77', '#325987'];
const highlights = ['#f7ebbb', '#f1d9d8', '#e7e7e3', '#d7e5eb', '#dae9df', '#f5e0cc'];
const colorNames = ['Ink', 'Graphite', 'Gray', 'Silver', 'Light gray', 'White', 'Red', 'Orange', 'Gold', 'Green', 'Teal', 'Blue'];
const highlightNames = ['Sand', 'Rose', 'Gray', 'Blue', 'Sage', 'Peach'];

function menuOptions(name, anchor) {
  const textStyle = editor.getAttributes('textStyle');
  const record = anchor.dataset.id ? documents.find(({ id }) => id === anchor.dataset.id) : current;
  switch (name) {
    case 'document':
    case 'row':
      return [
        ...(name === 'document' ? [
          option('New document', newDocument, { icon: 'file-plus', shortcut: 'Ctrl N' }),
          option('Open file…', chooseDocument, { icon: 'folder-open', shortcut: 'Ctrl O' }), null,
          option('Save Margin file', () => saveAs('margin'), { icon: 'check', shortcut: 'Ctrl S' }),
          option('Save as…', () => saveAs('margin', true), { icon: 'download', shortcut: 'Ctrl Shift S' }),
          option('Print…', print, { icon: 'printer', shortcut: 'Ctrl P' }), null,
        ] : []),
        option('Rename…', () => rename(record), { icon: 'pilcrow' }),
        option('Duplicate', () => duplicate(record), { icon: 'copy' }),
        option('Move to trash', () => trash(record), { icon: 'trash-2' }),
      ];
    case 'export':
      return [
        option('PDF document', () => saveAs('pdf'), { icon: 'file-text' }),
        option('Word document (.docx)', () => saveAs('docx'), { icon: 'file-text' }),
        option('OpenDocument Text (.odt)', () => saveAs('odt'), { icon: 'file-text' }),
        option('Margin document (.margin)', () => saveAs('margin', true), { icon: 'file' }), null,
        option('Markdown (.md)', () => saveAs('md'), { icon: 'file-text' }),
        option('HTML (.html)', () => saveAs('html'), { icon: 'file-text' }),
        option('Plain text (.txt)', () => saveAs('txt'), { icon: 'file-text' }), null,
        option('Print…', print, { icon: 'printer', shortcut: 'Ctrl P' }),
      ];
    case 'style':
      return [...styleNames.map((label, level) => option(label, () => toggleBlock(level ? 'heading' : 'paragraph', level), flagged(level ? editor.isActive('heading', { level }) : editor.isActive('paragraph') && !editor.isActive('blockquote')))),
        null, option('Quote', () => toggleBlock('quote'), flagged(editor.isActive('blockquote'))),
        option('Code block', () => toggleBlock('code'), flagged(editor.isActive('codeBlock')))];
    case 'font':
      return fonts.map((font) => option(font, editorCommand('setFontFamily', font), { ...flagged((textStyle.fontFamily || cleanPage(current.page).font) === font), font }));
    case 'size':
      return [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72].map((size) => option(size + ' pt', editorCommand('setFontSize', size + 'pt'), flagged(textStyle.fontSize === size + 'pt')))
        .concat([null, option('Reset size', editorCommand('unsetFontSize'))]);
    case 'color':
    case 'highlight': {
      const highlighting = name === 'highlight';
      const names = highlighting ? highlightNames : colorNames;
      return [{ swatches: (highlighting ? highlights : colors).map((color, index) => option(names[index], highlighting ? editorCommand('setHighlight', { color }) : editorCommand('setColor', color), { color })) },
        option(highlighting ? 'Clear highlight' : 'Reset text color', editorCommand(highlighting ? 'unsetHighlight' : 'unsetColor'))];
    }
    case 'alignment':
      return ['left', 'center', 'right', 'justify'].map((alignment) => option(alignment[0].toUpperCase() + alignment.slice(1), editorCommand('setTextAlign', alignment), { icon: 'align-' + alignment, ...flagged(editor.isActive({ textAlign: alignment })) }));
    case 'spacing':
      return [1, 1.15, 1.5, 1.75, 2].map((spacing) => option(String(spacing), () => setSpacing(String(spacing)), flagged(editor.isActive({ lineSpacing: String(spacing) }))))
        .concat([null, option('Default spacing', () => setSpacing(null))]);
    case 'table': {
      const inTable = editor.isActive('table');
      const rows = [
        option('Insert table…', insertTable, { icon: 'table-2' }),
      ];
      if (inTable) rows.push(null, ...[
        ['Add row above', 'addRowBefore'], ['Add row below', 'addRowAfter'], ['Delete row', 'deleteRow'],
        ['Add column left', 'addColumnBefore'], ['Add column right', 'addColumnAfter'], ['Delete column', 'deleteColumn'],
        ['Toggle header row', 'toggleHeaderRow'], ['Merge selected cells', 'mergeCells'], ['Split cell', 'splitCell'],
        ['Delete table', 'deleteTable'],
      ].map(([label, command]) => option(label, editorCommand(command), { disabled: !editor.can()[command]() })));
      return rows;
    }
    case 'insert':
      return [
        option('Image…', insertImage, { icon: 'image' }),
        option('Link…', linkDialog, { icon: 'link-2', shortcut: 'Ctrl K' }),
        option('Checklist', editorCommand('toggleTaskList'), { icon: 'list-checks', ...flagged(editor.isActive('taskList')) }),
        option('Divider', editorCommand('setHorizontalRule'), { icon: 'minus' }),
        option('Page break', insertPageBreak, { icon: 'file', shortcut: 'Ctrl Enter' }), null,
        option('Strikethrough', editorCommand('toggleStrike'), { icon: 'strikethrough', ...flagged(editor.isActive('strike')) }),
        option('Subscript', editorCommand('toggleMark', 'subscript'), flagged(editor.isActive('subscript'))),
        option('Superscript', editorCommand('toggleMark', 'superscript'), flagged(editor.isActive('superscript'))),
        option('Clear character formatting', editorCommand('unsetAllMarks')),
      ];
    case 'view':
      return [
        option('Page setup…', pageDialog, { icon: 'file-text' }),
        option('Ruler', () => changeSettings({ ruler: !settings.ruler }), flagged(settings.ruler)),
        option('Focus mode', toggleFocus, { icon: 'scan-line', ...flagged(settings.focus) }),
        option('Keyboard shortcuts', help, { icon: 'circle-help' }),
        option('Settings…', settingsDialog, { icon: 'settings' }),
      ];
    case 'zoom':
      return [option('Fit to width', fitWidth), null, ...[50, 75, 90, 100, 125, 150, 200].map((zoom) => option(zoom + '%', () => changeSettings({ zoom }), flagged(settings.zoom === zoom)))];
    default:
      return [];
  }
}

function openMenu(anchor) {
  if (menuAnchor === anchor) return closeMenu();
  closeMenu();
  const options = menuOptions(anchor.dataset.menu, anchor);
  if (!options.length) return;
  menuAnchor = anchor;
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'true');

  function itemFor(item, swatch = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = swatch ? 'swatch' : 'menu-item' + (item.checked ? ' checked' : '');
    button.setAttribute('role', 'menuitem');
    button.disabled = Boolean(item.disabled);
    if (swatch) {
      button.style.backgroundColor = item.color;
      button.title = item.label;
      button.setAttribute('aria-label', item.label);
    } else {
      button.innerHTML = (item.icon ? icon(item.icon) : '') + '<span>' + escapeHTML(item.label) + '</span>'
        + (item.shortcut ? '<kbd>' + escapeHTML(item.shortcut) + '</kbd>' : item.checked ? icon('check') : '');
      if (item.font) button.style.fontFamily = item.font;
    }
    button.addEventListener('click', () => {
      closeMenu(true);
      run(item.run);
    });
    return button;
  }

  for (const option of options) {
    if (!option) {
      const separator = document.createElement('div');
      separator.className = 'menu-separator';
      separator.setAttribute('role', 'separator');
      menu.append(separator);
    } else if (option.swatches) {
      const group = document.createElement('div');
      group.className = 'swatch-grid';
      group.append(...option.swatches.map((swatch) => itemFor(swatch, true)));
      menu.append(group);
    } else menu.append(itemFor(option));
  }
  menu.hidden = false;
  const anchorBox = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchorBox.left, innerWidth - size.width - 8));
  const top = anchorBox.bottom + size.height + 5 < innerHeight ? anchorBox.bottom + 5 : Math.max(8, anchorBox.top - size.height - 5);
  Object.assign(menu.style, { left: left + 'px', top: top + 'px' });
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

function showDialog(title, body, callback, submit = 'Done') {
  closeMenu();
  if (dialog.open) dialog.close();
  dialog.innerHTML = '<form><div class="dialog-header"><h2 id="dialog-title">' + escapeHTML(title) + '</h2>'
    + '<button type="button" class="icon-button close-dialog" aria-label="Close dialog">' + icon('x') + '</button></div>'
    + '<div class="dialog-body">' + body + '</div>'
    + (submit ? '<div class="dialog-footer"><button type="button" class="button subtle cancel-dialog">Cancel</button><button class="button primary" type="submit">' + escapeHTML(submit) + '</button></div>' : '')
    + '</form>';
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  $$('.close-dialog,.cancel-dialog', dialog).forEach((element) => element.addEventListener('click', () => dialog.close()));
  const form = $('form', dialog);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!callback) return;
    const button = $('button[type=submit]', dialog);
    button.disabled = true;
    try {
      const afterClose = await callback(new FormData(form));
      if (afterClose === false) return;
      dialog.close();
      if (typeof afterClose === 'function') afterClose();
    } catch (error) { report(error); }
    finally { button.disabled = false; }
  });
  dialog.showModal();
  const input = $('input[autofocus]', dialog);
  if (input) { input.focus(); input.select(); }
}

function rename(record) {
  showDialog('Rename document', '<label>Name<input name="title" maxlength="140" required autofocus value="' + escapeHTML(record.title) + '"></label>', async (data) => {
    const title = String(data.get('title')).trim();
    if (!title) return false;
    await flush();
    const previous = { title: record.title, updated: record.updated };
    Object.assign(record, { title, updated: Date.now() });
    try { await persist(record); }
    catch (error) { Object.assign(record, previous); throw error; }
    if (record === current) renderTitle();
    renderDocuments();
  }, 'Rename');
}

async function duplicate(record) {
  await flush();
  await addRecord(makeDocument((record.title.slice(0, 133) + ' copy'), record.html, record.page));
  toast('Document duplicated.');
}

async function trash(record) {
  await flush();
  const next = record === current ? sortedDocuments().find((other) => other !== record) ?? await addRecord(makeDocument()) : null;
  const updated = { ...record, deleted: true, updated: Date.now() };
  await persist(updated);
  Object.assign(record, updated);
  if (next) await openRecord(next);
  renderDocuments();
  toast('Moved to trash. Restore it from document search.');
}

function library() {
  showDialog('Find a document', '<input id="library-query" type="search" autocomplete="off" placeholder="Search document names" aria-label="Search document names" autofocus><label class="setting"><span>Show trash</span><input id="library-trash" type="checkbox"></label><div class="library-results" id="library-results"></div>', null, null);
  const input = $('#library-query');
  const trashToggle = $('#library-trash');
  const results = $('#library-results');
  const render = () => {
    const records = sortedDocuments(trashToggle.checked).filter((record) => record.title.toLocaleLowerCase().includes(input.value.trim().toLocaleLowerCase()));
    results.replaceChildren();
    if (!records.length) results.innerHTML = '<p>' + (trashToggle.checked ? 'No documents in trash.' : 'No matching documents.') + '</p>';
    for (const record of records) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'library-result';
      button.innerHTML = icon('file-text') + '<span>' + escapeHTML(record.title) + '</span>' + (record.deleted ? '<span>Restore</span>' : '');
      button.addEventListener('click', () => run(async () => {
        if (record.deleted) {
          await persist({ ...record, deleted: false });
          record.deleted = false;
          renderDocuments();
          toast('Document restored.');
        }
        dialog.close();
        await openRecord(record);
      }));
      results.append(button);
    }
  };
  input.addEventListener('input', render);
  trashToggle.addEventListener('change', render);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && results.childElementCount === 1) {
      event.preventDefault();
      $('button', results)?.click();
    }
  });
  render();
}

function linkDialog() {
  const before = editor.state.selection;
  const target = editor.getAttributes('link').href || '';
  const label = before.empty && !target ? '<label>Text to display<input name="label" maxlength="250"></label>' : '';
  const remove = target ? '<button type="button" class="button subtle remove-link">' + icon('unlink') + 'Remove link</button>' : '';
  showDialog('Insert link', '<label>Web or email address<input name="href" maxlength="3000" autofocus placeholder="https://example.com" value="' + escapeHTML(target) + '" required></label>' + label + remove, (data) => {
    const href = safeLink(data.get('href'));
    if (!href) throw new Error('Enter a complete web address or a mailto link.');
    return () => {
      const command = editor.chain().focus().setTextSelection({ from: before.from, to: before.to });
      if (!before.empty || target) command.extendMarkRange('link').setLink({ href }).run();
      else command.insertContent({ type: 'text', text: String(data.get('label') || href), marks: [{ type: 'link', attrs: { href } }] }).run();
    };
  }, 'Apply');
  $('.remove-link', dialog)?.addEventListener('click', () => {
    dialog.close();
    editor.chain().focus().setTextSelection({ from: before.from, to: before.to }).extendMarkRange('link').unsetLink().run();
  });
}

function insertTable() {
  const selection = editor.state.selection;
  showDialog('Insert table', '<label>Columns<input name="columns" type="number" min="1" max="12" value="3" required autofocus></label>'
    + '<label>Rows<input name="rows" type="number" min="1" max="40" value="3" required></label>'
    + '<label class="setting"><span>Header row</span><input type="checkbox" name="header" checked></label>', (data) => () => {
    editor.chain().focus().setTextSelection({ from: selection.from, to: selection.to })
      .insertTable({ rows: Number(data.get('rows')), cols: Number(data.get('columns')), withHeaderRow: data.has('header') }).run();
  }, 'Insert');
}

function insertPageBreak() {
  editor.chain().focus().insertContent([{ type: 'pageBreak' }, { type: 'paragraph' }]).run();
}

function selectOptions(entries, currentValue) {
  return entries.map(([value, title]) => '<option value="' + escapeHTML(value) + '"' + (String(value) === String(currentValue) ? ' selected' : '') + '>' + escapeHTML(title) + '</option>').join('');
}

function pageDialog() {
  const record = current;
  const page = cleanPage(record.page);
  showDialog('Page setup', '<label>Paper size<select name="paper">' + selectOptions([['Letter', 'Letter (8.5 × 11 in)'], ['A4', 'A4 (210 × 297 mm)']], page.paper)
    + '</select></label><label>Orientation<select name="orientation">' + selectOptions([['portrait', 'Portrait'], ['landscape', 'Landscape']], page.landscape ? 'landscape' : 'portrait')
    + '</select></label><label>Page margins (inches)<input name="margin" type="number" step=".05" min=".35" max="1.6" required value="' + page.margin + '"></label>'
    + '<label>Document font<select name="font">' + selectOptions(fonts.map((font) => [font, font]), page.font) + '</select></label>', async (data) => {
    await flush();
    const change = cleanPage({ paper: data.get('paper'), landscape: data.get('orientation') === 'landscape', margin: data.get('margin'), font: data.get('font') });
    await persist({ ...record, page: change });
    record.page = change;
    renderPage();
    refreshToolbar();
  }, 'Apply');
}

function settingsDialog() {
  const checkbox = (name, label) => '<label class="setting"><span>' + label + '</span><input type="checkbox" name="' + name + '"' + (settings[name] ? ' checked' : '') + '></label>';
  showDialog('Settings', '<fieldset><legend>Appearance</legend><label class="setting"><span>Theme</span><select name="theme">'
    + selectOptions([['dark', 'Dark'], ['light', 'Light'], ['system', 'Match Windows']], settings.theme) + '</select></label>'
    + checkbox('ruler', 'Show ruler') + checkbox('outline', 'Show outline') + '</fieldset>'
    + '<fieldset><legend>Editing</legend><label class="setting"><span>Default font</span><select name="font">'
    + selectOptions(fonts.map((font) => [font, font]), settings.font) + '</select></label>' + checkbox('spellcheck', 'Spell check') + '</fieldset>',
  (data) => changeSettings({ theme: data.get('theme'), font: data.get('font'), ruler: data.has('ruler'), outline: data.has('outline'), spellcheck: data.has('spellcheck') }), 'Apply');
}

function help() {
  const shortcuts = [
    ['New document', 'Ctrl N'], ['Open file', 'Ctrl O'], ['Save Margin file', 'Ctrl S'], ['Save as', 'Ctrl Shift S'],
    ['Find and replace', 'Ctrl F'], ['Insert link', 'Ctrl K'], ['Page break', 'Ctrl Enter'], ['Print', 'Ctrl P'],
    ['Bold / italic / underline', 'Ctrl B / I / U'], ['Undo / redo', 'Ctrl Z / Y'], ['Focus mode', 'F11'],
  ];
  showDialog('Keyboard shortcuts', shortcuts.map(([action, shortcut]) => '<div class="shortcut-row"><span>' + action + '</span><kbd>' + shortcut + '</kbd></div>').join(''), null, null);
}

async function operation(label, work) {
  if (busy) return;
  busy = true;
  if (label) toast(label, 'info', 0);
  try {
    return await work();
  } finally {
    busy = false;
    if (label && $('#toast').textContent === label) $('#toast').hidden = true;
  }
}

async function loadFile(file) {
  if (!file) return;
  const take = 'Opening ' + file.name + '…';
  return operation(take, async () => {
    const parsed = await openDocument(file.name, file.data ?? await file.arrayBuffer(), (message) => toast(message, 'info', 0));
    const record = await addRecord(makeDocument(parsed.title, parsed.html, parsed.page ?? { font: settings.font }));
    if (file.association) {
      try { await desktop.claimFile(record.id, file.association); }
      catch { toast('Imported locally. Use Save As to save over the original file.', 'info', 6200); return; }
    }
    toast(parsed.note || 'Opened ' + file.name + '.', 'info', parsed.note ? 6900 : 2900);
  });
}

async function chooseDocument() {
  if (busy) return;
  if (desktop) {
    const file = await desktop.open();
    await loadFile(file);
  } else $('#open-input').click();
}

const blobDataURL = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

async function placeImage(file, expectedDocument, at) {
  if (!file || expectedDocument !== current.id) return;
  const blob = file instanceof File ? file : new Blob([fileBytes(file.data)], { type: file.mime });
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type) || blob.size > 14 * 1024 * 1024) throw new Error('Use a PNG, JPEG, WebP, or GIF image under 14 MB.');
  let bitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw new Error('The image could not be decoded.'); }
  if (bitmap.width * bitmap.height > 50_000_000) {
    bitmap.close();
    throw new Error('Use an image under 50 megapixels.');
  }
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  let embedded = blob;
  try {
    if (scale < 1) {
      const raster = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
      raster.getContext('2d').drawImage(bitmap, 0, 0, raster.width, raster.height);
      embedded = await raster.convertToBlob({ type: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', quality: .9 });
    }
  } finally { bitmap.close(); }
  const src = await blobDataURL(embedded);
  if (expectedDocument !== current.id) return;
  const command = editor.chain().focus();
  if (at != null) command.setTextSelection(Math.max(1, Math.min(at, editor.state.doc.content.size - 1)));
  command.setImage({ src, alt: file.name.replace(/\.[^.]+$/, '') }).run();
}

async function insertImage() {
  if (desktop) {
    const id = current.id;
    const file = await desktop.openImage();
    await placeImage(file, id);
  } else $('#image-input').click();
}

async function saveAs(format, copy = false) {
  return operation('', async () => {
    await flush();
    const record = structuredClone(current);
    if (format === 'pdf') {
      if (!desktop) throw new Error('Open Margin for Windows to export a PDF.');
      const saved = await desktop.pdf({ title: record.title, html: printDocument(record) });
      if (saved) toast('Exported ' + saved + '.');
      return;
    }
    const bytes = await exportDocument(format, record);
    if (desktop) {
      const saved = await desktop.save({ format, id: record.id, title: record.title, copy, bytes });
      if (saved) toast((format === 'margin' ? 'Saved ' : 'Exported ') + saved + '.');
    } else {
      downloadFile(record.title, format, bytes);
      toast('Downloaded ' + record.title + '.' + format + '.');
    }
  });
}

async function print() {
  if (!desktop) throw new Error('Open Margin for Windows to use the print dialog.');
  return operation('', async () => {
    await flush();
    const record = structuredClone(current);
    await desktop.print({ html: printDocument(record), ...cleanPage(record.page) });
  });
}

function toggleFocus() {
  changeSettings({ focus: !settings.focus });
}

function fitWidth() {
  const padding = innerWidth > 1000 ? 60 : 36;
  const zoom = Math.floor((canvas.clientWidth - padding - 3) / pageDimensions().width * 100);
  changeSettings({ zoom: normalizedZoom(zoom) });
}

function stepZoom(direction) {
  const currentZoom = normalizedZoom(settings.zoom);
  const steps = direction > 0 ? zoomSteps : [...zoomSteps].reverse();
  const zoom = steps.find((step) => direction > 0 ? step > currentZoom : step < currentZoom) ?? zoomSteps[direction > 0 ? zoomSteps.length - 1 : 0];
  changeSettings({ zoom });
}

const actions = {
  new: newDocument, open: chooseDocument, library, settings: settingsDialog, help,
  sidebar: () => changeSettings(settings.focus ? { focus: false, sidebar: true } : { sidebar: !settings.sidebar }),
  outline: () => changeSettings({ outline: !settings.outline }),
  find: showFind, 'close-find': closeFind,
  'previous-match': () => moveFind(-1), 'next-match': () => moveFind(1),
  'match-case': () => {
    matchCase = !matchCase;
    $('#match-case').setAttribute('aria-pressed', String(matchCase));
    runFind();
  },
  replace: () => replaceFound(false), 'replace-all': () => replaceFound(true),
  link: linkDialog, focus: toggleFocus,
  'zoom-in': () => stepZoom(1), 'zoom-out': () => stepZoom(-1),
};

function run(action) {
  Promise.resolve().then(action).catch(report);
}

document.addEventListener('pointerdown', (event) => {
  if (menuAnchor && !menu.contains(event.target) && !menuAnchor.contains(event.target)) closeMenu();
  if (event.target.closest('.toolbar [data-cmd], .toolbar [data-menu], .toolbar [data-action="link"]')) event.preventDefault();
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!editor || !button || button.disabled) return;
  if (button.dataset.menu) openMenu(button);
  else if (button.dataset.cmd) run(commands[button.dataset.cmd]);
  else if (button.dataset.action) run(actions[button.dataset.action]);
  else if (button.dataset.document) run(() => openRecord(documents.find((record) => record.id === button.dataset.document)));
  else if (button.dataset.heading !== undefined) {
    const position = Number(button.dataset.heading);
    const node = editor.view.nodeDOM(position);
    node?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    editor.commands.setTextSelection(position + 1);
  }
});

function inMenuKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu(true);
    return true;
  }
  if (event.key === 'Tab') { closeMenu(true); return false; }
  if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return false;
  event.preventDefault();
  const buttons = $$('button:not(:disabled)', menu);
  const index = Math.max(0, buttons.indexOf(document.activeElement));
  const delta = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + delta + buttons.length) % buttons.length;
  buttons[next]?.focus();
  return true;
}

document.addEventListener('keydown', (event) => {
  if (!editor || event.defaultPrevented || event.isComposing) return;
  if (menuAnchor && inMenuKey(event)) return;
  if (dialog.open) return;
  if (event.key === 'Escape') {
    if (!findBar.hidden) closeFind();
    else if (settings.focus) toggleFocus();
    return;
  }
  if (event.key === 'F11') { event.preventDefault(); toggleFocus(); return; }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  const shortcuts = {
    n: newDocument, o: chooseDocument, s: () => saveAs('margin', event.shiftKey), f: showFind,
    p: print, k: linkDialog, enter: insertPageBreak,
    '+': () => stepZoom(1), '=': () => stepZoom(1), '-': () => stepZoom(-1), '0': () => changeSettings({ zoom: 100 }),
  };
  if (shortcuts[key]) { event.preventDefault(); run(shortcuts[key]); }
}, { capture: true });

findInput.addEventListener('input', runFind);
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && editor) { event.preventDefault(); moveFind(event.shiftKey ? -1 : 1); }
});
replaceInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && editor) { event.preventDefault(); replaceFound(false); }
});

$('#open-input').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  run(() => loadFile(file));
});
$('#image-input').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) run(() => placeImage(file, current.id));
});

document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  if (event.target.closest('#canvas')) root.dataset.drop = 'true';
});
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget?.closest?.('#canvas')) delete root.dataset.drop;
});
document.addEventListener('drop', (event) => {
  const file = event.dataTransfer.files[0];
  if (!file || !editor) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  delete root.dataset.drop;
  if (/^image\//.test(file.type)) {
    const pos = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
    run(() => placeImage(file, current.id, pos));
  } else run(() => loadFile(file));
}, { capture: true });

surface.addEventListener('paste', (event) => {
  const clipboard = event.clipboardData;
  if (clipboard.getData('text/html') || clipboard.getData('text/plain')) return;
  const image = [...clipboard.files].find((file) => file.type.startsWith('image/'));
  if (!image) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  run(() => placeImage(image, current.id));
}, { capture: true });

function protectDraft() {
  const record = checkpoint();
  if (record) journal(record);
}

window.addEventListener('pagehide', protectDraft);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  protectDraft();
  if (workspace) flush().catch(() => {});
});
window.addEventListener('resize', () => closeMenu());
systemLight.addEventListener('change', () => { if (settings.theme === 'system') applySettings(); });

if (desktop) {
  const positionSystemButtons = () => {
    const overlay = navigator.windowControlsOverlay;
    const measured = overlay?.getTitlebarAreaRect()?.width;
    const reserved = overlay?.visible && measured > 0 ? Math.max(0, innerWidth - measured) : 137;
    root.style.setProperty('--system-buttons', reserved + 'px');
  };
  positionSystemButtons();
  navigator.windowControlsOverlay?.addEventListener('geometrychange', positionSystemButtons);
  window.addEventListener('resize', positionSystemButtons);
  desktop.onFile((file) => run(() => loadFile(file)));
  desktop.onClose(() => {
    protectDraft();
    flush().then(() => desktop.closeReady(true), (error) => {
      report(error);
      return desktop.closeReady(false);
    }).catch(report);
  });
}

applySettings();
run(async () => {
  workspace = await startStore();
  documents = workspace.documents;
  const initial = documents.find((record) => !record.deleted && record.id === activeId()) || sortedDocuments()[0];
  if (initial) await openRecord(initial);
  else await newDocument();
  const files = await desktop?.ready();
  if (files?.length) for (const file of files) {
    try { await loadFile(file); }
    catch (error) { report(error); }
  }
});
