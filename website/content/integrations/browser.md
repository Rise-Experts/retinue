---
sidebar_position: 15
---

# Browser

For pages that will not yield to a fetch. **Try [web scraping](./scrape) first** — it handles most pages for
the cost of one request, where this costs a process, memory and seconds.

```bash
npm i @retinue/tools-browser
```

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `browser_navigate` | `read` | **always** | Opens a URL, returns rendered text plus the elements you can act on |
| `browser_read` | `read` | never | Re-read after an interaction. Required before acting again |
| `browser_click` | `internal-write` | `policy` | By element reference from a prior read. Never coordinates |
| `browser_type` | `internal-write` | `policy` | Into a referenced field. Password fields are refused |
| `browser_screenshot` | `read` | never | Bounded bytes |
| `browser_close` | `internal-write` | never | Explicit teardown; sessions also expire on their own |

The interaction tools are `internal-write` rather than `external-write`, and the asymmetry is deliberate. A
click changes state on somebody else's server, so it is not a `read`. But this package cannot know *what* the
click does — the same button is "expand section" on one page and "delete account" on another — so
`external-write` would claim a certainty nobody has and gate expanding an accordion behind the same approval as
sending money. `internal-write` is the honest label: *this changed something, and we cannot tell you what.*

## Wire it up

```ts
import { createBrowserToolkit, type BrowserDriver } from "@retinue/tools-browser";

// Yours: a Playwright/CDP process, or a hosted service. There is deliberately no default — see Limits.
declare const driver: BrowserDriver;

const toolkit = createBrowserToolkit({
  driver,
  maxLifetimeMs: 5 * 60_000,
  maxMemoryKb: 1_500_000,
  maxSessions: 3,
});
```

## Credentials and scopes

**This toolkit takes no credential, and never types one into a page.** No tool has a `password`, `token` or
`apiKey` argument, and `browser_type` refuses `input[type=password]` whatever the text is — refusing the
*field* is checkable in a way that inspecting the text is not.

A hosted driver will need its own API key. That is the driver's configuration and these tools never see it.

## Behaviour worth knowing

**The prerequisite: you provide the browser.** Nothing here bundles Chromium. It is ~150MB, its build has to
match the driver's, and a package that downloads a binary on install fails in every locked-down environment it
will actually be deployed into. Supply a driver over a browser you run — a container image with Chromium and
Playwright, or a hosted service.

**Interactions take references, never coordinates.** `click(412, 890)` means a different element at a different
window size, after a font loads, or once a cookie banner appears — and clicking the wrong thing *succeeds*.
Every reference comes from a `browser_navigate` or `browser_read`, and **an interaction invalidates the
references it came from**: after a click you must read again. That is stricter than strictly necessary, because
this package cannot know which clicks changed the page and guessing wrong is an unrequested action on somebody
else's site.

**Sessions end on their own.** A hard lifetime and a hard memory ceiling, plus a cap on concurrent sessions.
They are separate limits because they catch different failures — a runaway script hits memory in seconds and
sits inside any lifetime; a forgotten session hits the lifetime and never approaches the memory cap. Teardown
kills the process **group**, because a browser is a tree and killing the launcher leaves the renderers running.

**A session that lands somewhere private is closed.** A page can move itself with `location.replace` or a meta
refresh, which no pre-navigation check can see. The landing URL is re-checked, and a session that ended up on
a private or metadata address is torn down with nothing from that page returned.

**Rendered text is untrusted**, fenced exactly as a scraped page is. See the decision in `docs/23`.

**Read the isolation argument.** `docs/30-browser-isolation.md` sets out what the `Sandbox` port gives, why a
process that needs network cannot have its strongest guarantee, what replaces it — and the one risk this design
does **not** close, which is a page making its own requests to internal addresses with JavaScript. That needs
container-level egress rules denying RFC 1918 and link-local ranges. Treat it as a deployment prerequisite.

## Limits

**No default driver.** A default would mean this package decides how a browser is launched and isolated on your
host, which is exactly the decision that has to be made explicitly. A toolkit that quietly spawned a browser
because it found one on the `PATH` is the "works on the machine where it was configured" shape with an unusually
large blast radius.

**No authenticated flows.** Signing in is not something this does. There is no credential argument, password
fields are refused, and no amount of arranging the tools produces a login. If a page needs a session, a person
has to establish it.

**No CAPTCHA handling and no bot-detection evasion.** No solving, no third-party solver, no fingerprint
spoofing, no proxy rotation. A site that wants to refuse an automated client should be able to.

**No file upload or download.** A file chooser is not driven and a download is not captured. Both are ways for
a page to reach the host filesystem, which is the thing the isolation exists to prevent.

**No multi-tab or window management.** One page per session. Tabs multiply the renderer count and the memory
footprint for very little that a second session does not do more simply.

**No arbitrary JavaScript execution.** There is no `browser_evaluate`. It would make every other control here
advisory — the reference discipline, the password refusal and the URL checks are all bypassable by a page
script the model wrote.

**Not a replacement for `web_scrape`.** If a fetch renders the page, use the fetch.
