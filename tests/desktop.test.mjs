import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { _electron as electron, expect } from '@playwright/test';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = path.resolve(root, '../margin-test');
const exe = process.env.MARGIN_TEST_EXE;

async function launch(profile) {
  const args = ['--user-data-dir=' + profile];
  if (!exe) args.unshift(path.join(root, 'desktop', 'main.cjs'));
  const app = await electron.launch({ args, executablePath: exe, timeout: 30000 });
  const page = await app.firstWindow();
  await expect(page.getByRole('textbox', { name: 'Document editor' })).toBeVisible();
  return { app, page };
}

async function saveAt(app, page, label, output) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, output);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  await expect(page.locator('#toast')).toContainText(path.basename(output), { timeout: 20000 });
  assert.ok((await stat(output)).size > 10);
}

async function openAt(app, page, file, title) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, file);
  await page.getByRole('button', { name: 'Open file…', exact: true }).click();
  await expect(page.locator('#document-title')).toHaveText(title, { timeout: 15000 });
}

async function closeAndWait(app, page) {
  const closed = app.waitForEvent('close');
  await page.close();
  await closed;
}

test('Windows editing, local persistence, file dialogs, and conversion round trips', { timeout: 180000 }, async () => {
  await mkdir(work, { recursive: true });
  const run = await mkdtemp(path.join(work, 'run-'));
  const profile = path.join(run, 'profile');
  let { app, page } = await launch(profile);
  try {
    const unexpected = [];
    page.on('pageerror', (error) => unexpected.push(error.message));
    const editor = page.getByRole('textbox', { name: 'Document editor' });
    await expect(editor.locator('h1')).toContainText('A quieter place');
    if (process.env.MARGIN_SCREENSHOT) await page.screenshot({ path: process.env.MARGIN_SCREENSHOT });
    await page.getByRole('button', { name: /New document/ }).click();
    await expect(page.locator('#document-title')).toHaveText('Untitled document');
    await expect(editor).toBeFocused();
    await editor.press('Control+b');
    await page.keyboard.insertText('Margin verification');
    await editor.press('Control+b');
    await expect(editor.locator('strong')).toHaveText('Margin verification');
    await editor.press('End');
    await editor.press('Enter');
    await page.keyboard.insertText('This is a clean editing workflow. A second editing workflow.');

    await editor.press('Control+f');
    await page.getByRole('textbox', { name: 'Find in document' }).fill('workflow');
    await expect(page.locator('#find-count')).toHaveText('1 / 2');
    await page.getByRole('textbox', { name: 'Replace with' }).fill('process');
    await page.getByRole('button', { name: 'Replace all' }).click();
    await expect(editor).toContainText('a clean editing process');
    await page.getByRole('button', { name: 'Close search' }).click();

    await editor.press('Control+End');
    await editor.press('Enter');
    await page.getByRole('button', { name: 'Table tools' }).click();
    await page.getByRole('menuitem', { name: 'Insert table…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Insert', exact: true }).click();
    await expect(editor.locator('tr')).toHaveCount(3);
    await page.keyboard.insertText('Status');
    await expect(editor.locator('th').first()).toContainText('Status');
    await page.getByRole('button', { name: 'Table tools' }).click();
    await page.getByRole('menuitem', { name: 'Add row below' }).click();
    await expect(editor.locator('tr')).toHaveCount(4);

    await page.getByRole('button', { name: 'Document options' }).click();
    await page.getByRole('menuitem', { name: 'Rename…' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Verification');
    await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click();
    await expect(page.locator('#document-title')).toHaveText('Verification');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Theme').selectOption('light');
    await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    const nativeFile = path.join(run, 'Verification.margin');
    const wordFile = path.join(run, 'Converted.docx');
    const pdfFile = path.join(run, 'Converted PDF.pdf');
    await saveAt(app, page, 'Margin document (.margin)', nativeFile);
    const native = JSON.parse(await readFile(nativeFile, 'utf8'));
    assert.equal(native.title, 'Verification');
    assert.match(native.html, /<table/);
    await saveAt(app, page, 'Word document (.docx)', wordFile);
    assert.equal((await readFile(wordFile)).subarray(0, 2).toString(), 'PK');
    await saveAt(app, page, 'PDF document', pdfFile);
    assert.equal((await readFile(pdfFile)).subarray(0, 5).toString(), '%PDF-');

    await closeAndWait(app, page);
    ({ app, page } = await launch(profile));
    assert.match(await page.title(), /Verification/);
    const reopened = page.getByRole('textbox', { name: 'Document editor' });
    await expect(reopened.locator('tr')).toHaveCount(4);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await openAt(app, page, wordFile, 'Converted');
    await expect(reopened.locator('strong')).toContainText('Margin verification');
    await expect(reopened.locator('table')).toBeVisible();

    await openAt(app, page, pdfFile, 'Converted PDF');
    await expect(reopened).toContainText('Margin verification');
    await expect(reopened).toContainText('clean editing process');

    const odt = path.join(run, 'OpenDocument.odt');
    await writeFile(odt, zipSync({
      'content.xml': strToU8('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">OpenDocument heading</text:h><text:p>An editable OpenDocument paragraph.</text:p></office:text></office:body></office:document-content>'),
    }));
    await openAt(app, page, odt, 'OpenDocument');
    await expect(reopened.locator('h1')).toContainText('OpenDocument heading');

    const md = path.join(run, 'Notes.md');
    await writeFile(md, '# Markdown heading\n\n- [x] Finished task\n- [ ] Another task\n');
    await openAt(app, page, md, 'Notes');
    await expect(reopened.locator('h1')).toContainText('Markdown heading');
    await expect(reopened.locator('ul[data-type="taskList"] input[type=checkbox]')).toHaveCount(2);
    await expect(reopened.locator('ul[data-type="taskList"] input[type=checkbox]').first()).toBeChecked();

    const html = path.join(run, 'HTML title.html');
    await writeFile(html, '<h1>HTML heading</h1><p onclick="alert(1)"><b>Styled</b><img src="https://example.invalid/image.png"><script>throw Error("script ran")</script></p>');
    await openAt(app, page, html, 'HTML title');
    await expect(reopened.locator('h1')).toContainText('HTML heading');
    await expect(reopened.locator('script,img,[onclick]')).toHaveCount(0);

    await openAt(app, page, nativeFile, 'Verification');
    await expect(reopened.locator('tr')).toHaveCount(4);
    assert.deepEqual(unexpected, []);
  } finally {
    await app.close().catch(() => {});
  }
});

test('OpenDocument export and import preserve editable content and page setup', { timeout: 90000 }, async () => {
  await mkdir(work, { recursive: true });
  const run = await mkdtemp(path.join(work, 'odt-'));
  const { app, page } = await launch(path.join(run, 'profile'));
  try {
    const image = (await readFile(path.join(root, 'build', 'icon.png'))).toString('base64');
    const source = path.join(run, 'Draft.margin');
    const layout = { paper: 'A4', landscape: true, margin: .75, font: 'Calibri' };
    await writeFile(source, JSON.stringify({
      format: 'margin', version: 1, title: 'Draft', page: layout,
      html: '<h1>Interoperability</h1><p style="text-align:center"><strong>Bold</strong> <em>Italic</em> <u>Underline</u> <s>Strike</s> <a href="https://www.openoffice.org/">Writer</a> <sup>2</sup></p>'
        + '<ol start="4"><li><p>First numbered item</p><ul><li><p>Nested bullet</p></li></ul></li><li><p>Second numbered item</p></li></ol>'
        + '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Done</p></li><li data-type="taskItem" data-checked="false"><p>Pending</p></li></ul>'
        + '<table><tbody><tr><th colspan="2"><p>Milestone</p></th></tr><tr><td rowspan="2"><p>Check</p></td><td><p>Format</p></td></tr><tr><td><p>Page setup</p></td></tr></tbody></table>'
        + '<div data-page-break="true"></div><p>Second page &amp; résumé.</p><img src="data:image/png;base64,' + image + '" alt="Margin icon">',
    }));
    await openAt(app, page, source, 'Draft');
    const file = path.join(run, 'Writer draft.odt');
    await saveAt(app, page, 'OpenDocument Text (.odt)', file);
    const bytes = await readFile(file);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(bytes.readUInt16LE(8), 0, 'The first ZIP entry must be uncompressed.');
    assert.equal(bytes.readUInt16LE(28), 0, 'The mimetype ZIP entry must have no extra field.');
    assert.equal(bytes.subarray(30, 38).toString(), 'mimetype');
    const parts = unzipSync(bytes);
    assert.equal(strFromU8(parts.mimetype), 'application/vnd.oasis.opendocument.text');
    assert.match(strFromU8(parts['META-INF/manifest.xml']), /manifest:full-path="Pictures\/Image1\.png"/);
    assert.match(strFromU8(parts['styles.xml']), /style:print-orientation="landscape"/);
    const body = strFromU8(parts['content.xml']);
    assert.match(body, /table:number-columns-spanned="2"/);
    assert.match(body, /table:number-rows-spanned="2"/);
    assert.match(body, /text:start-value="4"/);
    assert.match(body, /<text:list text:style-name="MarginBullet">/);

    await openAt(app, page, file, 'Writer draft');
    const editor = page.getByRole('textbox', { name: 'Document editor' });
    await expect(editor.locator('h1')).toHaveText('Interoperability');
    await expect(editor.locator('strong').filter({ hasText: /^Bold$/ })).toHaveCount(1);
    await expect(editor.locator('em')).toHaveText('Italic');
    await expect(editor.locator('u')).toHaveText('Underline');
    await expect(editor.locator('s')).toHaveText('Strike');
    await expect(editor.locator('sup')).toHaveText('2');
    await expect(editor.locator('p[style*="text-align: center"]')).toContainText('Underline');
    await expect(editor.locator('ol[start="4"] ul')).toContainText('Nested bullet');
    await expect(editor.locator('th[colspan="2"]')).toHaveText('Milestone');
    await expect(editor.locator('td[rowspan="2"]')).toHaveText('Check');
    await expect(editor.locator('img[alt="Margin icon"]')).toBeVisible();
    await expect(editor.locator('[data-page-break]')).toHaveCount(1);
    await expect(editor.locator('ul[data-type="taskList"] input').first()).toBeChecked();
    const native = path.join(run, 'Roundtrip.margin');
    await saveAt(app, page, 'Margin document (.margin)', native);
    assert.deepEqual(JSON.parse(await readFile(native, 'utf8')).page, layout);
  } finally {
    await app.close().catch(() => {});
  }
});
