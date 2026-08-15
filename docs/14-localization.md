# Localization (i18n)

A user must be able to run the whole experience in their own language — tool-call names,
retry indicators, statuses, errors and every other piece of UI chrome. This is a
start-of-project decision because of one rule that is expensive to retrofit.

## The core rule

> **The backend emits stable machine identifiers and structured data — never pre-localized
> UI prose. The frontend owns all localization.**

If the runtime ever emitted `"Retrying in 3 seconds"` as a string, the client could never
cleanly re-localize it. So everything the runtime, events and contracts produce is a stable
code plus structured params:

| Shown to the user | Backend emits (stable) | Frontend renders (localized) |
|---|---|---|
| Tool-call name | `create_post` (tool `name`) | `tool.create_post.label` → "Create post" / "Beitrag erstellen" |
| Retry indicator | `run.retry-pending` + `{attempt, maxAttempts, nextAttemptAt}` | ICU `retry.pending` → "Versuch 2 von 5, erneut in ~3 s" |
| Run status | `retry-pending` (enum) | `status.retry-pending` → localized label |
| Error | `error.code` + safe params | `error.<code>` → localized message |
| Assistant content / drafts | model output **in the target locale** | shown as-is |

The locale comes from `ExecutionContext.locale` (docs/02); it is host-constructed and model
input can never override it.

## Frontend message catalog

The `react`/`ui` packages resolve stable ids to display strings through a **locale-keyed
message catalog**:

- **Resolution**: `id → string` for the active locale.
- **Interpolation**: ICU message format, fed the event's structured params (this is *why* the
  retry event carries `attempt`/`maxAttempts`, not a sentence) — including plurals and
  locale-aware number/date/currency via the `Intl` API. Timezone comes from context.
- **Fallback chain**: requested locale → default locale → the raw id (never a blank string).
- **Custom catalogs**: a consuming app registers its own catalog and overrides, merged over the
  built-in one. Custom part renderers receive the same catalog.

The catalog is data, not code, so adding a language is shipping a JSON file — no rebuild of the
generic packages.

## Localizable descriptor labels

Tool and skill descriptors (docs/03) separate the two audiences:

- **Model-facing** catalog/description stays canonical (English) — the model needs one stable
  vocabulary, not translations.
- **User-facing** `label`/`description` is localizable: either a catalog **key** the frontend
  resolves, or a `locale → string` map on the descriptor. Integration-registered tools
  (e.g. ShareFlow) ship their own catalog entries the same way.

## Model-generated content

UI chrome is localized on the client; the *content the model writes* (assistant messages,
drafts) is produced in the target language by passing `locale` to the agent — already available
in context. This is separate from chrome localization and is not catalog-driven.

## Acceptance criteria

- No backend contract, event or tool result carries pre-localized user prose — only stable
  codes and structured params.
- Switching `locale` re-renders every label, status, retry indicator and error without any
  backend change.
- A missing catalog key falls back to the default locale, then the raw id — never a blank.
- A consuming app can register a custom catalog and override any built-in string.
- Numbers, dates and currency render per the active locale via `Intl`; timezone from context.
- Integration-registered tools localize their user-facing labels through the same catalog.
