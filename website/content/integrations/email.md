---
sidebar_position: 16
---

# Email

Send a deployment's **own** mail, from its own domain, with no user grant at all. Different from
[Google Workspace](./google), which sends as an end user after an OAuth consent.

```bash
npm i @retinue/tools-email
```

## Tools

| Tool | Effect | Approval | Notes |
|---|---|---|---|
| `email_send` | `external-write` | **always** | Up to 20 recipients across to, cc and bcc **combined** |
| `email_compose_preview` | `read` | never | The exact bytes `email_send` would transmit, without sending |
| `email_get_status` | `read` | never | Where the provider reports it. SMTP does not, and says so |
| `email_list_sent` | `read` | never | Provider-dependent; SMTP keeps no record |

This is the least recoverable action in the catalogue. A sent message cannot be recalled, and unlike a post it
cannot be deleted afterwards — it is in somebody else's mailbox and that is the end of the matter. So the send
is gated, carries an idempotency key, and has a rehearsal.

## Wire it up

```ts
import { createEmailToolkit, smtpProvider } from "@retinue/tools-email";
import type { CredentialResolver } from "@retinue/agentkit/tools";

// Yours: resolves a `basic` credential — the SMTP username and password.
declare const resolver: CredentialResolver;

const toolkit = createEmailToolkit({
  provider: smtpProvider({
    host: "smtp.example.com",
    port: 587,
    credentialRef: "smtp",
    resolver,
  }),
  // Configuration, never a tool argument — see below.
  from: "alerts@yourdomain.example",
  replyTo: "support@yourdomain.example",
});
```

For an HTTP provider, swap `smtpProvider` for `httpProvider({ name: "resend", credentialRef, resolver })`. The
result shape does not change; a test asserts it.

## Credentials and scopes

`credentialRef` only — nothing here reads the environment, and a test asserts it. SMTP takes a **`basic`**
credential (username and password); an HTTP provider takes a **`bearer`**. The credential is resolved **per
call**, so a rotated secret takes effect without a restart.

**The `From` address is configuration, not a tool argument.** A model that could choose the sender could send
as anyone the domain permits. It is also the field SPF and DKIM align against, so a caller-supplied one is the
fastest route to mail that silently lands in spam.

### The prerequisite nobody can fix in code: SPF, DKIM and DMARC

**Most first sends fail here, and it is not a code problem.** Mail from a domain whose DNS does not authorise
the sender is spam-foldered or rejected outright, and the symptom is a `250 Ok` followed by nothing arriving —
which looks exactly like a bug in this package and is not.

Three records, and all three matter:

- **SPF** — a `TXT` record on the sending domain naming who may send for it. Your provider gives you the
  `include:` to add. A domain with no SPF record, or with two, fails.
- **DKIM** — a `TXT` record publishing the public key your provider signs with. This is what survives
  forwarding, where SPF does not.
- **DMARC** — a `TXT` record at `_dmarc.yourdomain` saying what a receiver should do when the first two fail.
  Start at `p=none` and read the reports before tightening; `p=reject` on a misconfigured domain silently
  destroys your mail.

**Alignment** is the part that catches people. SPF and DKIM can both pass while DMARC still fails, because
DMARC additionally requires the domain that passed to *match the `From` domain*. A provider that sends from
its own bounce domain passes SPF for that domain and fails alignment for yours. The fix is the custom
return-path or sending domain your provider documents.

None of this is checkable from inside the toolkit, which is why it is stated here as a prerequisite rather than
validated at runtime.

## Behaviour worth knowing

**The preview is byte-identical to the send.** `email_compose_preview` returns the exact bytes that would be
transmitted — not a rendering of them. A preview that differed would be worse than none: it invites approving
one message and dispatching another, with the difference in the parts nobody reads carefully. This is why the
composed message carries **no `Date` and no `Message-ID`** — either would differ between the two calls by
construction — and why the multipart boundary is derived from a hash of the content rather than randomly. The
sending MTA or the provider adds both headers, which is where they belong: they describe the act of sending.

**A rejection is never reported as a send.** Every reply is checked, and the reply to `DATA`'s terminating dot
is the only thing that means accepted. A **4xx is transient** — greylisting is *designed* around a real sender
trying again — and a **5xx is permanent**, where retrying hammers a server that has already refused and damages
the sending domain's reputation. The error message begins "The message was NOT sent."

**Capability differences are reported, never simulated.** SMTP has no notion of a message after it is handed on
— the protocol passes it to the next hop and the conversation ends. So `email_get_status` under SMTP returns
`unknown` with an explanation, rather than a fabricated `"sent"` that would read as confirmed delivery. A
bounce arrives later as mail to the envelope sender; check that mailbox.

**`Bcc` appears in the preview and not on the wire.** The SMTP envelope already carries every recipient, so the
header adds nothing except the ability for each blind recipient to read the whole blind list.

**Connections are encrypted or refused.** If a server does not offer `STARTTLS`, the send is refused rather
than downgraded — an attacker on the path can force that downgrade by stripping the advertisement.

**MIME is handled properly.** A non-ASCII subject is RFC 2047 encoded; `multipart/alternative` puts plain text
before HTML, because a client showing the last part it understands would otherwise never show the HTML; a
header containing a line break is refused rather than allowed to inject a `Bcc`.

## Limits

**No lists and no campaigns.** Twenty recipients across to, cc and bcc combined, and the number is low on
purpose. A tool that will accept a hundred addresses in one call is a tool that will eventually send to a
hundred addresses by mistake — and a package that could do it properly would need consent records, unsubscribe
handling and a suppression list, none of which this has. If you need those, you need a marketing platform, and
this is not one.

**One attachment, 5MB.** Enough for a report or an invoice. Not a file-transfer mechanism.

**No inbound mail.** No reading a mailbox, no reply processing, no threading beyond passing a message id.
Inbound delivery is a different problem with a different shape.

**No templates.** Composing the body is the caller's job. A template engine here would be a second place where
mail content is decided, and the preview would be a rehearsal of the template rather than of the message.

**No scheduling and no retry queue.** A send happens now or fails now. A durable outbox belongs to the
application, which is the thing that knows whether a retry is still wanted.
