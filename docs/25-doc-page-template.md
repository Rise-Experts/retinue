# The Integration Page Template

Status: specified and enforced, 27 Aug 2026 · REQ-048 ([#207](https://github.com/Rise-Experts/retinue/issues/207)),
task [#217](https://github.com/Rise-Experts/retinue/issues/217)
Enforced by: `npm run check:template` (`scripts/check-doc-template.mjs`)

## Why a template at all

The reference we are copying is Agno's, and the thing worth copying is not their prose — it is that **all 139 of
their toolkit pages have the same shape.** You learn the template once and then read a hundred pages quickly:
where the parameters table is, where the function list is, where the auth notes are. The reader's eye knows where
to go before they have read a word.

Ours were bespoke by default. With three integrations that costs nothing; with thirty it costs the reader a fresh
orientation on every page, and it costs the writer a decision that has no right answer and gets made differently
every time.

So the shape is fixed, and the fixing is a build step rather than a habit. A convention nobody enforces survives
about a month, and the direction it decays in is predictable: the page written under deadline is the one missing
the limits section, which is the section a reader most needs.

## Required sections

Every page in `website/content/integrations/` — except the section index, `overview.md`, which is named as an
exemption in the checker rather than silently skipped — carries these headings, in this order. Extra sections may
appear between them; the order of the required ones may not change.

| Heading | Purpose |
|---|---|
| `## Tools` | A table: tool, effect, approval, and a note. The first thing a reader wants is what this can do |
| `## Wire it up` | One runnable sample. Typechecked against the published package by `check:consumer` |
| `## Credentials and scopes` | What token, from where, with which scopes. The most common reason an integration does not work |
| `## Behaviour worth knowing` | The vendor's surprises. Rate limits, envelopes that lie, pagination, untrusted content |
| `## Limits` | What is deliberately **not** built, and why. A reader looking for a missing tool deserves to know it was a decision |

`## Limits` is the one most likely to be skipped and the one that earns the most. "No file upload — multipart to a
second host" answers a question that would otherwise become an issue, and it distinguishes *declined* from
*forgotten*, which are very different signals about a project.

## What the template does not fix

Voice, length, and which of the vendor's surprises are worth a paragraph. A template that specified those would
produce pages nobody wanted to write. The rule is that a reader can find the same five things in the same order,
not that every page reads the same.
