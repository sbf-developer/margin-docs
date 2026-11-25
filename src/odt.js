import { escapeHTML, unzipDocument } from './formats.js';
import { cleanPage } from './store.js';

const prefixes = {
  'urn:oasis:names:tc:opendocument:xmlns:office:1.0': 'office',
  'urn:oasis:names:tc:opendocument:xmlns:style:1.0': 'style',
  'urn:oasis:names:tc:opendocument:xmlns:text:1.0': 'text',
  'urn:oasis:names:tc:opendocument:xmlns:table:1.0': 'table',
  'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0': 'draw',
  'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0': 'fo',
  'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0': 'svg',
  'http://www.w3.org/1999/xlink': 'xlink',
};
const namespaces = Object.fromEntries(Object.entries(prefixes).map(([uri, prefix]) => [prefix, uri]));
const decoder = new TextDecoder();
const nameOf = (node) => prefixes[node?.namespaceURI] + ':' + node?.localName;
const elements = (node, name) => {
  const [prefix, local] = name.split(':');
  return Array.from(node?.getElementsByTagNameNS(namespaces[prefix], local) ?? []);
};
const read = (node, name) => {
  const [prefix, local] = name.split(':');
  return node?.getAttributeNS(namespaces[prefix], local) || '';
};
const child = (node, name) => Array.from(node?.children ?? []).find((element) => nameOf(element) === name);
const asStyle = (value) => {
  const rules = Object.entries(value).filter(([, property]) => property).map(([key, property]) => key + ':' + property).join(';');
  return rules ? ' style="' + escapeHTML(rules) + '"' : '';
};
const lengthInches = (value) => {
  const match = /^([\d.]+)(in|cm|mm|pt|pc|px)$/.exec(value);
  const units = { in: 1, cm: 2.54, mm: 25.4, pt: 72, pc: 6, px: 96 };
  return match ? Number(match[1]) / units[match[2]] : 0;
};

export async function fromODT(bytes) {
  const files = await unzipDocument(bytes);
  if (!Object.hasOwn(files, 'content.xml')) throw new Error('This file is missing its OpenDocument contents.');
  const parser = new DOMParser();
  const parse = (file) => files[file] && parser.parseFromString(decoder.decode(files[file]), 'application/xml');
  const xml = parse('content.xml');
  const shared = parse('styles.xml');
  const body = child(child(xml.documentElement, 'office:body'), 'office:text');
  if (!body || xml.getElementsByTagName('parsererror').length) throw new Error('This file is not a valid OpenDocument text file.');
  const fonts = new Map();
  const styles = new Map();
  const lists = new Map();
  const sources = [shared, xml].filter(Boolean);
  for (const source of sources) {
    for (const face of elements(source, 'style:font-face')) {
      const family = read(face, 'svg:font-family').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      if (family) fonts.set(read(face, 'style:name'), family);
    }
    for (const item of elements(source, 'style:style')) styles.set(read(item, 'style:family') + ':' + read(item, 'style:name'), item);
    for (const item of elements(source, 'text:list-style')) lists.set(read(item, 'style:name'), item);
  }

  const fontName = (properties) => {
    const font = read(properties, 'style:font-name');
    return fonts.get(font) || font || read(properties, 'fo:font-family').replace(/^['"]|['"]$/g, '');
  };
  const defaults = sources.flatMap((source) => elements(source, 'style:default-style')).find((style) => read(style, 'style:family') === 'paragraph');
  const family = fontName(child(defaults, 'style:text-properties'));
  const equivalentFonts = { 'Liberation Serif': 'Times New Roman', 'Liberation Sans': 'Arial', 'Liberation Mono': 'Consolas', 'Carlito': 'Calibri', 'Caladea': 'Cambria' };
  const firstMaster = sources.flatMap((source) => elements(source, 'style:master-page'))[0];
  const layoutName = read(firstMaster, 'style:page-layout-name');
  const layouts = sources.flatMap((source) => elements(source, 'style:page-layout'));
  const pageProperties = child(layouts.find((layout) => read(layout, 'style:name') === layoutName) ?? layouts[0], 'style:page-layout-properties');
  const width = lengthInches(read(pageProperties, 'fo:page-width')) || 8.5;
  const height = lengthInches(read(pageProperties, 'fo:page-height')) || 11;
  const overall = lengthInches(read(pageProperties, 'fo:margin'));
  const margins = ['left', 'right', 'top', 'bottom'].map((side) => lengthInches(read(pageProperties, 'fo:margin-' + side)) || overall).filter(Boolean);
  const margin = margins.length ? Math.min(1.6, Math.max(.35, Math.round(margins.reduce((sum, value) => sum + value, 0) / margins.length * 100) / 100)) : 1;
  const distance = ([w, h]) => Math.abs(w - Math.min(width, height)) + Math.abs(h - Math.max(width, height));
  const page = cleanPage({
    paper: distance([210 / 25.4, 297 / 25.4]) < distance([8.5, 11]) ? 'A4' : 'Letter',
    landscape: width > height || read(pageProperties, 'style:print-orientation') === 'landscape',
    margin, font: Object.hasOwn(equivalentFonts, family) ? equivalentFonts[family] : family,
  });

  function textStyle(properties) {
    const names = { 'fo:color': 'color', 'fo:background-color': 'background-color', 'fo:font-size': 'font-size', 'fo:font-weight': 'font-weight', 'fo:font-style': 'font-style' };
    const css = Object.fromEntries(Object.entries(names).map(([key, value]) => [value, read(properties, key)]).filter(([, value]) => value));
    const font = fontName(properties);
    if (font) css['font-family'] = '"' + font.replace(/"/g, '') + '"';
    for (const [attribute, decoration] of [['style:text-underline-style', 'underline'], ['style:text-line-through-style', 'line-through']]) {
      const effect = read(properties, attribute);
      if (effect) css['text-decoration'] = effect === 'none' ? 'none' : [css['text-decoration'], decoration].filter(Boolean).join(' ');
    }
    return css;
  }

  const resolved = new Map();
  function resolveStyle(styleFamily, styleName) {
    const key = styleFamily + ':' + styleName;
    if (resolved.has(key)) return resolved.get(key);
    const chain = [];
    const seen = new Set();
    let lookup = styleName;
    while (lookup && styles.has(styleFamily + ':' + lookup) && !seen.has(lookup)) {
      seen.add(lookup);
      const item = styles.get(styleFamily + ':' + lookup);
      chain.unshift(item);
      lookup = read(item, 'style:parent-style-name');
    }
    const style = { names: seen, text: {}, paragraph: {}, position: null, before: '', outline: 0 };
    for (const item of chain) {
      const type = child(item, 'style:text-properties');
      Object.assign(style.text, textStyle(type));
      const position = read(type, 'style:text-position');
      if (position) style.position = position.startsWith('super') ? 'sup' : position.startsWith('sub') ? 'sub' : null;
      const props = child(item, 'style:paragraph-properties');
      const align = read(props, 'fo:text-align');
      if (align) style.paragraph['text-align'] = align === 'start' ? 'left' : align === 'end' ? 'right' : align;
      const line = read(props, 'fo:line-height');
      if (line && read(item, 'style:name') !== 'Body') style.paragraph['line-height'] = line.endsWith('%') ? String(parseFloat(line) / 100) : line;
      style.before = read(props, 'fo:break-before') || style.before;
      style.outline = Number(read(item, 'style:default-outline-level')) || style.outline;
    }
    resolved.set(key, style);
    return style;
  }

  let copied = 0;
  const repeat = (output, copies, max) => {
    const count = Math.floor(Math.min(max, Math.max(1, Number(copies) || 1)));
    copied += output.length * (count - 1);
    if (copied > 24 * 1024 * 1024) throw new Error('This OpenDocument file contains too many repeated elements.');
    return output.repeat(count);
  };

  function draw(node, alt = '') {
    const source = read(node, 'xlink:href').replace(/^\.\//, '');
    const ext = source.split('.').at(-1)?.toLowerCase();
    const types = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' };
    if (!Object.hasOwn(types, ext) || !Object.hasOwn(files, source)) return alt ? escapeHTML('[' + alt + ']') : '';
    const values = files[source];
    let raw = '';
    for (let index = 0; index < values.length; index += 16384) raw += String.fromCharCode(...values.subarray(index, index + 16384));
    return '<img alt="' + escapeHTML(alt) + '" src="data:image/' + types[ext] + ';base64,' + btoa(raw) + '">';
  }

  function taskEntry(item) {
    const p = child(item, 'text:p');
    const marker = p?.firstChild;
    const match = marker?.nodeType === 3 && /^([☐☑])[ \u00a0]*/.exec(marker.nodeValue);
    return match ? { marker, match } : null;
  }

  function renderList(node, level, listDepth) {
    const listName = read(node, 'text:style-name');
    const levels = Array.from(lists.get(listName)?.children ?? []);
    const active = levels.find((item) => Number(read(item, 'text:level')) === listDepth) ?? levels[0];
    const ordered = nameOf(active) === 'text:list-level-style-number';
    const items = Array.from(node.children).filter((item) => nameOf(item) === 'text:list-item');
    const checklist = !ordered && items.length && items.every(taskEntry);
    if (checklist) {
      return '<ul data-type="taskList">' + items.map((item) => {
        const copy = item.cloneNode(true);
        const { marker, match } = taskEntry(copy);
        const space = marker.nextSibling;
        marker.nodeValue = marker.nodeValue.slice(match[0].length);
        if (!marker.nodeValue && nameOf(space) === 'text:s') space.remove();
        return '<li data-type="taskItem" data-checked="' + (match[1] === '☑') + '">'
          + renderChildren(copy, level, listDepth) + '</li>';
      }).join('') + '</ul>';
    }
    const start = Number(read(items[0], 'text:start-value') || read(active, 'text:start-value')) || 1;
    const tag = ordered ? 'ol' : 'ul';
    return '<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>'
      + renderChildren(node, level, listDepth) + '</' + tag + '>';
  }

  function renderChildren(node, level, listDepth) {
    return Array.from(node.childNodes, (item) => render(item, level + 1, listDepth)).join('');
  }

  function render(node, level = 0, listDepth = 0) {
    if (level > 100) return '';
    if (node.nodeType === 3) {
      const mainText = nameOf(node.parentNode);
      return /^(?:text:(?:p|h|span|a))$/.test(mainText) ? escapeHTML(node.nodeValue) : '';
    }
    if (node.nodeType !== 1) return '';
    const name = nameOf(node);
    if (name === 'text:list') return renderList(node, level, listDepth + 1);
    if (name === 'draw:frame') {
      const image = child(node, 'draw:image');
      return image ? draw(image, child(node, 'svg:title')?.textContent || child(node, 'svg:desc')?.textContent || '') : '';
    }
    if (['office:annotation', 'table:covered-table-cell', 'text:soft-page-break', 'text:list-header'].includes(name)) return '';
    const inside = renderChildren(node, level, listDepth);
    const wrap = (tag, more = '', contents = inside) => '<' + tag + more + '>' + contents + '</' + tag + '>';
    switch (name) {
      case 'text:p':
      case 'text:h': {
        const style = resolveStyle('paragraph', read(node, 'text:style-name'));
        const heading = name === 'text:h' ? Math.min(6, Math.max(1, Number(read(node, 'text:outline-level')) || style.outline || 1)) : style.outline;
        const before = style.before === 'page' ? '<div data-page-break="true"></div>' : '';
        if (!inside && before) return before;
        if (!inside && style.names.has('Rule')) return '<hr>';
        if (style.names.has('CodeBlock')) return before + wrap('pre', '', wrap('code', '', inside.replace(/<br>/g, '\n')));
        const imageOnly = /^<img [^>]*>\s*$/.test(inside);
        if (imageOnly) return before + inside;
        const { ['font-size']: fontSize, ['font-weight']: fontWeight, ...text } = style.text;
        const textFormat = style.names.has('Heading' + heading) && !/^M\d+$/.test(read(node, 'text:style-name'))
          ? text : { ...text, 'font-size': fontSize, 'font-weight': fontWeight };
        const styled = asStyle(textFormat);
        const paragraph = wrap(heading ? 'h' + Math.max(1, Math.min(6, heading)) : 'p', asStyle(style.paragraph), styled ? wrap('span', styled) : inside);
        return before + (style.names.has('Quote') ? wrap('blockquote', '', paragraph) : paragraph);
      }
      case 'text:span': {
        const style = resolveStyle('text', read(node, 'text:style-name'));
        const position = style.position ? wrap(style.position) : inside;
        const css = asStyle(style.text);
        return css ? wrap('span', css, position) : position;
      }
      case 'text:a': return wrap('a', ' href="' + escapeHTML(read(node, 'xlink:href')) + '"');
      case 'text:line-break': return '<br>';
      case 'text:tab': return '\t';
      case 'text:s': return '&nbsp;'.repeat(Math.max(1, Math.min(200, Number(read(node, 'text:c')) || 1)));
      case 'text:list-item': return wrap('li');
      case 'table:table': return '<table><tbody>' + inside + '</tbody></table>';
      case 'table:table-row': return repeat(wrap('tr'), read(node, 'table:number-rows-repeated'), 100);
      case 'table:table-cell': return repeat(wrap(
        nameOf(node.parentElement?.parentElement) === 'table:table-header-rows' || read(node, 'table:style-name') === 'HeaderCell' ? 'th' : 'td',
        ' colspan="' + Math.max(1, Math.min(100, Number(read(node, 'table:number-columns-spanned')) || 1))
        + '" rowspan="' + Math.max(1, Math.min(100, Number(read(node, 'table:number-rows-spanned')) || 1)) + '"',
      ), read(node, 'table:number-columns-repeated'), 30);
      case 'draw:image': return draw(node);
      default: return inside;
    }
  }
  return { html: render(body), page };
}
