# Margin

Margin is a local-first word processor for Windows. Open a file, edit it on the page, and save a portable Margin document or export a copy. The desktop app works offline and requires no account.

## Use Margin

- Run **Margin-Setup.exe** to install it for the current Windows user, or run **Margin-Portable.exe** to start without an installation. These x64 builds are unsigned.
- Use **New document**, **Open file**, or drop a document onto the canvas. The workspace autosaves to your Windows user profile. Use **Ctrl+S** to save a portable `.margin` file.
- Use the formatting toolbar to style text, adjust paragraphs, add lists, and edit tables. The outline links to headings. **Ctrl+F** opens Find and Replace, and **F11** toggles focus mode.
- Open **View and layout** for paper size, margins, and orientation. The editing canvas scrolls continuously. PDF export paginates the document using its page settings and explicit page breaks.

| Format | Open as editable text | Export |
| --- | --- | --- |
| Margin (`.margin`) | Yes | Yes |
| Word (`.docx`) | Yes | Yes |
| OpenDocument Text (`.odt`) | Yes | |
| PDF (`.pdf`) | Text-based PDFs | Yes |
| Markdown (`.md`, `.markdown`) | Yes | Yes (`.md`) |
| HTML (`.html`, `.htm`) | Yes | Yes (`.html`) |
| Plain text (`.txt`) | Yes | Yes |

Word and OpenDocument import preserve common structural features such as headings, lists, and tables. Complex page layouts and Word-specific features can simplify during conversion. PDF import reconstructs structure from the text layer and positions. Review multi-column layouts, tables, and headings after conversion. A scanned PDF needs an OCR text layer before import.

## Build on Windows

Install Node.js 22.12 or later and pnpm 11. Run these commands from the project directory.

```powershell
pnpm install
pnpm exec install-electron
pnpm desktop
pnpm test
pnpm package:win
```

The packaged Windows executables are written to `release/`. Documents are stored with IndexedDB under the Margin profile in `%APPDATA%`. Keep a `.margin` export for any document you want to move or back up separately.
