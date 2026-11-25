import { strToU8, zipSync } from 'fflate';
import { escapeHTML } from './formats.js';
import { cleanPage } from './store.js';

const MIME = 'application/vnd.oasis.opendocument.text';
const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const namespaces = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  dc: 'http://purl.org/dc/elements/1.1/',
};

const xmlText = (text) => escapeHTML(String(text).replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, ''));
const attrs = (values) => Object.entries(values).filter(([, value]) => value != null)
  .map(([name, value]) => ' ' + name + '="' + xmlText(value) + '"').join('');
const tag = (name, properties, contents) => '<' + name + attrs(properties) + (contents == null ? '/>' : '>' + contents + '</' + name + '>');
const styleUse = (name) => ({ 'text:style-name': name });

function documentXML(kind, body) {
  const declarations = Object.fromEntries(Object.entries(namespaces).map(([prefix, uri]) => ['xmlns:' + prefix, uri]));
  return XML + tag('office:document-' + kind, { ...declarations, 'office:version': '1.2' }, body);
}

function xmlSpaces(text) {
  const chunks = text.split(/( +|[\n\t])/);
  return chunks.map((chunk, index) => {
    if (chunk === '\n') return '<text:line-break/>';
    if (chunk === '\t') return '<text:tab/>';
    if (/^ +$/.test(chunk) && (chunk.length > 1 || !chunks[index - 1] || !chunks[index + 1])) {
      return tag('text:s', { 'text:c': chunk.length > 1 ? chunk.length : null });
    }
    return xmlText(chunk);
  }).join('');
}

function odfColor(value) {
  if (/^#[a-f0-9]{6}$/i.test(value)) return value;
  if (/^#[a-f0-9]{3}$/i.test(value)) return '#' + [...value.slice(1)].map((digit) => digit.repeat(2)).join('');
  const rgb = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgb && Number(rgb[4] ?? 1) > 0) return '#' + rgb.slice(1, 4).map((channel) => Math.min(255, Number(channel)).toString(16).padStart(2, '0')).join('');
  return null;
}

function paragraphStyle(name, paragraph = {}, text = {}, parent = null, extra = {}) {
  const properties = (kind, values) => Object.values(values).some((value) => value != null) ? tag('style:' + kind + '-properties', values) : '';
  return tag('style:style', { 'style:name': name, 'style:family': 'paragraph', 'style:parent-style-name': parent, ...extra },
    properties('paragraph', paragraph) + properties('text', text));
}

function listStyle(name, marker) {
  const levels = Array.from({ length: 10 }, (_, index) => {
    const spacing = tag('style:list-level-properties', { 'text:space-before': (index * .19 + .16).toFixed(2) + 'in', 'text:min-label-width': '.22in' });
    const level = { 'text:level': index + 1 };
    return marker === 'number'
      ? tag('text:list-level-style-number', { ...level, 'style:num-format': '1', 'style:num-suffix': '.' }, spacing)
      : tag('text:list-level-style-bullet', { ...level, 'text:bullet-char': marker }, spacing);
  }).join('');
  return tag('text:list-style', { 'style:name': name }, levels);
}

export async function toODT(html, title, rawPage) {
  const page = cleanPage(rawPage);
  const short = page.paper === 'A4' ? 210 / 25.4 : 8.5;
  const long = page.paper === 'A4' ? 297 / 25.4 : 11;
  const width = page.landscape ? long : short;
  const height = page.landscape ? short : long;
  const fonts = new Set([page.font, 'Consolas']);
  const images = [];
  const automatic = new Map();
  const root = new DOMParser().parseFromString(html, 'text/html').body;
  let tableId = 0;

  function automaticStyle(kind, properties, parent = null, paragraph = {}) {
    const present = Object.values(properties).some((value) => value != null) || Object.values(paragraph).some((value) => value != null);
    if (!present) return parent;
    const key = JSON.stringify([kind, parent, properties, paragraph]);
    if (!automatic.has(key)) {
      const name = 'M' + (automatic.size + 1);
      const content = kind === 'paragraph' ? paragraphStyle(name, paragraph, properties, parent) :
        tag('style:style', { 'style:name': name, 'style:family': kind }, tag('style:' + kind + '-properties', properties));
      automatic.set(key, { name, content });
    }
    return automatic.get(key).name;
  }

  function textProperties(node) {
    const name = node.localName;
    const css = node.style;
    const font = (css.fontFamily.split(',')[0].replace(/["']/g, '').trim().slice(0, 80)) || (name === 'code' ? 'Consolas' : '');
    if (font) fonts.add(font);
    const size = /^(\d+(?:\.\d+)?)(pt|px)$/.exec(css.fontSize);
    const decorations = css.textDecoration + ' ' + css.textDecorationLine;
    const underline = name === 'u' || decorations.includes('underline');
    const strike = ['s', 'strike', 'del'].includes(name) || decorations.includes('line-through');
    const bold = ['b', 'strong'].includes(name) || css.fontWeight === 'bold' || Number(css.fontWeight) >= 600;
    const italic = ['i', 'em'].includes(name) || css.fontStyle === 'italic';
    return {
      'style:font-name': font || null,
      'fo:font-size': size ? (Number(size[1]) * (size[2] === 'px' ? .75 : 1)).toFixed(2) + 'pt' : null,
      'fo:font-weight': bold ? 'bold' : css.fontWeight === 'normal' ? 'normal' : null,
      'fo:font-style': italic ? 'italic' : css.fontStyle === 'normal' ? 'normal' : null,
      'fo:color': odfColor(css.color),
      'fo:background-color': odfColor(css.backgroundColor || node.getAttribute('data-color') || '') || (name === 'mark' ? '#f7ebbb' : null),
      'style:text-underline-style': underline ? 'solid' : null,
      'style:text-line-through-style': strike ? 'solid' : null,
      'style:text-position': name === 'sub' ? 'sub 58%' : name === 'sup' ? 'super 58%' : null,
    };
  }

  async function image(node) {
    const [, kind, source] = /^data:image\/(png|jpeg|gif|webp);base64,([\w+/=\s]+)$/i.exec(node.src) ?? [];
    if (!source) return xmlText(node.alt ?? '');
    const type = kind.toLowerCase();
    let mediaType = 'image/' + type;
    let bytes = Uint8Array.from(atob(source), (character) => character.charCodeAt(0));
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType }));
      const scale = Math.min(1, (width - 2 * page.margin) * 96 / bitmap.width, (height - 2 * page.margin - .3) * 96 / bitmap.height);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      if (type === 'webp') {
        const raster = new OffscreenCanvas(w, h);
        raster.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        bytes = new Uint8Array(await (await raster.convertToBlob({ type: 'image/png' })).arrayBuffer());
        mediaType = 'image/png';
      }
      const path = 'Pictures/Image' + (images.length + 1) + '.' + mediaType.split('/')[1];
      images.push({ path, mediaType, bytes });
      const content = tag('draw:image', { 'xlink:href': path, 'xlink:type': 'simple', 'xlink:show': 'embed', 'xlink:actuate': 'onLoad' })
        + (node.alt ? tag('svg:title', {}, xmlText(node.alt)) : '');
      return tag('draw:frame', { 'draw:name': 'Image ' + images.length, 'text:anchor-type': 'as-char', 'svg:width': (w / 96).toFixed(3) + 'in', 'svg:height': (h / 96).toFixed(3) + 'in' }, content);
    } catch {
      return xmlText(node.alt || '[Image]');
    } finally { bitmap?.close(); }
  }

  async function inline(nodes) {
    let result = '';
    for (const node of nodes) {
      if (node.nodeType === 3) result += xmlSpaces(node.nodeValue);
      if (node.nodeType !== 1) continue;
      if (node.matches('br')) result += '<text:line-break/>';
      else if (node.matches('img')) result += await image(node);
      else {
        let content = await inline(node.childNodes);
        const style = automaticStyle('text', textProperties(node));
        if (style) content = tag('text:span', styleUse(style), content);
        if (node.matches('a[href]')) content = tag('text:a', { 'xlink:type': 'simple', 'xlink:href': node.getAttribute('href') }, content);
        result += content;
      }
    }
    return result;
  }

  async function list(node) {
    const task = node.getAttribute('data-type') === 'taskList';
    const ordered = node.matches('ol');
    const start = Number(node.getAttribute('start')) || 1;
    const items = [];
    for (const item of node.children) {
      const parts = [...item.childNodes].filter((child) => child.nodeType !== 1 || !child.matches('label'));
      let result;
      if (task) {
        const mark = item.getAttribute('data-checked') === 'true' ? '☑' : '☐';
        const content = parts.flatMap((part) => part.nodeType === 1 && part.matches('div') ? [...part.childNodes] : [part]);
        result = await blocks(content, 'Body', mark + ' ');
      } else result = await blocks(parts);
      items.push(tag('text:list-item', { 'text:start-value': ordered && items.length === 0 && start !== 1 ? Math.max(0, start) : null }, result));
    }
    return tag('text:list', styleUse(task ? 'MarginTasks' : ordered ? 'MarginNumber' : 'MarginBullet'), items.join(''));
  }

  async function table(node) {
    const rows = [...node.rows];
    const grid = rows.map(() => []);
    let headerRows = 0;
    let leadingHeaders = true;
    const columnRatios = [];
    for (const [rowIndex, row] of rows.entries()) {
      if (leadingHeaders && row.cells.length && [...row.cells].every((cell) => cell.matches('th') && cell.rowSpan === 1)) headerRows++;
      else leadingHeaders = false;
      let column = 0;
      for (const cell of row.cells) {
        const cols = Math.min(cell.colSpan, 100);
        const rowSpan = Math.min(cell.rowSpan || rows.length, rows.length - rowIndex);
        while (Array.from({ length: cols }, (_, index) => grid[rowIndex][column + index]).some((slot) => slot !== undefined)) column++;
        grid[rowIndex][column] = { cell, cols, rows: rowSpan };
        const sizes = (cell.getAttribute('data-colwidth') || '').split(',').map(Number);
        for (let x = 0; x < cols; x++) {
          if (sizes[x] > 0 && !columnRatios[column + x]) columnRatios[column + x] = sizes[x];
          for (let y = 0; y < rowSpan; y++) {
            if (x || y) grid[rowIndex + y][column + x] = null;
          }
        }
        column += cols;
      }
    }
    const count = grid.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    if (!count) return '';
    const columns = Array.from({ length: count }, (_, index) => {
      const style = automaticStyle('table-column', { 'style:rel-column-width': (Math.round(columnRatios[index]) || 100) + '*' });
      return tag('table:table-column', { 'table:style-name': style });
    }).join('');
    const content = [];
    for (const row of grid) {
      let cells = '';
      for (let column = 0; column < count; column++) {
        const slot = row[column];
        if (slot === null) cells += '<table:covered-table-cell/>';
        else {
          const header = slot?.cell.matches('th');
          cells += tag('table:table-cell', { 'table:style-name': header ? 'HeaderCell' : 'BodyCell',
            'table:number-columns-spanned': slot?.cols > 1 ? slot.cols : null,
            'table:number-rows-spanned': slot?.rows > 1 ? slot.rows : null,
            'office:value-type': 'string',
          }, slot ? await blocks(slot.cell.childNodes, header ? 'TableHeader' : 'Body') : '<text:p/>');
        }
      }
      content.push(tag('table:table-row', {}, cells));
    }
    const headers = headerRows ? tag('table:table-header-rows', {}, content.slice(0, headerRows).join('')) : '';
    return tag('table:table', { 'table:name': 'Table ' + ++tableId, 'table:style-name': 'MarginTable' }, columns + headers + content.slice(headerRows).join(''));
  }

  async function blocks(nodes, base = 'Body', prefix = '') {
    const parts = [];
    const takePrefix = () => {
      const result = xmlSpaces(prefix);
      prefix = '';
      return result;
    };
    for (const node of nodes) {
      if (node.nodeType === 3 && node.nodeValue.trim()) parts.push(tag('text:p', styleUse(base), takePrefix() + xmlSpaces(node.nodeValue.trim())));
      if (node.nodeType !== 1) continue;
      if (node.matches('table')) parts.push(await table(node));
      else if (node.matches('ul,ol')) parts.push(await list(node));
      else if (node.matches('blockquote') || node.matches('div:not([data-page-break])')) parts.push(await blocks(node.childNodes, node.matches('blockquote') ? 'Quote' : base));
      else if (node.matches('[data-page-break],hr')) parts.push(tag('text:p', styleUse(node.matches('hr') ? 'Rule' : 'PageBreak')));
      else {
        const heading = /^h[1-6]$/.test(node.localName) ? Number(node.localName[1]) : null;
        const parent = heading ? 'Heading' + heading : node.matches('pre') ? 'CodeBlock' : base;
        const line = node.style.lineHeight;
        const style = automaticStyle('paragraph', textProperties(node), parent, {
          'fo:text-align': ['left', 'center', 'right', 'justify'].includes(node.style.textAlign) ? node.style.textAlign : null,
          'fo:line-height': /^\d+(\.\d+)?$/.test(line) ? Math.round(Number(line) * 100) + '%' : line || null,
        });
        const content = node.matches('img') ? await image(node) : await inline(node.childNodes);
        parts.push(tag(heading ? 'text:h' : 'text:p', { ...styleUse(style), 'text:outline-level': heading }, takePrefix() + content));
      }
    }
    if (prefix) parts.unshift(tag('text:p', styleUse(base), takePrefix()));
    return parts.join('') || '<text:p/>';
  }

  const content = await blocks(root.childNodes);
  const fontKeys = tag('office:font-face-decls', {}, [...fonts].map((family) =>
    tag('style:font-face', { 'style:name': family, 'svg:font-family': "'" + family.replace(/'/g, '') + "'" })).join(''));
  const headers = [41, 19, 15, 13, 12, 11].map((size, index) => paragraphStyle('Heading' + (index + 1), {
    'fo:margin-top': index ? '12pt' : '0pt', 'fo:margin-bottom': index ? '5pt' : '12pt', 'fo:keep-with-next': 'always', 'fo:line-height': '112%',
  }, { 'fo:font-size': size + 'pt', 'fo:font-weight': index ? 'bold' : 'normal' }, 'Body', { 'style:default-outline-level': index + 1 })).join('');
  const paragraphs = paragraphStyle('Body', { 'fo:line-height': '150%', 'fo:margin-bottom': '8pt' })
    + paragraphStyle('Quote', { 'fo:border-left': '0.02in solid #999995', 'fo:padding-left': '.12in', 'fo:margin-top': '7pt', 'fo:background-color': '#f4f4f2' }, { 'fo:font-style': 'italic', 'fo:color': '#494947' }, 'Body')
    + paragraphStyle('CodeBlock', { 'fo:background-color': '#f2f3f0' }, { 'style:font-name': 'Consolas', 'fo:font-size': '10pt' }, 'Body')
    + paragraphStyle('PageBreak', { 'fo:break-before': 'page', 'fo:line-height': '2pt', 'fo:margin-bottom': '0pt' }, { 'fo:font-size': '1pt' }, 'Body')
    + paragraphStyle('Rule', { 'fo:border-bottom': '0.01in solid #d8d8d4' }, {}, 'Body')
    + paragraphStyle('TableHeader', {}, { 'fo:font-weight': 'bold' }, 'Body');
  const defaults = tag('style:default-style', { 'style:family': 'paragraph' },
    tag('style:text-properties', { 'style:font-name': page.font, 'fo:font-size': '12pt', 'fo:color': '#252525' }));
  const layout = tag('style:page-layout', { 'style:name': 'MarginPage' }, tag('style:page-layout-properties', {
    'fo:page-width': width.toFixed(3) + 'in', 'fo:page-height': height.toFixed(3) + 'in', 'fo:margin': page.margin + 'in',
    'style:print-orientation': page.landscape ? 'landscape' : 'portrait',
  }));
  const tableStyle = tag('style:style', { 'style:name': 'MarginTable', 'style:family': 'table' }, tag('style:table-properties', { 'table:align': 'margins' }));
  const cellStyles = ['BodyCell', 'HeaderCell'].map((name) => tag('style:style', { 'style:name': name, 'style:family': 'table-cell' },
    tag('style:table-cell-properties', { 'fo:border': '0.01in solid #dcdcd8', 'fo:padding': '.07in', 'fo:background-color': name === 'HeaderCell' ? '#f1f1ee' : null }))).join('');
  const sharedStyles = tag('office:styles', {}, defaults + paragraphs + headers + tableStyle + cellStyles
    + listStyle('MarginBullet', '•') + listStyle('MarginNumber', 'number') + listStyle('MarginTasks', ' '));
  const common = documentXML('styles', fontKeys + sharedStyles + tag('office:automatic-styles', {}, layout)
    + tag('office:master-styles', {}, tag('style:master-page', { 'style:name': 'Standard', 'style:page-layout-name': 'MarginPage' })));
  const body = documentXML('content', fontKeys + tag('office:automatic-styles', {}, [...automatic.values()].map(({ content }) => content).join(''))
    + tag('office:body', {}, tag('office:text', {}, content)));
  const meta = documentXML('meta', tag('office:meta', {}, tag('meta:generator', {}, 'Margin') + tag('dc:title', {}, xmlText(title))));
  const files = { 'content.xml': body, 'styles.xml': common, 'meta.xml': meta };
  const entry = (path, mediaType, version = null) => tag('manifest:file-entry', { 'manifest:full-path': path, 'manifest:media-type': mediaType, 'manifest:version': version });
  const manifest = XML + tag('manifest:manifest', { 'xmlns:manifest': 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0', 'manifest:version': '1.2' },
    entry('/', MIME, '1.2') + Object.keys(files).map((path) => entry(path, 'text/xml')).join('') + images.map(({ path, mediaType }) => entry(path, mediaType)).join(''));
  return zipSync({
    mimetype: [strToU8(MIME), { level: 0 }],
    ...Object.fromEntries(Object.entries(files).map(([path, value]) => [path, strToU8(value)])),
    ...Object.fromEntries(images.map(({ path, bytes }) => [path, [bytes, { level: 0 }]])),
    'META-INF/manifest.xml': strToU8(manifest),
  }, { level: 6 });
}
