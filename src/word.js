import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat,
  Packer, PageOrientation, Paragraph, Table, TableCell, TableRow, TextRun, UnderlineType, WidthType,
} from 'docx';
import { cleanPage } from './store.js';

const headingNames = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];
const alignments = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };

function hex(color) {
  if (!color) return undefined;
  if (/^#[a-f\d]{6}$/i.test(color)) return color.slice(1).toUpperCase();
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  return rgb?.slice(1, 4).map((channel) => Math.min(255, Number(channel)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function fontOptions(node, inherited) {
  const style = node.style;
  const tag = node.localName;
  const result = { ...inherited };
  if (tag === 'b' || tag === 'strong' || (style.fontWeight && (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600))) result.bold = true;
  if (tag === 'i' || tag === 'em' || style.fontStyle === 'italic') result.italics = true;
  if (tag === 'u' || style.textDecoration.includes('underline')) result.underline = { type: UnderlineType.SINGLE };
  if (['s', 'del', 'strike'].includes(tag) || style.textDecoration.includes('line-through')) result.strike = true;
  if (tag === 'code') result.font = 'Consolas';
  if (tag === 'sup') result.superScript = true;
  if (tag === 'sub') result.subScript = true;
  if (style.fontFamily) result.font = style.fontFamily.split(',')[0].replace(/["']/g, '').trim();
  if (/^\d+(?:\.\d+)?(?:pt|px)$/.test(style.fontSize)) result.size = Math.round(parseFloat(style.fontSize) * (style.fontSize.endsWith('px') ? 1.5 : 2));
  if (hex(style.color)) result.color = hex(style.color);
  const highlight = hex(style.backgroundColor || node.getAttribute('data-color')) || (tag === 'mark' ? 'FFEEA1' : undefined);
  if (highlight) result.shading = { fill: highlight };
  return result;
}

async function imageRun(node, maxWidth) {
  const [, type, raw] = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/i.exec(node.src) || [];
  if (!raw) return new TextRun(node.alt || '');
  let data = Uint8Array.from(atob(raw), (character) => character.charCodeAt(0));
  try {
    const bitmap = await createImageBitmap(new Blob([data], { type: 'image/' + type }));
    try {
      const scale = Math.min(1, maxWidth / bitmap.width, 725 / bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      let output = type === 'jpeg' ? 'jpg' : type;
      if (output === 'webp' || output === 'gif') {
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
        data = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        output = 'png';
      }
      return new ImageRun({
        type: output, data, transformation: { width, height },
        altText: { name: node.alt || 'Image', description: node.alt || '', title: node.alt || '' },
      });
    } finally { bitmap.close(); }
  } catch {
    return new TextRun(node.alt || '[Image]');
  }
}

async function runs(nodes, inherited, maxWidth) {
  const output = [];
  for (const node of nodes) {
    if (node.nodeType === 3) {
      const parts = node.nodeValue.split('\n');
      parts.forEach((text, index) => output.push(new TextRun({ ...inherited, text, break: index ? 1 : undefined })));
      continue;
    }
    if (node.nodeType !== 1) continue;
    const props = fontOptions(node, inherited);
    if (node.localName === 'br') output.push(new TextRun({ ...props, break: 1 }));
    else if (node.localName === 'img') output.push(await imageRun(node, maxWidth));
    else if (node.localName === 'a' && node.hasAttribute('href')) {
      const content = await runs(node.childNodes, { style: 'Hyperlink', ...props }, maxWidth);
      output.push(new ExternalHyperlink({ link: node.href, children: content }));
    } else output.push(...await runs(node.childNodes, props, maxWidth));
  }
  return output;
}

export async function toDOCX(html, title, rawPage) {
  const page = cleanPage(rawPage);
  const font = page.font;
  const [width, height] = page.paper === 'A4' ? [11906, 16838] : [12240, 15840];
  const margin = Math.round(page.margin * 1440);
  const maxWidth = ((page.landscape ? height : width) - margin * 2) / 15;
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const numbering = [];
  let listNumber = 0;

  function newList(start) {
    const reference = 'margin-list-' + ++listNumber;
    numbering.push({ reference, levels: Array.from({ length: 9 }, (_, level) => ({
      level, start, format: LevelFormat.DECIMAL, text: '%' + (level + 1) + '.', alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: 420 + level * 300, hanging: 275 } } },
    })) });
    return reference;
  }

  async function blocks(nodes, context = {}) {
    const result = [];
    for (const node of nodes) {
      if (node.nodeType === 3) {
        if (node.nodeValue.trim()) result.push(new Paragraph(node.nodeValue.trim()));
        continue;
      }
      if (node.nodeType !== 1) continue;
      if (node.hasAttribute('data-page-break')) {
        result.push(new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0 }, children: [] }));
      } else if (node.matches('ol,ul')) {
        const ordered = node.matches('ol');
        const reference = ordered ? newList(Number(node.getAttribute('start')) || 1) : undefined;
        for (const item of node.children) {
          const level = Math.min(context.depth ?? 0, 8);
          const task = item.getAttribute('data-type') === 'taskItem';
          const taskText = task ? (item.getAttribute('data-checked') === 'true' ? '☑ ' : '☐ ') : undefined;
          const list = task ? {} : ordered ? { numbering: { reference, level } } : { bullet: { level } };
          const children = [...item.children].filter((child) => !child.matches('label')).flatMap((child) => task && child.matches('div') ? [...child.children] : [child]);
          let first = true;
          for (const child of children) {
            const sublist = child.matches('ol,ul');
            result.push(...await blocks([child], sublist ? { depth: level + 1 } : first ? { list, taskText } : {}));
            if (!sublist) first = false;
          }
          if (!children.length) result.push(new Paragraph({ ...list, children: await runs(item.childNodes, {}, maxWidth) }));
        }
      } else if (node.matches('table')) {
        const rows = [];
        for (const row of node.rows) {
          const cells = [];
          for (const cell of row.cells) {
            const content = await blocks(cell.childNodes);
            cells.push(new TableCell({
              columnSpan: cell.colSpan || 1, rowSpan: cell.rowSpan || 1,
              margins: { top: 82, bottom: 82, left: 112, right: 112 },
              shading: cell.matches('th') ? { fill: 'F1F1EE' } : undefined,
              children: content.length ? content : [new Paragraph('')],
            }));
          }
          if (cells.length) rows.push(new TableRow({ children: cells, cantSplit: true, tableHeader: [...row.cells].every((cell) => cell.matches('th')) }));
        }
        if (rows.length) result.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      } else if (node.matches('blockquote')) {
        result.push(...await blocks(node.childNodes, { ...context, quote: true }));
      } else if (node.matches('hr')) {
        result.push(new Paragraph({ border: { bottom: { color: 'D8D8D4', size: 6, style: BorderStyle.SINGLE } } }));
      } else {
        const heading = /^h[1-6]$/.test(node.localName) ? headingNames[Number(node.localName[1]) - 1] : undefined;
        const inherited = fontOptions(node, context.quote ? { italics: true, color: '494947' } : {});
        const content = node.matches('img') ? [await imageRun(node, maxWidth)] : await runs(node.childNodes, inherited, maxWidth);
        if (context.taskText) content.unshift(new TextRun(context.taskText));
        const line = parseFloat(node.style.lineHeight);
        result.push(new Paragraph({
          heading, children: content, ...(context.list ?? {}),
          alignment: alignments[node.style.textAlign],
          keepNext: Boolean(heading),
          spacing: Number.isFinite(line) && line >= 1 && line <= 3 ? { line: Math.round(line * 240) } : undefined,
          indent: context.quote ? { left: 300, right: 120 } : undefined,
          border: context.quote ? { left: { color: '999995', size: 14, space: 8, style: BorderStyle.SINGLE } } : undefined,
        }));
      }
    }
    return result;
  }

  const children = await blocks(body.childNodes);
  const document = new Document({
    title, creator: 'Margin', numbering: { config: numbering },
    styles: { default: {
      document: { run: { font, size: 24, color: '252525' }, paragraph: { spacing: { after: 125, line: 330 } } },
      heading1: { run: { font, size: 76, bold: false, color: '252525' }, paragraph: { spacing: { before: 180, after: 260, line: 270 } } },
      heading2: { run: { font, size: 36, bold: true, color: '252525' }, paragraph: { spacing: { before: 290, after: 105 } } },
      heading3: { run: { font, size: 30, bold: true, color: '252525' } },
    } },
    sections: [{ properties: { page: { size: { width, height, orientation: page.landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
      margin: { top: margin, right: margin, bottom: margin, left: margin } } }, children: children.length ? children : [new Paragraph('')] }],
  });
  return new Uint8Array(await (await Packer.toBlob(document)).arrayBuffer());
}
