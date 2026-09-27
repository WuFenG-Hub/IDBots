import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { ensureDomMatrixPolyfill } from './domMatrixPolyfill';

/**
 * Pure-JS document-to-text converters for the built-in MetaBot knowledge base.
 *
 * Markitdown-style format coverage (PDF/DOCX/PPTX/XLSX/HTML/EPUB) implemented
 * with bundled npm packages — no external binaries (the previous pipeline
 * required a user-installed `pdftotext` and macOS-only `textutil`). Every
 * heavy dependency is lazy-loaded inside its own branch so app startup is
 * unaffected and a broken package only breaks its own format.
 *
 * Each extractor throws KnowledgeBaseTextError('extract_failed', …) when the
 * file cannot be parsed or yields no text; the learn loop records per-file
 * failures instead of aborting the run, so throwing is safe.
 */

export class KnowledgeBaseTextError extends Error {
  readonly code: 'unsupported_format' | 'extract_failed';

  constructor(code: KnowledgeBaseTextError['code'], detail: string) {
    super(detail);
    this.name = 'KnowledgeBaseTextError';
    this.code = code;
  }
}

export interface KnowledgeBaseExtraction {
  text: string;
  title?: string;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared HTML → Markdown conversion (DOCX, HTML pages, EPUB chapters). */
async function htmlToMarkdown(html: string): Promise<string> {
  const mod = await import('turndown');
  const TurndownService = mod.default;
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  return service.turndown(html) as string;
}

/**
 * pdfjs-dist ships as native ESM only. The tsc/vite CJS bundles rewrite a
 * literal dynamic import into require(), which needs require(esm) (Node
 * >= 22.12) and has failed for ASAR-packed ESM on some Electron builds —
 * the Windows symptom was every PDF failing while plain-text formats kept
 * working. The fallback below re-imports the resolved file through a
 * runtime import() (hidden from the transpilers inside new Function) so
 * such runtimes still parse PDFs.
 */
const runtimeDynamicImport = new Function('specifier', 'return import(specifier);') as (
  specifier: string
) => Promise<unknown>;

interface PdfjsPageLike {
  getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
}

interface PdfjsDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPageLike>;
  destroy(): Promise<void>;
}

interface PdfjsModuleLike {
  getDocument(options: Record<string, unknown>): {
    promise: Promise<PdfjsDocumentLike>;
    destroy(): Promise<void>;
  };
}

let pdfjsModulePromise: Promise<PdfjsModuleLike> | null = null;

/**
 * Loads pdfjs-dist once per process, preferring the bundler-friendly dynamic
 * import and falling back to a runtime ESM import of the resolved file URL.
 * Exported for the knowledgeBaseText tests.
 */
export async function loadPdfjs(): Promise<PdfjsModuleLike> {
  // pdfjs-dist 6 evaluates `new DOMMatrix()` at module level but only
  // polyfills it from the optional, platform-binary @napi-rs/canvas package —
  // without a loadable canvas (e.g. Windows installers packed from a macOS
  // checkout) the import itself throws. Our 2D subset must be in place first;
  // text extraction never renders, so it never needs the full geometry spec.
  ensureDomMatrixPolyfill();
  if (!pdfjsModulePromise) {
    const load = async (): Promise<PdfjsModuleLike> => {
      const attempts: string[] = [];
      try {
        return (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModuleLike;
      } catch (error) {
        attempts.push(`import('pdfjs-dist/legacy/build/pdf.mjs') failed: ${errorDetail(error)}`);
      }
      let resolved = '';
      try {
        resolved = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
        return (await runtimeDynamicImport(pathToFileURL(resolved).href)) as PdfjsModuleLike;
      } catch (error) {
        attempts.push(`ESM import of ${resolved || 'pdfjs-dist/legacy/build/pdf.mjs'} failed: ${errorDetail(error)}`);
        throw new KnowledgeBaseTextError(
          'extract_failed',
          `pdfjs-dist could not be loaded (${attempts.join(' | ')})`
        );
      }
    };
    pdfjsModulePromise = load();
    // Never cache a failed load — the next learn run should retry it.
    pdfjsModulePromise.catch(() => {
      pdfjsModulePromise = null;
    });
  }
  return pdfjsModulePromise;
}

export async function extractPdfText(filePath: string): Promise<KnowledgeBaseExtraction> {
  try {
    const pdfjs = await loadPdfjs();
    // Ship-side standard fonts give correct glyph metrics for non-embedded
    // (base-14) fonts; without them pdfjs still extracts but warns and guesses
    // glyph widths. Resolve via require so both the tsc test build and the
    // vite CJS main bundle find node_modules at runtime. Optional on purpose:
    // a resolve failure must not fail extraction.
    let standardFontDataUrl: string | undefined;
    try {
      const pdfjsRoot = path.resolve(path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')), '../..');
      standardFontDataUrl = path.join(pdfjsRoot, 'standard_fonts') + path.sep;
    } catch {
      // pdfjs falls back to warn-only built-in glyph handling.
    }
    const data = new Uint8Array(await fs.promises.readFile(filePath));
    const loadingTask = pdfjs.getDocument({ data, disableFontFace: true, standardFontDataUrl, verbosity: 0 });
    const doc = await loadingTask.promise;
    try {
      const pages: string[] = [];
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
        const page = await doc.getPage(pageNo);
        const content = await page.getTextContent();
        let pageText = '';
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue;
          pageText += item.str;
          if (item.hasEOL) pageText += '\n';
        }
        if (pageText.trim()) pages.push(pageText.trim());
      }
      const text = pages.join('\n\n').trim();
      if (!text) throw new Error('no extractable text (scanned or image-only PDF)');
      return { text };
    } finally {
      await loadingTask.destroy();
    }
  } catch (error) {
    if (error instanceof KnowledgeBaseTextError) throw error;
    throw new KnowledgeBaseTextError('extract_failed', `Failed to parse PDF "${filePath}": ${errorDetail(error)}`);
  }
}

export async function extractDocxText(filePath: string): Promise<KnowledgeBaseExtraction> {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.convertToHtml({ path: filePath });
    const text = (await htmlToMarkdown(result.value)).trim();
    if (!text) throw new Error('no extractable text');
    return { text };
  } catch (error) {
    if (error instanceof KnowledgeBaseTextError) throw error;
    throw new KnowledgeBaseTextError('extract_failed', `Failed to parse DOCX "${filePath}": ${errorDetail(error)}`);
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Text runs of one OOXML slide/notes XML, paragraph by paragraph. Regex-based
 * on purpose: `<a:t>` content never contains a raw '<', and document order is
 * exactly the reading order we want for indexing.
 */
function extractOoxmlParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  for (const para of xml.split('</a:p>')) {
    const runs = Array.from(para.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g), (match) => match[1]);
    const text = decodeXmlEntities(runs.join('')).trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

export async function extractPptxText(filePath: string): Promise<KnowledgeBaseExtraction> {
  try {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(await fs.promises.readFile(filePath));
    const entryText = new Map<string, string>();
    for (const entry of zip.getEntries()) {
      if (!entry.isDirectory) entryText.set(entry.entryName, entry.getData().toString('utf8'));
    }
    const slideNumbers = [...entryText.keys()]
      .map((name) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1])
      .filter((num): num is string => Boolean(num))
      .map(Number)
      .sort((a, b) => a - b);
    const sections: string[] = [];
    for (const num of slideNumbers) {
      const paragraphs = extractOoxmlParagraphs(entryText.get(`ppt/slides/slide${num}.xml`) || '');
      const notes = extractOoxmlParagraphs(entryText.get(`ppt/notesSlides/notesSlide${num}.xml`) || '');
      const body = paragraphs.join('\n');
      const notesText = notes.length ? `\n\nNotes: ${notes.join('\n')}` : '';
      if (body || notesText) sections.push(`## Slide ${num}\n\n${body}${notesText}`.trim());
    }
    const text = sections.join('\n\n').trim();
    if (!text) throw new Error('no extractable text in any slide');
    return { text };
  } catch (error) {
    if (error instanceof KnowledgeBaseTextError) throw error;
    throw new KnowledgeBaseTextError('extract_failed', `Failed to parse PPTX "${filePath}": ${errorDetail(error)}`);
  }
}

export async function extractSpreadsheetText(filePath: string): Promise<KnowledgeBaseExtraction> {
  try {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(await fs.promises.readFile(filePath), { type: 'buffer' });
    const sections: string[] = [];
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet).trim();
      if (csv) sections.push(`## Sheet: ${name}\n\n${csv}`);
    }
    const text = sections.join('\n\n').trim();
    if (!text) throw new Error('no extractable cells in any sheet');
    return { text };
  } catch (error) {
    if (error instanceof KnowledgeBaseTextError) throw error;
    throw new KnowledgeBaseTextError(
      'extract_failed',
      `Failed to parse spreadsheet "${filePath}": ${errorDetail(error)}`
    );
  }
}

export async function extractHtmlText(filePath: string): Promise<KnowledgeBaseExtraction> {
  try {
    const html = await fs.promises.readFile(filePath, 'utf8');
    const text = (await htmlToMarkdown(html)).trim();
    if (!text) throw new Error('no extractable text');
    return { text };
  } catch (error) {
    if (error instanceof KnowledgeBaseTextError) throw error;
    throw new KnowledgeBaseTextError('extract_failed', `Failed to parse HTML "${filePath}": ${errorDetail(error)}`);
  }
}

/** Reads one zip entry as utf8, tolerating './'-prefixed container paths. */
function readZipTextEntry(entryText: Map<string, string>, name: string): string | undefined {
  const normalized = name.replace(/^\.\//, '');
  for (const key of [name, normalized, `./${normalized}`]) {
    const value = entryText.get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

export async function extractEpubText(filePath: string): Promise<KnowledgeBaseExtraction> {
  try {
    const AdmZip = (await import('adm-zip')).default;
    const { XMLParser } = await import('fast-xml-parser');
    const zip = new AdmZip(await fs.promises.readFile(filePath));
    const entryText = new Map<string, string>();
    for (const entry of zip.getEntries()) {
      if (!entry.isDirectory) entryText.set(entry.entryName, entry.getData().toString('utf8'));
    }

    const container = readZipTextEntry(entryText, 'META-INF/container.xml');
    const opfPath = container && /<rootfile[^>]*\bfull-path="([^"]+)"/.exec(container)?.[1];
    if (!opfPath) throw new Error('META-INF/container.xml rootfile not found');
    const opf = readZipTextEntry(entryText, opfPath);
    if (!opf) throw new Error(`OPF package document "${opfPath}" not found in archive`);

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const packageDoc = parser.parse(opf).package || {};
    const asArray = <T>(value: T | T[] | undefined): T[] =>
      value === undefined ? [] : Array.isArray(value) ? value : [value];

    const manifest = new Map<string, { href: string; mediaType: string }>();
    for (const item of asArray<Record<string, string>>(packageDoc.manifest?.item)) {
      const id = item['@_id'];
      const href = item['@_href'];
      if (id && href) manifest.set(id, { href, mediaType: item['@_media-type'] || '' });
    }
    const opfDir = path.posix.dirname(opfPath);
    const spineHrefs = asArray<Record<string, string>>(packageDoc.spine?.itemref)
      .map((ref) => manifest.get(ref['@_idref']))
      .filter((item): item is { href: string; mediaType: string } => Boolean(item))
      .map((item) =>
        path.posix.normalize(path.posix.join(opfDir === '.' ? '' : opfDir, decodeURIComponent(item.href)))
      );

    const chapters: string[] = [];
    for (const href of spineHrefs) {
      const chapter = readZipTextEntry(entryText, href);
      if (!chapter) continue;
      const markdown = (await htmlToMarkdown(chapter)).trim();
      if (markdown) chapters.push(markdown);
    }
    const text = chapters.join('\n\n').trim();
    if (!text) throw new Error('no extractable text in spine chapters');

    const dcTitle = packageDoc.metadata?.['dc:title'];
    const title =
      typeof dcTitle === 'string'
        ? dcTitle.trim()
        : typeof dcTitle?.['#text'] === 'string'
          ? String(dcTitle['#text']).trim()
          : '';
    return title ? { text, title } : { text };
  } catch (error) {
    if (error instanceof KnowledgeBaseTextError) throw error;
    throw new KnowledgeBaseTextError('extract_failed', `Failed to parse EPUB "${filePath}": ${errorDetail(error)}`);
  }
}
