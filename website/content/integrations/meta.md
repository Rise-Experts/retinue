---
sidebar_position: 8
---

# WhatsApp and Instagram

Send WhatsApp messages inside the rules Meta actually enforces, and read and publish to Instagram. One package,
because they are one API, one token and one app review.

```bash
npm i @retinue/tools-meta
```

## Start here: Meta's app review is the blocker

For most teams this is the whole difficulty, and it is worth saying before any code. **There is no WhatsApp
Business or Instagram API key.** Every token comes from a Meta app that has passed review, and review means a
business verification, a privacy policy URL, a screencast of your use case, and a wait measured in weeks.

The permissions you need, by what you want the agent to do:

| To use | Permission | Also required |
|---|---|---|
| `whatsapp_send_*`, `whatsapp_mark_read` | `whatsapp_business_messaging` | A verified business, a registered phone number, and a WhatsApp Business Account |
| `whatsapp_list_templates` | `whatsapp_business_management` | Templates are approved individually, and that is a second queue |
| `instagram_get_account`, `instagram_list_media`, `instagram_get_media` | `instagram_basic` | A **professional** (Business or Creator) account, linked to a Facebook Page |
| `instagram_publish_media` | `instagram_content_publish` | The account must not be a personal one |
| `instagram_reply_comment` | `instagram_manage_comments` | |
| Any of the above | `pages_show_list`, `pages_read_engagement` | Meta requires these to resolve the Page the account hangs off |

Two more facts that surprise people:

- **A user access token is short-lived** — about an hour. Exchange it for a long-lived token (60 days) or use a
  System User token, which does not expire. An expired token comes back here as `unauthorized` with a message
  saying so, rather than as a mysterious failure.
- **Template approval is per template, per language, and per business account.** A template that works in one
  WABA does not exist in another.

## Tools

### WhatsApp Business

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `whatsapp_list_templates` | `read` | never | **Not optional.** Names are per business account; reports each template's parameter count |
| `whatsapp_send_template` | `external-write` | **always** | The only thing sendable outside the service window. Parameter count validated locally |
| `whatsapp_send_message` | `external-write` | **always** | Free text. **Requires `lastInboundAt`** as evidence the window is open |
| `whatsapp_send_media` | `external-write` | **always** | One image or document, same window rule |
| `whatsapp_mark_read` | `internal-write` | never | Read receipts. Changes nothing the recipient did not cause |

### Instagram

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `instagram_get_account` | `read` | never | Follower, following and media counts |
| `instagram_list_media` | `read` | never | With like and comment counts |
| `instagram_get_media` | `read` | never | One post plus its comments, each with the id the reply tool takes |
| `instagram_publish_media` | `external-write` | **always** | Public and immediate. Category `publishing` |
| `instagram_reply_comment` | `external-write` | **always** | A public reply, attributed to the account. Category `publishing` |

The two Instagram writes are `publishing`; the WhatsApp sends are `communication`. That distinction is not
cosmetic — a message to one recipient is not a broadcast, and a tenant switching off `publishing` should keep
its customer support. The reasoning is in `docs/23`'s #228 decision.

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createMetaToolkit } from "@retinue/tools-meta";

const agent = createAgent({
  manifest: {
    id: "support",
    name: "Support",
    instructions:
      "Answer customer messages on WhatsApp. If someone last wrote more than a day ago, you must use an approved template.",
    modelPolicy: { role: "smart" },
  },
  tools: [
    createMetaToolkit({
      credentialRef: "meta",
      resolver: createStaticCredentialResolver({ meta: process.env.META_ACCESS_TOKEN ?? "" }),
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
      instagramAccountId: process.env.INSTAGRAM_ACCOUNT_ID,
    }),
  ],
});
```

**Wiring is the toggle.** A surface with no id contributes no tools at all, rather than tools that always answer
"not configured" — the second kind costs the model a turn to discover and reads, in a transcript, exactly like a
broken integration.

## Credentials and scopes

Covered above — the permission table is the scope list, because Meta's model is app review rather than token
scopes. Pass the access token through `credentialRef` like any other credential; this package reads no
environment variable, so one deployment can serve several businesses with several tokens.

## Behaviour worth knowing

**The 24-hour service window is checked before the request.** A free-text WhatsApp message is legal only within
24 hours of that user messaging the business. `whatsapp_send_message` and `whatsapp_send_media` require
`lastInboundAt` — the ISO timestamp of their most recent message — and refuse locally without it:

```
A free-text WhatsApp message is legal only inside the 24-hour customer service window, which opens
when the user messages the business. Pass `lastInboundAt` — the ISO timestamp of their most recent
message — as evidence of it. If they have not messaged recently, use whatsapp_send_template instead.
```

This is the most opinionated thing in the package, and the reason is that Meta's own refusal is unusable: error
code `131047`, no explanation. A model that received it would rephrase and try again, which cannot ever work,
because the words were never the problem. When Meta *does* refuse for that reason, the failure is rewritten to
say the same thing.

A timestamp in the future is refused too. It is not evidence of anything, and accepting it would make the check
trivially bypassable.

**Template parameters are validated against the template.** Meta's error for a mismatch is
`Parameter format does not match`, naming neither the count nor the template. This fetches the definition,
counts the body's `{{1}}`, `{{2}}` placeholders, and refuses before sending:

```
The template "order_update" takes 2 parameters and 1 was supplied.
```

A template that is not `APPROVED` is refused with its actual status.

**A half-published Instagram post is never retryable.** Publishing is two calls — create a container, then
publish it. If the publish fails, the container still exists, and retrying the tool creates a *second* container
and can publish the post twice. So that failure is `conflict`, `retryable: false`, and names the container id:

```
The Instagram media container 17895... was created but publishing it failed: <reason>
Do not retry this tool — a retry creates a second container and can publish the post twice.
The container expires on its own after 24 hours.
```

A failure at the *container* step is retryable, because nothing was created. That distinction is the whole
point, and both halves are tested.

**Meta's rate limits arrive as `400`, not `429`.** Codes `4`, `17`, `32` and `613` are application-level limits
and are classified `rate_limited` and retryable. A genuine `429` with `Retry-After` honours the header rather
than using the default backoff.

**Message content is untrusted.** It arrives fenced. A customer message instructing the model to send something
is data, and the send would still stop for approval.

## Limits

| Not offered | Why |
|---|---|
| Creating or editing message templates | Templates go through Meta's approval queue; submitting one is a business act with a review cost, not an agent's call |
| Deleting Instagram posts or comments | Irreversible, and a deletion is itself public. Not offered in either direction |
| Instagram Stories and carousels | Stories expire and carousels need N containers plus a parent — each is a different publish flow, and a partial version would hide that |
| Media upload from bytes | Both APIs take a public URL. Accepting bytes would mean this package hosting a file, which is a storage decision a toolkit should not make |
| WhatsApp interactive messages (buttons, lists) | A structured payload whose shape is worth its own design pass rather than a guess |
| Facebook Pages, Ads, Insights | Separate products with separate reviews. Naming them here as declined rather than forgotten |
| Instagram DMs | A second messaging surface with its own window rules, close enough to WhatsApp's to be confused with it. Worth its own task |
| Webhooks | Inbound messages are how the service window opens, and receiving them is a deployment's HTTP endpoint rather than a tool |
