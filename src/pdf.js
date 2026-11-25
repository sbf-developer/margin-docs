import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { escapeHTML } from './formats.js';

GlobalWorkerOptions.workerSrc = new URL(workerURL, import.meta.url).href;

const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 12;
};

function lineGroups(content) {
  const entries = content.items
    .filter((item) => 'str' in item && item.str.trim())
    .map((item) => ({
      text: item.str, x: item.transform[4], y: item.transform[5], width: item.width,
      size: Math.hypot(item.transform[2], item.transform[3]) || item.height || 12,
      family: content.styles[item.fontName]?.fontFamily || '',
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const item of entries) {
    const previous = rows.at(-1);
    if (previous && Math.abs(previous.y - item.y) < Math.max(2.4, item.size * .29)) previous.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x);
    row.segments = [];
    for (const item of row.items) {
      const last = row.segments.at(-1);
      const gap = item.x - (last?.end ?? 0);
      if (!last || gap > Math.max(19, item.size * 1.75)) {
        row.segments.push({ x: item.x, end: item.x + item.width, text: item.text });
      } else {
        last.text += (gap > item.size * .17 && !/\s$/.test(last.text) && !/^\s/.test(item.text) ? ' ' : '') + item.text;
        last.end = Math.max(last.end, item.x + item.width);
      }
    }
    row.text = row.segments.map((part) => part.text.trim()).join(' ');
    row.size = median(row.items.map((item) => item.size));
    row.x = row.segments[0].x;
    row.end = row.segments.at(-1).end;
    return row;
  });
}

function sameColumns(first, current) {
  return first.segments.length === current.segments.length && current.segments.every((part, index) => Math.abs(part.x - first.segments[index].x) < 7);
}

function pageToHTML(lines, width, base) {
  const blocks = [];
  const left = Math.min(...lines.map((line) => line.x));
  const right = Math.max(...lines.map((line) => line.end));
  let paragraph = '';
  let previous;
  let list = null;
  let tables = 0;

  function flush() {
    if (paragraph) blocks.push('<p>' + escapeHTML(paragraph) + '</p>');
    if (list) blocks.push('<' + list.type + list.start + '>' + list.items.join('') + '</' + list.type + '>');
    paragraph = '';
    list = null;
  }

  for (let index = 0; index < lines.length; index++) {
    const row = lines[index];
    const { text, x, y, size } = row;
    if (!text) continue;
    const next = lines[index + 1];
    if (row.segments.length >= 2 && row.segments.length <= 8 && next && sameColumns(row, next)) {
      let end = index + 1;
      while (lines[end + 1] && sameColumns(row, lines[end + 1]) && lines[end].y - lines[end + 1].y < base * 3.1) end++;
      const candidates = lines.slice(index, end + 1);
      const compact = candidates.every((candidate) => candidate.segments.every((segment) => segment.text.length <= 95));
      const plausible = y - next.y < base * 3.1 && (candidates.length >= 3 || row.segments.length >= 3)
        && (row.segments.length >= 3 || candidates.every((candidate) => candidate.segments[0].text.length <= 38));
      if (compact && plausible) {
        flush();
        blocks.push('<table><tbody>' + candidates.map((candidate, rowIndex) => {
          const heading = rowIndex === 0 && (candidate.size > base * 1.05 || candidate.segments.every((segment) => /^[\p{L}][^.!?]{0,26}$/u.test(segment.text.trim())));
          const tag = heading ? 'th' : 'td';
          return '<tr>' + candidate.segments.map((segment) => '<' + tag + '><p>' + escapeHTML(segment.text.trim()) + '</p></' + tag + '>').join('') + '</tr>';
        }).join('') + '</tbody></table>');
        index = end;
        previous = lines[end];
        tables++;
        continue;
      }
    }
    const bullet = /^(?:([•●◦▪‣∙–—])|([0-9]+)[.)])\s+(.+)$/u.exec(text);
    const centered = Math.abs(x + (row.end - x) / 2 - width / 2) < 13 && x - left > 19;
    if (size >= base * 1.22 && text.length < 155 && !bullet) {
      flush();
      const tag = size >= base * 1.57 && blocks.length === 0 ? 'h1' : size >= base * 1.37 ? 'h2' : 'h3';
      const point = Math.min(46, Math.max(13, Math.round(size)));
      blocks.push('<' + tag + (centered ? ' style="text-align:center"' : '') + '><span style="font-size:' + point + 'pt">' + escapeHTML(text) + '</span></' + tag + '>');
    } else if (bullet) {
      if (paragraph || (list && (list.type === 'ol') !== Boolean(bullet[2]))) flush();
      list ??= { type: bullet[2] ? 'ol' : 'ul', start: bullet[2] && bullet[2] !== '1' ? ' start="' + Number(bullet[2]) + '"' : '', items: [] };
      list.items.push('<li><p>' + escapeHTML(bullet[3]) + '</p></li>');
    } else if (centered && text.length < 100 && !paragraph) {
      flush();
      blocks.push('<p style="text-align:center">' + escapeHTML(text) + '</p>');
    } else {
      if (list || (previous && (previous.y - y > base * 1.66 || Math.abs(x - previous.x) > base * 1.2 || (previous.end < right - base * 5 && /[.!?:]$/.test(previous.text))))) flush();
      const hyphenated = /\p{L}[-\u00ad]$/u.test(paragraph) && /^\p{Ll}/u.test(text);
      paragraph = hyphenated ? paragraph.slice(0, -1) + text : paragraph ? paragraph + ' ' + text : text;
    }
    previous = row;
  }
  flush();
  return { html: blocks.join(''), tables };
}

export async function fromPDF(bytes, onProgress) {
  const task = getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false, disableFontFace: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 500) throw new Error('This PDF exceeds the 500-page import limit.');
    const pages = [];
    let empty = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      onProgress?.('Reading PDF · page ' + number + ' of ' + pdf.numPages);
      const page = await pdf.getPage(number);
      const lines = lineGroups(await page.getTextContent());
      if (!lines.length) empty++;
      pages.push({ lines, width: page.view[2], height: page.view[3] });
      page.cleanup();
    }
    if (empty === pdf.numPages) throw new Error('No selectable text was found. Run OCR on this PDF and open the searchable copy.');
    const repeated = new Map();
    for (const { lines, height } of pages) {
      const unique = new Set(lines.filter((line) => line.y < height * .07 || line.y > height * .94).map((line) => line.text.replace(/\d+/g, '#')));
      for (const text of unique) repeated.set(text, (repeated.get(text) ?? 0) + 1);
    }
    const sizes = pages.flatMap(({ lines }) => lines.flatMap((line) => Array(Math.min(8, Math.ceil(line.text.length / 14))).fill(line.size)));
    const base = median(sizes);
    const reconstructed = pages.map(({ lines, width, height }) => pageToHTML(lines.filter((line) => {
      const count = repeated.get(line.text.replace(/\d+/g, '#')) ?? 0;
      return !(pdf.numPages > 1 && count >= Math.max(2, Math.ceil(pdf.numPages * .7)) && (line.y < height * .07 || line.y > height * .94));
    }), width, base).html).filter(Boolean);
    const first = pages[0];
    const shortSide = Math.min(first.width, first.height);
    return {
      html: reconstructed.join(''),
      page: { paper: Math.abs(shortSide - 595.28) < Math.abs(shortSide - 612) ? 'A4' : 'Letter', landscape: first.width > first.height, margin: 1 },
      note: empty ? 'PDF imported. ' + empty + ' image-only page' + (empty === 1 ? ' needs' : 's need') + ' OCR.' : 'PDF text is editable. Review the reconstructed layout.',
    };
  } catch (error) {
    if (error.name === 'PasswordException') throw new Error('Open an unlocked copy of this PDF.');
    throw error;
  } finally {
    await task.destroy();
  }
}
