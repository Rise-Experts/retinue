# @retinue/tools-browser

Drive a real browser for a [Retinue](https://github.com/Rise-Experts/retinue) agent, when a page will not yield
to a fetch.

```bash
npm i @retinue/tools-browser
```

**The escalation, not the default.** [`@retinue/tools-scrape`](https://www.npmjs.com/package/@retinue/tools-scrape)
handles most pages for the cost of one request; this costs a process, memory and seconds. Every tool
description says so, and a `find_tools` test asserts that a query about reading a page ranks `web_scrape` above
anything here — because a browser is the more capable-*sounding* tool and a model will otherwise reach for it
first.

## Usage

```ts
import { createBrowserToolkit, type BrowserDriver } from "@retinue/tools-browser";

// Yours: a Playwright/CDP process, or a hosted service. There is no default, deliberately.
declare const driver: BrowserDriver;

const toolkit = createBrowserToolkit({ driver, maxLifetimeMs: 5 * 60_000, maxSessions: 3 });
```

**No browser is bundled.** Chromium is ~150MB and its build has to match the driver's; a package that
downloads a binary on install fails in every locked-down environment it will be deployed into. You provide the
browser.

## What keeps this defensible

- **References, never coordinates.** Every click and keystroke names an element the model saw in a read.
  `click(412, 890)` means something different at another window size, and clicking the wrong thing succeeds.
  An interaction invalidates the references it came from, so a stale reference is refused rather than acted on.
- **No credential ever reaches a page.** No `password`, `token` or `apiKey` argument exists, and `browser_type`
  refuses `input[type=password]` whatever the text is.
- **Hard session caps** on lifetime, memory and concurrency — and teardown kills the process **group**, because
  a browser is a tree and killing the launcher leaves the renderers running.
- **The same SSRF checks as `tools-scrape`**, from `@retinue/agentkit/tools`, re-run on the URL the page
  actually landed on so a self-redirect cannot reach internal network space.
- **Rendered text is untrusted content**, fenced exactly as a scraped page is.

The isolation argument — what the platform's `Sandbox` port gives, why a process that needs network cannot have
its strongest guarantee, what replaces it, and the one risk this does not close — is in
`docs/30-browser-isolation.md`.

MIT.
