import DOMPurify from 'dompurify';
import { cleanPage } from './store.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const mime = {
  margin: 'application/json', html: 'text/html', md: 'text/markdown',
  txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf',
};

export const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const fileBytes = (value) => ArrayBuffer.isView(value)
  ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  : new Uint8Array(value?.data ?? value);

export function safeLink(value) {
  try {
    const url = new URL(String(value).trim());
    return /^(https?:|mailto:)$/.test(url.protocol) ? url.href : null;
  } catch { return null; }
}

const safeStyles = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'text-align', 'text-decoration', 'text-decoration-line'];
const safeImage = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

export function cleanHTML(html) {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    ALLOWED_TAGS: ['p', 'address', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'hr', 'pre', 'code', 'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'span', 'div', 'br', 'mark', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col', 'sub', 'sup'],
    ALLOWED_ATTR: ['style', 'href', 'title', 'src', 'alt', 'start', 'colspan', 'rowspan', 'colwidth', 'width', 'height', 'data-colwidth', 'data-type', 'data-checked', 'data-color', 'data-page-break'],
  });
  for (const element of fragment.querySelectorAll('[style]')) {
    const style = element.style;
    const preserved = safeStyles.map((property) => [property, style.getPropertyValue(property)])
      .filter(([, value]) => value && !/[()]/.test(value.replace(/(?:rgb|rgba)\([\d,. %]+\)/gi, '')));
    element.removeAttribute('style');
    for (const [property, value] of preserved) element.style.setProperty(property, value);
  }
  for (const link of fragment.querySelectorAll('a')) {
    const href = safeLink(link.getAttribute('href'));
    if (href) link.setAttribute('href', href);
    else link.removeAttribute('href');
  }
  for (const image of fragment.querySelectorAll('img')) {
    if (!safeImage.test(image.getAttribute('src') ?? '')) image.replaceWith(document.createTextNode(image.alt ? '[' + image.alt + ']' : ''));
  }
  const output = document.createElement('div');
  output.append(fragment);
  return output.innerHTML || '<p></p>';
}

function plainHTML(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
    .map((line) => '<p>' + escapeHTML(line) + '</p>').join('');
}

function plainText(html) {
  const root = new DOMParser().parseFromString(html, 'text/html').body;
  for (const line of root.querySelectorAll('br')) line.replaceWith('\n');
  for (const cell of root.querySelectorAll('td,th')) if (cell.nextElementSibling) cell.append('\t');
  for (const block of root.querySelectorAll('p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,tr,hr')) {
    if (!(block.matches('p') && block.parentElement.matches('li,td,th'))) block.append('\n');
  }
  return root.textContent.replace(/^\n+|\n+$/g, '') + '\n';
}

export async function unzipDocument(bytes, readFiles = true) {
  const { unzipSync } = await import('fflate');
  let expanded = 0;
  return unzipSync(bytes, {
    filter: (file) => {
      expanded += file.originalSize;
      if (expanded > 130 * 1024 * 1024) throw new Error('The contents of this document are too large.');
      return typeof readFiles === 'function' ? readFiles(file.name) : readFiles;
    },
  });
}

function wordPage(xml) {
  if (!xml) return undefined;
  const document = new DOMParser().parseFromString(decoder.decode(xml), 'application/xml');
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const section = Array.from(document.getElementsByTagNameNS(ns, 'sectPr')).at(-1);
  const size = section?.getElementsByTagNameNS(ns, 'pgSz')[0];
  if (!size) return undefined;
  const width = Number(size.getAttributeNS(ns, 'w')) || 12240;
  const height = Number(size.getAttributeNS(ns, 'h')) || 15840;
  const dimensions = section.getElementsByTagNameNS(ns, 'pgMar')[0];
  const margins = ['left', 'right', 'top', 'bottom'].map((side) => Number(dimensions?.getAttributeNS(ns, side)) / 1440)
    .filter((value) => value > 0);
  return cleanPage({
    paper: Math.abs(Math.min(width, height) - 11906) < Math.abs(Math.min(width, height) - 12240) ? 'A4' : 'Letter',
    landscape: width > height || size.getAttributeNS(ns, 'orient') === 'landscape',
    margin: margins.length ? Math.round(margins.reduce((sum, value) => sum + value, 0) / margins.length * 20) / 20 : 1,
  });
}

export async function openDocument(name, data, onProgress) {
  const bytes = fileBytes(data);
  if (!bytes.length) throw new Error('This file is empty.');
  if (bytes.length > 48 * 1024 * 1024) throw new Error('This file exceeds the 48 MB import limit.');
  const extension = name.split('.').at(-1).toLowerCase();
  const title = name.replace(/\.[^.]+$/, '') || 'Imported document';
  let parsed;
  switch (extension) {
    case 'margin': {
      const value = JSON.parse(decoder.decode(bytes));
      if (value?.format !== 'margin' || value.version !== 1 || typeof value.html !== 'string') throw new Error('This file is not a supported Margin document.');
      parsed = { html: value.html, title: typeof value.title === 'string' ? value.title.trim().slice(0, 140) || title : title, page: cleanPage(value.page) };
      break;
    }
    case 'docx': {
      const parts = await unzipDocument(bytes, (name) => name === 'word/document.xml');
      const { default: mammoth } = await import('mammoth/mammoth.browser.js');
      const output = await mammoth.convertToHtml({ arrayBuffer: bytes.slice().buffer }, {
        styleMap: ['u => u', 'strike => s'],
      });
      parsed = { html: output.value, page: wordPage(parts['word/document.xml']), note: output.messages.some(({ type }) => type === 'warning') ? 'Some Word-specific formatting was simplified.' : undefined };
      break;
    }
    case 'odt': {
      const { fromODT } = await import('./odt.js');
      parsed = { html: await fromODT(bytes) };
      break;
    }
    case 'pdf': {
      const { fromPDF } = await import('./pdf.js');
      parsed = await fromPDF(bytes, onProgress);
      break;
    }
    case 'md':
    case 'markdown': {
      const { marked } = await import('marked');
      const html = await marked.parse(decoder.decode(bytes).replace(/^\uFEFF/, ''));
      const root = new DOMParser().parseFromString(html, 'text/html').body;
      for (const input of root.querySelectorAll('li input[type=checkbox]')) {
        const li = input.closest('li');
        li.setAttribute('data-type', 'taskItem');
        li.setAttribute('data-checked', String(input.checked));
        const list = li.parentElement;
        if ([...list.children].every((child) => child.hasAttribute('data-type') || child.querySelector(':scope > input[type=checkbox]'))) list.setAttribute('data-type', 'taskList');
        input.remove();
      }
      parsed = { html: root.innerHTML };
      break;
    }
    case 'txt':
      parsed = { html: plainHTML(decodeText(bytes)) };
      break;
    case 'htm':
    case 'html':
      parsed = { html: new DOMParser().parseFromString(decodeText(bytes), 'text/html').body.innerHTML };
      break;
    default:
      throw new Error('Open a Margin, Word, OpenDocument, PDF, Markdown, HTML, or plain-text file.');
  }
  return { ...parsed, title: parsed.title || title.slice(0, 140), html: cleanHTML(parsed.html), extension };
}

function decodeText(bytes) {
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

export async function exportDocument(format, record) {
  const html = cleanHTML(record.html);
  if (format === 'margin') return encoder.encode(JSON.stringify({ format: 'margin', version: 1, title: record.title, html, page: cleanPage(record.page) }, null, 2));
  if (format === 'txt') return encoder.encode(plainText(html));
  if (format === 'html') return encoder.encode(printDocument({ ...record, html }));
  if (format === 'docx') {
    const { toDOCX } = await import('./word.js');
    return toDOCX(html, record.title, record.page);
  }
  if (format === 'md') {
    const [{ default: Turndown }, { gfm }] = await Promise.all([import('turndown'), import('turndown-plugin-gfm')]);
    const converter = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    converter.use(gfm);
    converter.addRule('margin-task', {
      filter: (node) => node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem',
      replacement: (content, node) => '- [' + (node.getAttribute('data-checked') === 'true' ? 'x' : ' ') + '] ' + content.trim().replace(/\n/g, '\n  ') + '\n',
    });
    converter.addRule('inline-image', { filter: 'img', replacement: (_content, node) => node.outerHTML });
    return encoder.encode(converter.turndown(html) + '\n');
  }
  throw new Error('Unknown export format.');
}

export function printDocument(record) {
  const page = cleanPage(record.page);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(record.title)}</title><style>
@page{size:${page.paper} ${page.landscape ? 'landscape' : 'portrait'};margin:${page.margin}in}
*{box-sizing:border-box}body{margin:2rem auto;padding:0 1rem;max-width:8.5in;color:#292532;background:#fff;font:12pt/1.6 "${page.font}",serif;overflow-wrap:anywhere}
@media print{body{margin:0;padding:0;max-width:none}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}[data-page-break]{break-after:page}}
main>:first-child{margin-top:0}p{margin:0 0 .75em;orphans:2;widows:2}
h1,h2,h3,h4,h5,h6{line-height:1.12;margin:1.2em 0 .4em;break-after:avoid;font-weight:600}h1{font-size:3.45em;font-weight:500;line-height:1.03;letter-spacing:-.065em}h2{font-size:1.55em;letter-spacing:-.035em}h3{font-size:1.22em}
blockquote{border-left:3px solid #a287e3;background:#f7f4fd;color:#4b385f;margin:1.45em 0 1.6em;padding:.7em 1.05em;font-style:italic}
blockquote :last-child,li>:last-child,td>:last-child,th>:last-child{margin-bottom:0}
a{color:#6444a8}ul,ol{margin:.4em 0 .9em;padding-left:1.5em}li{margin:.24em 0}li::marker{color:#7557b3}
ul[data-type=taskList]{list-style:none;padding-left:0}li[data-type=taskItem]{display:flex;gap:.4em}li[data-type=taskItem]::before{content:'☐'}li[data-checked=true]::before{content:'☑'}
img{display:block;max-width:100%;max-height:8in;height:auto;margin:1em 0;break-inside:avoid}
hr{border:0;border-top:1px solid #d8d2e2;margin:1.5em 0}
pre{white-space:pre-wrap;background:#f4f1f8;padding:.8em 1em}
table{width:100%;border-collapse:collapse;table-layout:fixed;margin:1em 0;font-size:.94em}tr{break-inside:avoid}td,th{border:1px solid #ddd7e8;padding:.45em .65em;vertical-align:top}th{background:#f3effa;text-align:left}
</style></head><body><main>${cleanHTML(record.html)}</main></body></html>`;
}

export function downloadFile(name, format, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime[format] }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name + '.' + format;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
