# @retinue/tools-email

Send a [Retinue](https://github.com/Rise-Experts/retinue) deployment's **own** mail — from its own domain, with
no user grant. One contract over SMTP and an HTTP API.

```bash
npm i @retinue/tools-email
```

## Usage

```ts
import { createEmailToolkit, smtpProvider } from "@retinue/tools-email";
import type { CredentialResolver } from "@retinue/agentkit/tools";

// Yours: resolves a `basic` credential — the SMTP username and password.
declare const resolver: CredentialResolver;

const toolkit = createEmailToolkit({
  provider: smtpProvider({ host: "smtp.example.com", port: 587, credentialRef: "smtp", resolver }),
  from: "alerts@yourdomain.example",
});
```

`httpProvider({ name: "resend", credentialRef, resolver })` swaps in an HTTP API. The result shape does not
change — a test asserts it.

## Why the preview matters

A sent message cannot be recalled, and unlike a post it cannot be deleted afterwards. So `email_send` is gated
and `email_compose_preview` returns the **exact bytes** that would be transmitted.

Byte-identical is the whole point. A preview that differed would invite approving one message and dispatching
another, with the difference in the parts nobody reads carefully — the encoded subject, the multipart order,
the bcc line. That is why the composed message carries no `Date` and no `Message-ID` (either would differ
between the two calls) and why the multipart boundary is hashed from the content rather than random. The
sending MTA adds both headers, which is where they belong.

## What it will not do

- **A rejection is never reported as a send.** Every SMTP reply is checked, and the reply to the terminating
  dot is the only thing that means accepted. A 4xx is retryable; a 5xx is not.
- **No fabricated delivery status.** SMTP cannot report what happened to a message after it is handed on, so
  `email_get_status` says so rather than returning `"sent"`.
- **No plaintext downgrade.** A server that does not offer `STARTTLS` gets a refusal, not a fallback.
- **No lists or campaigns.** Twenty recipients across to, cc and bcc combined.
- **`Bcc` never travels.** It shows in the preview and is stripped before SMTP transmission.

**Before your first send**: SPF, DKIM and DMARC on the sending domain, aligned to the `From` address. Most
first sends fail there, the symptom is a `250 Ok` and nothing arriving, and no code in this package can fix it.
The integration page has the detail.

MIT.
