import { Editor, Extension, Mark, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TextAlign } from '@tiptap/extension-text-align';
import { Highlight } from '@tiptap/extension-highlight';
import { Image } from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { cleanHTML, safeLink } from './formats.js';

const searchKey = new PluginKey('marginFind');

function scanDocument(doc, query, matchCase) {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(escaped, matchCase ? 'gu' : 'giu');
  const matches = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) return true;
    let text = '';
    const offsets = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        if (offset !== text.length) {
          text += '\n';
          offsets.push(null);
        }
        for (let i = 0; i < child.text.length; i++) offsets.push(position + 1 + offset + i);
        text += child.text;
      } else {
        text += '\u0000'.repeat(child.nodeSize);
        for (let i = 0; i < child.nodeSize; i++) offsets.push(null);
      }
    });
    for (const match of text.matchAll(expression)) {
      const start = offsets[match.index];
      const last = offsets[match.index + match[0].length - 1];
      if (start != null && last != null && last - start + 1 === match[0].length) matches.push({ from: start, to: last + 1 });
    }
    return false;
  });
  return matches;
}

const Search = Extension.create({
  name: 'marginSearch',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: searchKey,
      state: {
        init: () => ({ query: '', matchCase: false, index: 0, matches: [], decorations: DecorationSet.empty }),
        apply(transaction, previous) {
          const update = transaction.getMeta(searchKey);
          if (!update && !(transaction.docChanged && previous.query)) return previous;
          const merged = { ...previous, ...update };
          const matches = update?.query === undefined && update?.matchCase === undefined && !transaction.docChanged
            ? previous.matches : scanDocument(transaction.doc, merged.query, merged.matchCase);
          const index = matches.length ? (merged.index % matches.length + matches.length) % matches.length : 0;
          const decorations = DecorationSet.create(transaction.doc, matches.map(({ from, to }, matchIndex) => Decoration.inline(from, to, {
            class: index === matchIndex ? 'search-hit search-hit-current' : 'search-hit',
          })));
          return { ...merged, matches, index, decorations };
        },
      },
      props: { decorations: (state) => searchKey.getState(state).decorations },
    })];
  },
});

const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div[data-page-break]' }],
  renderHTML: () => ['div', { 'data-page-break': 'true' }],
});

const LineSpacing = Extension.create({
  name: 'marginLineSpacing',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        lineSpacing: {
          default: null,
          parseHTML: (element) => element.style.lineHeight || null,
          renderHTML: (attributes) => attributes.lineSpacing ? { style: 'line-height:' + attributes.lineSpacing } : {},
        },
      },
    }];
  },
});

const scriptMark = (name, tag) => Mark.create({
  name, excludes: name === 'subscript' ? 'superscript' : 'subscript',
  parseHTML: () => [{ tag }],
  renderHTML: () => [tag, 0],
});

export function makeEditor(element, content, spellcheck, callbacks) {
  return new Editor({
    element, content, autofocus: false, injectCSS: false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, isAllowedUri: (url) => Boolean(safeLink(url)) } }),
      TextStyleKit.configure({ lineHeight: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: true }),
      TaskList, TaskItem.configure({ nested: true }),
      Image.configure({ allowBase64: true }),
      TableKit.configure({ table: { resizable: true } }),
      PageBreak, LineSpacing, Search, scriptMark('subscript', 'sub'), scriptMark('superscript', 'sup'),
    ],
    editorProps: {
      attributes: { spellcheck: String(spellcheck), role: 'textbox', 'aria-label': 'Document editor', 'aria-multiline': 'true' },
      transformPastedHTML: cleanHTML,
      handleDOMEvents: {
        click(_view, event) {
          const link = event.target.closest?.('a[href]');
          if (link && (event.ctrlKey || event.metaKey)) {
            const href = safeLink(link.href);
            if (href) callbacks.openLink(href);
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
    onUpdate: callbacks.update,
    onTransaction: callbacks.transaction,
  });
}

export const searchState = (editor) => searchKey.getState(editor.state);

export function updateSearch(editor, data, scroll = true) {
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, data).setMeta('addToHistory', false));
  if (scroll) editor.view.dom.querySelector('.search-hit-current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function replaceSearch(editor, replacement, all) {
  const { matches, index } = searchState(editor);
  if (!matches.length) return 0;
  const targets = all ? [...matches].reverse() : [matches[index]];
  const transaction = editor.state.tr;
  for (const { from, to } of targets) transaction.insertText(replacement, from, to);
  editor.view.dispatch(transaction);
  return targets.length;
}
