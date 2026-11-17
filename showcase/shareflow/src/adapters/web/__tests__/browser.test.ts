/**
 * The browser, its slot, and the request guard.
 *
 * WHY THIS FILE EXISTS: the slot is here because a headless Chromium OOM-killed the old runtime's API
 * process, and the guard is here because that runtime screenshotted whatever a page redirected to. Both
 * are properties of *coordination* and *refusal* — neither is visible from a tool test, and neither
 * needs a real browser to assert.
 */
import { describe, expect, it } from "vitest";

import { assertNoRedirect, guardRequests, withBrowserSlot, withPage, type PageLike, type RouteLike } from "../browser.js";
import { createBrowserRenderService } from "../render.js";

/** A page that records what it was asked to do, and the routes it registered. */
/**
 * Unwraps a rejection, so a call that *resolved* fails loudly instead of vacuously.
 *
 * `.catch((e) => e)` yields a union of the resolved value and the error, and reading `.code` off a
 * success is `undefined` while the assertion still passes.
 */
const thrown = (value: unknown): { code: string; message: string } => {
  if (!(value instanceof Error)) throw new Error(`expected a rejection, got ${JSON.stringify(value)?.slice(0, 60)}`);
  return value as unknown as { code: string; message: string };
};

const fakePage = (over: Partial<PageLike> = {}) => {
  const routed: ((route: RouteLike) => Promise<void> | void)[] = [];
  let landed = "";
  const page = {
    url() {
      return landed;
    },
    async route(_pattern: string, handler: (route: RouteLike) => Promise<void> | void) {
      routed.push(handler);
    },
    async goto(url: string) {
      landed = url;
      return undefined;
    },
    async setContent() {
      return undefined;
    },
    async waitForFunction() {
      return undefined;
    },
    async screenshot() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    },
    async pdf() {
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
    async title() {
      return "A page";
    },
    async evaluate() {
      return undefined as never;
    },
    async setViewportSize() {
      return undefined;
    },
    ...over,
  } as unknown as PageLike;
  return { page, routed };
};

const fakeChromium = (page: PageLike, log: string[] = []) => ({
  log,
  chromium: {
    async launch() {
      log.push("launch");
      return {
        async newPage() {
          return page;
        },
        async close() {
          log.push("close");
        },
      };
    },
  },
});

/** Drives one registered route handler and reports what it decided. */
const decide = async (handler: (route: RouteLike) => Promise<void> | void, url: string) => {
  let verdict = "none";
  await handler({
    request: () => ({ url: () => url }),
    async abort() {
      verdict = "abort";
    },
    async continue() {
      verdict = "continue";
    },
  });
  return verdict;
};

describe("the request guard", () => {
  it("refuses a request to somewhere the egress policy forbids", async () => {
    /**
     * This covers **subresources**, which is the hole `capture.py` had: a page could fetch a LAN address
     * and the render would include it. Measured against a real Chromium — a page requesting two off-host
     * subresources had both aborted here.
     *
     * It does **not** cover a navigation redirect. Playwright's route handler is not called for one,
     * measured the same way, and `assertNoRedirect` plus the landed-URL check are what close that.
     */
    const { page, routed } = fakePage();
    await guardRequests(page);
    const handler = routed[0]!;
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "https://localhost/admin",
      "http://10.0.0.1/",
      "file:///etc/passwd",
    ]) {
      expect(await decide(handler, url), url).toBe("abort");
    }
  });

  it("lets an ordinary public page and its subresources through", async () => {
    const { page, routed } = fakePage();
    await guardRequests(page);
    const handler = routed[0]!;
    for (const url of ["https://acme.test/pricing", "https://cdn.acme.test/logo.png"]) {
      expect(await decide(handler, url), url).toBe("continue");
    }
  });

  it("lets the schemes that never leave the process through, and refuses file:", async () => {
    /**
     * `about:` and `data:` and `blob:` are how a `setContent` page is built — the PDF renderer needs
     * them. `file:` reads the container's disk and is the one that is not like the others.
     */
    const { page, routed } = fakePage();
    await guardRequests(page);
    const handler = routed[0]!;
    expect(await decide(handler, "about:blank")).toBe("continue");
    expect(await decide(handler, "data:text/html,<p>hi")).toBe("continue");
    expect(await decide(handler, "file:///app/.env")).toBe("abort");
  });
});

describe("the browser slot", () => {
  it("runs one at a time, in order", async () => {
    /**
     * *"A second concurrent browser roughly doubles peak memory, and page reads are not the
     * throughput-critical path — waiting a few seconds is strictly better than being OOM-killed."*
     *
     * Asserted as interleaving rather than as a count: two overlapping renders must not have their
     * bodies interleaved at all.
     */
    const order: string[] = [];
    const job = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name}:end`);
    };
    await Promise.all([withBrowserSlot(job("a", 20)), withBrowserSlot(job("b", 1))]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("survives a render that throws, so the next one still gets the slot", async () => {
    /**
     * The failure mode this guards: a rejected promise left in the chain is inherited by every later
     * caller, and no render ever succeeds again — one bad page taking the capability down for the
     * lifetime of the process.
     */
    await expect(withBrowserSlot(async () => {
      throw new Error("a page that could not load");
    })).rejects.toThrow("a page that could not load");
    expect(await withBrowserSlot(async () => "second")).toBe("second");
  });
});

describe("withPage", () => {
  it("closes the browser even when the body throws", async () => {
    // A leaked Chromium is exactly the memory that caused the outage this file exists for.
    const { page } = fakePage();
    const { chromium, log } = fakeChromium(page);
    await expect(
      withPage({ chromium } as never, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(log).toEqual(["launch", "close"]);
  });

  it("guards the page before the body runs", async () => {
    // A body that navigated before the route was registered would make the first request unchecked —
    // which is the only request that matters for a capture.
    const seen: string[] = [];
    const { page } = fakePage({
      async route() {
        seen.push("route");
      },
      async goto() {
        seen.push("goto");
        return undefined;
      },
    });
    const { chromium } = fakeChromium(page);
    await withPage({ chromium } as never, async (p) => p.goto("https://acme.test"));
    expect(seen).toEqual(["route", "goto"]);
  });
});

describe("assertNoRedirect", () => {
  /**
   * The defence that exists because **`page.route` does not see a navigation redirect** — measured
   * against a real Chromium, where a local page 302ing to another host was followed and the guard saw
   * only the first request. A comment claiming the route handler covered it would have been wrong in a
   * file whose whole subject is refusal.
   */
  const respond = (init: { status: number; location?: string }) =>
    (async () =>
      ({
        status: init.status,
        headers: new Headers(init.location === undefined ? {} : { location: init.location }),
        body: null,
      }) as unknown as Response) as unknown as typeof fetch;

  it("refuses a URL that redirects, and names where it pointed", async () => {
    const failure = await assertNoRedirect("https://acme.test/go", respond({ status: 302, location: "http://169.254.169.254/" }))
      .then(() => undefined)
      .catch((error: unknown) => error as { code: string; message: string });
    expect(failure?.code).toBe("forbidden");
    expect(failure?.message).toContain("169.254.169.254");
  });

  it("passes a URL that answers directly", async () => {
    await expect(assertNoRedirect("https://acme.test/", respond({ status: 200 }))).resolves.toBeUndefined();
  });

  it("does not fail the capture when the pre-flight itself cannot run", async () => {
    /**
     * Some servers reject an unadorned GET from a non-browser client, and refusing the capture for that
     * would break pages a browser loads perfectly well. The landed-URL check is what still holds.
     */
    const broken = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(assertNoRedirect("https://acme.test/", broken)).resolves.toBeUndefined();
  });
});

describe("renderDocument", () => {
  /**
   * The PDF print, driven with a fake page. What is asserted here is the *sequence* — inject the bundle,
   * validate, wait for every SVG, then print — because each step exists because of a specific failure
   * and none of them is visible from the document builder's tests.
   */
  const printing = (over: Partial<PageLike> = {}) => {
    const seen: string[] = [];
    const { page } = fakePage({
      async setContent() {
        seen.push("setContent");
        return undefined;
      },
      async addScriptTag() {
        seen.push("addScriptTag");
        return undefined;
      },
      async evaluate<T>() {
        seen.push("evaluate");
        return { ok: true, count: 2 } as unknown as T;
      },
      async waitForFunction(expression: string) {
        seen.push(`waitForFunction:${expression}`);
        return undefined;
      },
      async pdf() {
        seen.push("pdf");
        return new TextEncoder().encode("%PDF-1.4 /Type /Pages /Type /Page /Type /Page");
      },
      ...over,
    });
    return { page, seen };
  };

  /**
   * `null` means "no bundle", not `undefined`.
   *
   * A default parameter applies when the argument **is** `undefined`, so `service(page, undefined)`
   * quietly got the default bundle and the no-bundle test passed while testing the opposite. Caught
   * because the sabotage that removed the refusal *also* passed — two mistakes pointing the same way.
   */
  const service = (page: PageLike, bundle: string | null = "/app/vendor/mermaid.min.js") =>
    createBrowserRenderService({
      chromium: fakeChromium(page).chromium as never,
      settleMs: 0,
      ...(bundle === null ? {} : { mermaidBundlePath: bundle }),
    });

  const withDiagram = '<html><body><pre class="mermaid">flowchart LR\n A --> B</pre></body></html>';

  it("waits for every diagram's SVG before printing", async () => {
    /**
     * Sabotage found this gap: dropping the wait broke no test. *"Without this the print can catch the
     * raw `<pre>` source instead of the diagram"* — and the count matters, because a document with three
     * diagrams can print with the third still unrendered.
     */
    const { page, seen } = printing();
    await service(page).renderDocument({} as never, { html: withDiagram });
    expect(seen).toEqual([
      "setContent",
      "addScriptTag",
      "evaluate",
      "waitForFunction:document.querySelectorAll('pre.mermaid svg').length >= 2",
      // #660: the layout is measured (overflow, fonts) after the diagrams are drawn and before it prints.
      "evaluate",
      "pdf",
    ]);
  });

  it("refuses a document with a diagram when the deployment has no bundle", async () => {
    /**
     * Also found by sabotage. **Refused rather than degraded**, and the old renderer's reason is exact:
     * *"printing the diagram's raw source into the document is the exact bug this path exists to fix,
     * and a silently ugly PDF is worse than a clear error — the bundle is baked into the image, so its
     * absence is a deployment fault, not a user one."*
     */
    const { page, seen } = printing();
    await expect(service(page, null).renderDocument({} as never, { html: withDiagram })).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(seen, "no browser work should happen at all").toEqual([]);
  });

  it("prints a document with no diagram without paying for the bundle", async () => {
    // *"Lets the renderer pay for the bundle injection and the render wait only when a document actually
    // has a diagram — the common case is a plain report."*
    const { page, seen } = printing();
    const printed = await service(page, null).renderDocument({} as never, {
      html: "<html><body><p>Just words.</p></body></html>",
    });
    // No bundle and no diagram run — only the #660 layout measurement before the print.
    expect(seen).toEqual(["setContent", "evaluate", "pdf"]);
    expect(printed).toMatchObject({ mime: "application/pdf", pages: 2 });
  });

  it("names which diagram failed", async () => {
    // *"'The second diagram' is the difference between a fixable error and a guess."*
    const { page } = printing({
      async evaluate<T>() {
        return { ok: false, index: 2, message: "Parse error on line 3" } as unknown as T;
      },
    });
    const failure = thrown(
      await service(page)
        .renderDocument({} as never, { html: withDiagram })
        .catch((error: unknown) => error),
    );
    expect(failure.code).toBe("invalid_input");
    expect(failure.message).toContain("Diagram 2 in that document");
    expect(failure.message).toContain("Parse error on line 3");
  });

  it("refuses an empty PDF rather than storing nothing", async () => {
    const { page } = printing({
      async pdf() {
        return new Uint8Array();
      },
    });
    await expect(service(page).renderDocument({} as never, { html: "<html><body>x</body></html>" })).rejects.toMatchObject({
      code: "provider_error",
    });
  });

  it("prints A4 with the margins the stylesheet assumes", async () => {
    /**
     * The `@page` rule and the print call have to agree: a stylesheet laid out for 18mm margins printed
     * at Chromium's default gets a different column width than every measurement in the CSS assumed.
     */
    let options: Record<string, unknown> = {};
    const { page } = printing({
      async pdf(passed?: Record<string, unknown>) {
        options = passed ?? {};
        return new TextEncoder().encode("%PDF-1.4 /Type /Pages /Type /Page");
      },
    });
    await service(page).renderDocument({} as never, { html: "<html><body>x</body></html>" });
    expect(options).toMatchObject({
      format: "A4",
      printBackground: true,
      margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" },
      // #661: the document's own @page decides the paper — the real print is checked in page-setup.render.test.ts.
      preferCSSPageSize: true,
    });
  });

  it("lays a page-setup document out at the width it was given, before printing (#661)", async () => {
    const viewports: { width: number; height: number }[] = [];
    const { page } = printing({
      async setViewportSize(size: { width: number; height: number }) {
        viewports.push(size);
        return undefined;
      },
    });
    await service(page).renderDocument({} as never, { html: "<html><body>x</body></html>", layoutWidth: 1920 });
    expect(viewports[0]?.width).toBe(1920);
  });

  it("prints a themed document edge to edge, its body carrying the margin (#595)", async () => {
    // Production: the dark theme printed as a dark block inside white margins — print margins are never painted.
    let options: Record<string, unknown> = {};
    const { page } = printing({
      async pdf(passed?: Record<string, unknown>) {
        options = passed ?? {};
        return new TextEncoder().encode("%PDF-1.4 /Type /Pages /Type /Page");
      },
    });
    const { buildDocumentHtml } = await import("../document.js");
    const { resolveTheme } = await import("../../../design/theme.js");
    const html = await buildDocumentHtml({ kind: "markdown", source: "# Hi", theme: resolveTheme({ themeId: "dark-tech" }) } as never);
    await service(page).renderDocument({} as never, { html });
    expect(options).toMatchObject({ margin: { top: "0", bottom: "0", left: "0", right: "0" } });
    expect(html).toContain("padding: 18mm 16mm");
  });
});

describe("captureWebsite", () => {
  /** A pre-flight that answers 200, so these tests are about the render rather than about the fetch. */
  const direct = (async () =>
    ({ status: 200, headers: new Headers(), body: null }) as unknown as Response) as unknown as typeof fetch;

  const service = (page: PageLike) =>
    createBrowserRenderService({ chromium: fakeChromium(page).chromium as never, settleMs: 0, fetchImpl: direct });

  it("returns the screenshot, the title and the URL", async () => {
    const { page } = fakePage();
    const rendered = await service(page).captureWebsite({} as never, { url: "https://acme.test/pricing" });
    expect(rendered).toEqual({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mime: "image/png",
      title: "A page",
      url: "https://acme.test/pricing",
    });
  });

  it("refuses a forbidden URL before launching a browser at all", async () => {
    /**
     * Not redundant with the per-request guard: refusing here costs nothing and says *which* rule the
     * URL broke, while the guard can only abort a load and produce "the page could not be loaded". A
     * user who pasted a localhost URL should be told that.
     */
    const { page } = fakePage();
    const { chromium, log } = fakeChromium(page);
    const svc = createBrowserRenderService({ chromium: chromium as never, settleMs: 0, fetchImpl: direct });
    await expect(svc.captureWebsite({} as never, { url: "http://169.254.169.254/" })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(log, "no browser should have started").toEqual([]);
  });

  it("reports a navigation failure as a page problem, and says a private redirect is refused", async () => {
    const { page } = fakePage({
      async goto() {
        throw new Error("net::ERR_BLOCKED_BY_CLIENT at http://10.0.0.1/\nCall log:\n  - navigating");
      },
    });
    const failure = await service(page)
      .captureWebsite({} as never, { url: "https://acme.test" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "provider_unavailable" });
    const message = (failure as { message: string }).message;
    expect(message).toContain("ERR_BLOCKED_BY_CLIENT");
    expect(message).toContain("redirects into a private network");
    // One line, not Playwright's whole call log — a tool result is read by a model and then by a person.
    expect(message).not.toContain("Call log");
  });

  it("refuses a page that moved somewhere forbidden after loading", async () => {
    /**
     * A meta refresh or a `location.href` from a script moves the page after `load`, and neither the
     * pre-flight nor the route guard sees it. `page.url()` reports where it actually landed — measured
     * against a real redirect — so the check happens *before* the screenshot.
     */
    let shot = false;
    const { page } = fakePage({
      url: () => "http://169.254.169.254/latest/meta-data/",
      async screenshot() {
        shot = true;
        return new Uint8Array([1]);
      },
    });
    await expect(service(page).captureWebsite({} as never, { url: "https://acme.test/" })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(shot, "nothing may be captured from a page that walked into a private range").toBe(false);
  });

  it("refuses before a browser starts when the URL itself redirects", async () => {
    // The pre-flight, in the service rather than on its own: no browser should be launched at all.
    const { page } = fakePage();
    const { chromium, log } = fakeChromium(page);
    const svc = createBrowserRenderService({
      chromium: chromium as never,
      settleMs: 0,
      fetchImpl: (async () =>
        ({ status: 301, headers: new Headers({ location: "http://10.0.0.1/" }), body: null }) as unknown as Response) as never,
    });
    await expect(svc.captureWebsite({} as never, { url: "https://acme.test/" })).rejects.toMatchObject({ code: "forbidden" });
    expect(log).toEqual([]);
  });

  it("still answers when the page has no title", async () => {
    // A page with no `<title>` is normal, and it must not fail the capture.
    const { page } = fakePage({
      async title() {
        throw new Error("no title");
      },
    });
    const rendered = await service(page).captureWebsite({} as never, { url: "https://acme.test" });
    expect(rendered.title).toBe("");
  });
});

/** #621: read_source's fallback — the page's text, under every guard captureWebsite has. */
describe("readPageText", () => {
  const direct = (async () =>
    ({ status: 200, headers: new Headers(), body: null }) as unknown as Response) as unknown as typeof fetch;

  it("returns the page's visible text, one paragraph per line", async () => {
    const { page } = fakePage({
      async evaluate<T>() {
        return "Pexels API\nEvery request must be authorised.\n\n  Search photos  \n" as unknown as T;
      },
    });
    const svc = createBrowserRenderService({ chromium: fakeChromium(page).chromium as never, settleMs: 0, fetchImpl: direct });
    const read = await svc.readPageText!({} as never, { url: "https://www.pexels.com/api/documentation/" });
    expect(read).toEqual({
      url: "https://www.pexels.com/api/documentation/",
      title: "A page",
      text: "Pexels API\n\nEvery request must be authorised.\n\nSearch photos",
      truncated: false,
    });
  });

  it("refuses a forbidden URL before launching a browser, like a capture", async () => {
    const { page } = fakePage();
    const { chromium, log } = fakeChromium(page);
    const svc = createBrowserRenderService({ chromium: chromium as never, settleMs: 0, fetchImpl: direct });
    await expect(svc.readPageText!({} as never, { url: "http://169.254.169.254/" })).rejects.toMatchObject({ code: "forbidden" });
    expect(log).toEqual([]);
  });

  it("reads nothing from a page that moved somewhere forbidden", async () => {
    let read = false;
    const { page } = fakePage({
      url: () => "http://10.0.0.5/admin",
      async evaluate<T>() {
        read = true;
        return "secret" as unknown as T;
      },
    });
    const svc = createBrowserRenderService({ chromium: fakeChromium(page).chromium as never, settleMs: 0, fetchImpl: direct });
    await expect(svc.readPageText!({} as never, { url: "https://acme.test/" })).rejects.toMatchObject({ code: "forbidden" });
    expect(read).toBe(false);
  });
});
