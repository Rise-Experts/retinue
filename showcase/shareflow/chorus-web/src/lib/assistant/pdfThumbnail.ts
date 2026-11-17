/**
 * A PDF's first page as a small image — #628 part 2.
 *
 * Generated PDFs showed a generic tile in the media pane, the reply gallery and a post's attachments.
 *
 * ## Why in the browser, with pdf.js
 *
 * The alternative was rendering a PNG next to each PDF when the agent service prints it (it already runs
 * Chromium). That covers only PDFs printed after the change, needs a second stored object per PDF, a new
 * store-media parameter and a signing rule for the sibling path — and a screenshot of the source HTML is
 * not the printed first page (print CSS, page size and margins differ). Drawing page 1 of the PDF itself
 * covers every PDF there is — generated, uploaded, attached to a post, from before this change — with no
 * storage, schema or service change, and is exactly the page the viewer will open on.
 *
 * pdf.js is imported only when a PDF tile is on screen, renders one thumbnail at a time (a grid of twelve
 * must not decode twelve documents at once), and each result is kept for the session under the file's
 * **storage path**, since its signed URL changes every hour.
 *
 * The queue and the cache are here, apart from the component, so they are testable without a DOM.
 */

export type RenderThumbnail = (url: string, width: number) => Promise<string>;

/** The thumbnail's width in CSS pixels, doubled for a sharp tile on a high-density screen. */
export const PDF_THUMB_WIDTH = 320;

const done = new Map<string, string>();
const failed = new Set<string>();
const inFlight = new Map<string, Promise<string | null>>();
/** One render at a time: each waits for the one before it. */
let queue: Promise<unknown> = Promise.resolve();

/** A thumbnail already drawn this session. */
export const peekPdfThumbnail = (key: string): string | undefined => done.get(key);

/**
 * The thumbnail for `key` (a storage path, or the URL without its query), drawn from `url` at most once.
 *
 * `null` when the file cannot be drawn — not a PDF, unreadable, blocked. A failure is remembered so a grid
 * does not retry a broken file on every render; it is not a thrown error, because a tile in a list must
 * never take the list down with it.
 */
export const pdfThumbnail = (
  key: string,
  url: string,
  render: RenderThumbnail = renderWithPdfJs,
  width: number = PDF_THUMB_WIDTH,
): Promise<string | null> => {
  const cached = done.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  if (failed.has(key)) return Promise.resolve(null);
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;

  const run = queue.then(() => render(url, width));
  queue = run.catch(() => undefined);
  const outcome = run.then(
    (image) => {
      done.set(key, image);
      return image;
    },
    () => {
      failed.add(key);
      return null;
    },
  );
  inFlight.set(key, outcome);
  void outcome.finally(() => inFlight.delete(key));
  return outcome;
};

/** For tests. */
export const resetPdfThumbnails = (): void => {
  done.clear();
  failed.clear();
  inFlight.clear();
  queue = Promise.resolve();
};

/** The key a signed URL is cached under when the caller has no storage path: the URL without its token. */
export const pdfKeyOf = (url: string): string => url.split(/[?#]/)[0] ?? url;

/** True for a path or URL naming a PDF (the query of a signed URL is ignored). */
export const isPdfPath = (value: string): boolean => pdfKeyOf(value).toLowerCase().endsWith('.pdf');

type PdfJs = typeof import('pdfjs-dist');
let pdfjs: Promise<PdfJs> | undefined;

/** pdf.js and its worker, loaded once and only when a PDF tile is on screen. */
const loadPdfJs = (): Promise<PdfJs> => {
  pdfjs ??= import('pdfjs-dist').then((module) => {
    if (module.GlobalWorkerOptions.workerPort === null) {
      module.GlobalWorkerOptions.workerPort = new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), {
        type: 'module',
      });
    }
    return module;
  });
  return pdfjs;
};

/** Page 1 of the PDF at `url`, `width` pixels wide, as a JPEG data URL. */
async function renderWithPdfJs(url: string, width: number): Promise<string> {
  const { getDocument } = await loadPdfJs();
  const task = getDocument({ url });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const scale = (width * 2) / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    // The loading task owns the document and its worker-side state; destroying it frees both.
    void task.destroy();
  }
}
