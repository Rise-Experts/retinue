/**
 * The PDF reader, against real bytes and a real fetch.
 *
 * WHY THIS FILE EXISTS: everything interesting here is I/O and a third-party parser, which is precisely
 * where a stub agrees with the bug. `unpdf`'s API was verified against a real document before the
 * adapter was written — `getDocumentProxy` gives `numPages`, `extractText({mergePages:false})` gives one
 * string per page, `getMetadata()` gives `info./Title` — and these tests keep that verified with
 * generated PDFs rather than fixtures nobody can regenerate.
 *
 * The guarded fetch is tested with a fake `fetch`, because the properties worth asserting are *refusals*
 * — a redirect, a body over the cap, a private host — and none of them should ever reach a network.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  MAX_PDF_TEXT_CHARS,
  collapsePdfText,
  extractPdfText,
  sniffImageMime,
  fetchGuardedBytes,
} from "../research.js";

/**
 * Unwraps a rejection, so a call that *resolved* fails loudly instead of vacuously.
 *
 * The same helper as `adapters/postgres/__tests__/services.test.ts`, and the same reason: `.catch((e) =>
 * e)` yields a union of the resolved value and the error, so `expect(error.code).toBe(...)` against a
 * successful call reads `undefined` and the assertion still passes. #276's test typechecking is what
 * refuses the union — a test that cannot fail is worse than no test.
 */
const thrown = (value: unknown): { code: string; message: string; retryable?: boolean } => {
  if (!(value instanceof Error)) {
    throw new Error(`expected the call to reject, and it resolved with ${JSON.stringify(value)?.slice(0, 80)}`);
  }
  return value as unknown as { code: string; message: string; retryable?: boolean };
};

/**
 * A minimal but *real* PDF, built by hand.
 *
 * Hand-built rather than checked in as a binary fixture: a fixture nobody can regenerate is a fixture
 * nobody will change when the parser does, and the page count and text have to vary per test.
 */
const pdf = (pages: readonly string[]): Uint8Array => {
  const objects: string[] = [];
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ");
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  for (const text of pages) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
    );
    /**
     * One `Tj` per line, the way a real PDF draws text.
     *
     * Measured, not assumed: a single `Tj` carrying the whole page saturates at **92 extracted
     * characters** whatever its real length, so the first version of this generator could not produce a
     * page long enough to exercise the character cap. Splitting into lines is also what a real document
     * does, which is the better reason.
     */
    const lines = (text.replace(/[()\\]/g, "").match(/.{1,80}/g) ?? [""]).map(
      (line, index) => `BT /F1 12 Tf 72 ${720 - index * 14} Td (${line}) Tj ET`,
    );
    const stream = lines.join("\n");
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
};

describe("extractPdfText", () => {
  it("reads the text of a real PDF, page by page", async () => {
    const out = await extractPdfText(pdf(["First page text.", "Second page text."]));
    expect(out.pages).toBe(2);
    expect(out.pagesRead).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.text).toContain("First page text.");
    expect(out.text).toContain("Second page text.");
  });

  it("stops at the page cap and says the read was partial", async () => {
    /**
     * `MAX_PAGES = 30`, transcribed — *"a page cap so a 500-page report does not stall a chat turn"*.
     * `truncated` is the half that matters: without it a summary of the first thirty pages of a
     * four-hundred-page report reads as a summary of the report.
     */
    const out = await extractPdfText(pdf(Array.from({ length: MAX_PDF_PAGES + 5 }, (_, i) => `Page ${i + 1}.`)));
    expect(out.pages).toBe(MAX_PDF_PAGES + 5);
    expect(out.pagesRead).toBe(MAX_PDF_PAGES);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain(`Page ${MAX_PDF_PAGES}.`);
    expect(out.text).not.toContain(`Page ${MAX_PDF_PAGES + 1}.`);
  });

  it("caps the text and marks it truncated", async () => {
    // *"A character cap so one tool result cannot swallow the model's context window."*
    const long = "word ".repeat(600).trim();
    const out = await extractPdfText(pdf(Array.from({ length: 8 }, () => long)));
    expect(out.text.length).toBeLessThanOrEqual(MAX_PDF_TEXT_CHARS);
    expect(out.truncated).toBe(true);
  });

  it("refuses a file that is not a PDF, naming what happened", async () => {
    // Verified against the real parser: pdfjs answers "Invalid PDF structure."
    await expect(extractPdfText(new TextEncoder().encode("this is not a pdf"))).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("refuses a PDF with no extractable text rather than returning an empty string", async () => {
    /**
     * *"Overwhelmingly a scanned/image-only PDF; there is no OCR here, and saying so is more useful than
     * returning ''."* An empty string is exactly what a model fills in from memory.
     */
    await expect(extractPdfText(pdf([""]))).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("collapsePdfText", () => {
  it("collapses page furniture without touching the words", async () => {
    expect(collapsePdfText("  a \n\n\n\n b  \r\n c \n")).toBe("a\n\nb\nc");
  });

  it("leaves non-Latin text intact", async () => {
    // *"Script-agnostic, so non-Latin text passes through intact"* — which rules out anything that
    // reasons about word characters.
    expect(collapsePdfText("مرحبا\n\n\n世界")).toBe("مرحبا\n\n世界");
  });
});


describe("sniffImageMime", () => {
  /**
   * The mime comes from the **bytes**, not from a filename or a `content-type`.
   *
   * An extension is a claim by whoever wrote the link and a header is a claim by the server. Getting it
   * wrong is a decode error inside the provider, which surfaces as the model failing rather than as a
   * bad input — which is the expensive kind of wrong.
   */
  const bytes = (...values: readonly number[]) => new Uint8Array([...values, ...Array(16).fill(0)]);

  it("recognises the four formats a vision model can read", () => {
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageMime(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(
      sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0])),
    ).toBe("image/webp");
  });

  it("refuses a format nothing can decode rather than guessing", () => {
    // A TIFF, a PDF and a text file. Each would reach the provider and fail there.
    for (const header of [bytes(0x49, 0x49, 0x2a, 0x00), bytes(0x25, 0x50, 0x44, 0x46), bytes(0x68, 0x69)]) {
      expect(() => sniffImageMime(header)).toThrow(/PNG, JPEG, GIF or WebP/);
    }
  });

  it("does not read a RIFF container that is not WebP as WebP", () => {
    // A WAV file starts `RIFF` too. The format tag at offset 8 is what distinguishes them.
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45, 0, 0, 0, 0]);
    expect(() => sniffImageMime(wav)).toThrow();
  });
});

describe("fetchGuardedBytes", () => {
  // Named for what it does, not its first caller: `describe_image` fetches through it too, with its own
  // caps. The policy is what must not differ between them.
  const response = (init: { status?: number; body?: Uint8Array; headers?: Record<string, string> }) => {
    const bytes = init.body ?? new Uint8Array([1, 2, 3]);
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      headers: new Headers(init.headers ?? {}),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    } as unknown as Response;
  };

  it("reads a body and returns its bytes", async () => {
    const bytes = await fetchGuardedBytes("https://example.test/a.pdf", {
      fetchImpl: (async () => response({ body: new Uint8Array([37, 80, 68, 70]) })) as never,
    });
    expect([...bytes]).toEqual([37, 80, 68, 70]);
  });

  it("refuses a private host without making the request", async () => {
    /**
     * The egress policy is the platform's `validateHttpEgress`, imported rather than rewritten — its own
     * header says why: *"writing the checks again in the tool would be a second SSRF defence that drifts
     * from the first, and the one that drifts is the one nobody re-reads."*
     */
    let called = false;
    for (const url of ["http://169.254.169.254/latest/meta-data/", "https://localhost/a.pdf", "file:///etc/passwd"]) {
      await expect(
        fetchGuardedBytes(url, { fetchImpl: (async () => ((called = true), response({}))) as never }),
        url,
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(called, "the policy must refuse before any request").toBe(false);
  });

  it("refuses a redirect instead of following it, and says where it pointed", async () => {
    /**
     * The platform's decision, adopted deliberately: following one lets a permitted host bounce the
     * request to a forbidden one. The old runtime followed redirects by hand and re-validated each hop —
     * the same defence spelled differently, but this way there is one rule.
     */
    const failure = thrown(
      await fetchGuardedBytes("https://example.test/a.pdf", {
        fetchImpl: (async () => response({ status: 302, headers: { location: "http://169.254.169.254/" } })) as never,
      }).catch((error: unknown) => error),
    );
    expect(failure.code).toBe("forbidden");
    expect(failure.message).toContain("169.254.169.254");
  });

  it("stops reading at the byte cap rather than buffering the whole body", async () => {
    /**
     * Deleting the cap does not fail this assertion — it **kills the vitest worker**, which is the
     * finding rather than a shortcoming of the test: without a bound the reader drains the body into
     * memory and takes the process with it. *"The whole PDF must be resident to parse it"*, so the cap is
     * the thing standing between a link and the container.
     */
    /**
     * The cap is enforced **while reading**: `await response.arrayBuffer()` on a multi-gigabyte body
     * buffers all of it before any length check could run. The chunk here is one byte over.
     */
    const megabyte = new Uint8Array(1024 * 1024);
    /**
     * Five megabytes of headroom, not one.
     *
     * With one, the reader stops on exactly the last chunk and "stopped early" is unmeasurable — the
     * first version asserted `26 < 26`. The headroom is what makes the difference between abandoning
     * the body and draining it observable.
     */
    const total = Math.ceil(MAX_PDF_BYTES / megabyte.byteLength) + 5;
    let sent = 0;
    const streaming = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          /**
           * **Finite**, and that is the point of the number.
           *
           * The first version streamed until the reader stopped asking, so deleting the cap made this
           * test *hang* rather than fail — and a hang in CI reads as a flaky timeout, not as a broken
           * guarantee. One megabyte over the cap terminates either way: with the cap the read aborts
           * early, without it the stream ends and the assertion below fails cleanly.
           */
          if (sent >= total) controller.close();
          else {
            sent += 1;
            controller.enqueue(megabyte);
          }
        },
      }),
    } as unknown as Response;
    await expect(
      fetchGuardedBytes("https://example.test/big.pdf", { fetchImpl: (async () => streaming) as never }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // Stopped early: the cap is enforced while reading, not after the body is buffered.
    expect(sent, "the reader must abandon the body rather than drain it").toBeLessThan(total);
  });

  it("reports an empty download rather than parsing nothing", async () => {
    await expect(
      fetchGuardedBytes("https://example.test/a.pdf", {
        fetchImpl: (async () => response({ body: new Uint8Array() })) as never,
      }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("passes the server's status through when it is not a success", async () => {
    const failure = thrown(
      await fetchGuardedBytes("https://example.test/a.pdf", {
        fetchImpl: (async () => response({ status: 404 })) as never,
      }).catch((error: unknown) => error),
    );
    expect(failure.message).toContain("404");
    // A 404 is the caller's problem to report; a 5xx is worth retrying.
    expect(failure.retryable).toBe(false);
  });
});
