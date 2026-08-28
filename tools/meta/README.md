# @retinue/tools-meta

WhatsApp Business and Instagram tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent, over
Meta's Graph API.

```bash
npm i @retinue/tools-meta
```

Requires `@retinue/agentkit` as a peer.

## Before the code: Meta's app review

This is the real barrier, not the wiring. There is no WhatsApp or Instagram API key — every token comes from a
Meta app that has passed review, and you need `whatsapp_business_messaging`, `instagram_basic`,
`instagram_content_publish` and `instagram_manage_comments` approved for your app. Budget weeks, not hours.

## Use it

```ts
import { createStaticCredentialResolver } from "@retinue/agentkit/tools";
import { createMetaToolkit } from "@retinue/tools-meta";

const toolkit = createMetaToolkit({
  credentialRef: "meta",
  resolver: createStaticCredentialResolver({ meta: process.env.META_ACCESS_TOKEN ?? "" }),
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
  instagramAccountId: process.env.INSTAGRAM_ACCOUNT_ID,
});
```

A surface with no id contributes **no tools**, rather than tools that always answer "not configured".

## Two rules this package enforces for you

**WhatsApp's 24-hour service window is a law, not a preference.** Free text may be sent only within 24 hours of
that user messaging the business; outside it, only an approved template. `whatsapp_send_message` therefore
requires `lastInboundAt` as evidence and **refuses locally, making no request**, naming
`whatsapp_send_template` as what would work. Meta's own error is a numeric code with no explanation, so a model
that hit it would retry with different words — which cannot ever work.

**Publishing to Instagram is two calls, and the second is the dangerous one.** A container is created, then
published. If the publish fails, the container still exists — so the failure is reported as **not retryable**,
naming the step and the container id. Retrying would create a second container and can publish the post twice.

Template parameter counts are validated against the template's real definition before sending, because Meta's
own error names neither the count nor the template.

Full documentation, including the permission list and what is deliberately not built:
<https://docs.retinue.riseexperts.de/integrations/meta>

MIT.
