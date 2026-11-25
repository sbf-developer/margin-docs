import { escapeHTML, unzipDocument } from './formats.js';

const decoder = new TextDecoder();
const read = (node, name) => node.getAttribute(name);
const children = (node) => Array.from(node.children);

export async function fromODT(bytes) {
  const files = await unzipDocument(bytes);
  if (!Object.hasOwn(files, 'content.xml')) throw new Error('This file is missing its OpenDocument contents.');
  const parser = new DOMParser();
  const xml = parser.parseFromString(decoder.decode(files['content.xml']), 'application/xml');
  const shared = files['styles.xml'] && parser.parseFromString(decoder.decode(files['styles.xml']), 'application/xml');
  const body = xml.getElementsByTagName('office:text')[0];
  if (!body || xml.getElementsByTagName('parsererror').length) throw new Error('This file is not a valid OpenDocument text file.');
  const styles = new Map();
  const links = new Set();
  for (const source of [shared, xml].filter(Boolean)) {
    for (const item of source.getElementsByTagName('style:style')) {
      const names = { 'fo:color': 'color', 'fo:background-color': 'background-color', 'fo:font-size': 'font-size', 'fo:font-weight': 'font-weight', 'fo:font-style': 'font-style', 'fo:text-align': 'text-align', 'fo:line-height': 'line-height' };
      const rules = children(item).flatMap((property) => Object.entries(names).flatMap(([key, value]) => read(property, key) ? [value + ':' + read(property, key)] : []));
      if (children(item).some((property) => read(property, 'style:text-underline-style') && read(property, 'style:text-underline-style') !== 'none')) rules.push('text-decoration:underline');
      styles.set(read(item, 'style:name'), { parent: read(item, 'style:parent-style-name'), rules });
    }
    for (const item of source.getElementsByTagName('text:list-style')) {
      if (children(item)[0]?.localName === 'list-level-style-number') links.add(read(item, 'style:name'));
    }
  }
  function style(node) {
    const rules = [];
    const visited = new Set();
    let name = read(node, 'text:style-name');
    while (name && styles.has(name) && !visited.has(name)) {
      visited.add(name);
      const value = styles.get(name);
      rules.unshift(...value.rules);
      name = value.parent;
    }
    return rules.length ? ' style="' + escapeHTML(rules.join(';')) + '"' : '';
  }
  function draw(node) {
    const source = (read(node, 'xlink:href') || '').replace(/^\.\//, '');
    const ext = source.split('.').at(-1)?.toLowerCase();
    const types = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' };
    if (!Object.hasOwn(types, ext) || !Object.hasOwn(files, source)) return '';
    const values = files[source];
    let raw = '';
    for (let i = 0; i < values.length; i += 16384) raw += String.fromCharCode(...values.subarray(i, i + 16384));
    return '<img alt="" src="data:image/' + types[ext] + ';base64,' + btoa(raw) + '">';
  }
  function render(node, level = 0) {
    if (node.nodeType === 3) return escapeHTML(node.nodeValue);
    if (node.nodeType !== 1 || level > 100) return '';
    const inside = [...node.childNodes].map((child) => render(child, level + 1)).join('');
    const wrap = (tag, more = '') => '<' + tag + more + '>' + inside + '</' + tag + '>';
    switch (node.nodeName) {
      case 'text:p': return wrap('p', style(node));
      case 'text:h': return wrap('h' + Math.min(6, Math.max(1, Number(read(node, 'text:outline-level')) || 1)), style(node));
      case 'text:span': return wrap('span', style(node));
      case 'text:a': return wrap('a', ' href="' + escapeHTML(read(node, 'xlink:href') || '') + '"');
      case 'text:line-break': return '<br>';
      case 'text:tab': return '\t';
      case 'text:s': return '&nbsp;'.repeat(Math.min(200, Number(read(node, 'text:c')) || 1));
      case 'text:list': return wrap(links.has(read(node, 'text:style-name')) ? 'ol' : 'ul');
      case 'text:list-item': return wrap('li');
      case 'table:table': return '<table><tbody>' + inside + '</tbody></table>';
      case 'table:table-row': return wrap('tr').repeat(Math.min(100, Number(read(node, 'table:number-rows-repeated')) || 1));
      case 'table:table-cell': return wrap(node.parentElement.parentElement.nodeName === 'table:table-header-rows' ? 'th' : 'td',
        ' colspan="' + Math.min(100, Number(read(node, 'table:number-columns-spanned')) || 1) + '" rowspan="' + Math.min(100, Number(read(node, 'table:number-rows-spanned')) || 1) + '"')
        .repeat(Math.min(30, Number(read(node, 'table:number-columns-repeated')) || 1));
      case 'draw:image': return draw(node);
      case 'office:annotation':
      case 'table:covered-table-cell': return '';
      default: return inside;
    }
  }
  return render(body);
}
