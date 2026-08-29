# @retinue/tools-google

Gmail and Calendar tools for a [Retinue](https://github.com/Rise-Experts/retinue) agent.

```bash
npm i @retinue/tools-google
```

## Before anything else: this needs a refreshing resolver

A Google access token lives for **one hour**. Wrap your resolver in `withRefreshingCredentials` or the toolkit
works until lunch and then fails in a way that looks intermittent.

```ts
import { withRefreshingCredentials } from "@retinue/agentkit/tools";
import type { CredentialRefresher, CredentialResolver } from "@retinue/agentkit/tools";
import { createGoogleToolkit } from "@retinue/tools-google";

declare const yourResolver: CredentialResolver;
declare const yourRefresher: CredentialRefresher;

const google = createGoogleToolkit({
  credentialRef: "google",
  resolver: withRefreshingCredentials(yourResolver, yourRefresher),
  // The tool most worth excluding, and the one a typo would silently ship.
  exclude: ["gmail_send_message"],
});
```

## Tools

**Gmail** — `gmail_search_messages`, `gmail_get_message`, `gmail_get_thread`, `gmail_list_labels` (reads);
`gmail_send_message`, `gmail_reply_message`, `gmail_modify_labels` (gated); `gmail_create_draft`
(**not** gated — see below).

**Calendar** — `calendar_list_events`, `calendar_get_event`, `calendar_find_free_time` (reads);
`calendar_create_event`, `calendar_update_event` (gated); `calendar_delete_event` (`destroys`).

There is no delete or trash tool for mail. Deleting somebody's email is not a capability this package grants.

## Three things worth knowing

**The draft is deliberately ungated.** Every other write stops for a person; `gmail_create_draft` does not. If
drafting and sending both cost an approval, a model has no reason to prefer drafting — the cheap path and the
irreversible path would be equally expensive. Making the reversible act free is what makes it the default.

**A missing scope is refused before the call.** Each tool declares its scopes, and the toolkit compares them
with what the connection was granted. Google's own answer is a `403` naming the API rather than the scope, so a
model retries with different arguments forever. When the grant is unstated — a static token with no metadata —
it proceeds rather than breaking a working configuration.

**Calendar writes email people.** Creating an event sends invitations; updating one notifies everyone already
on it; deleting one sends cancellations. Every such description says so, so a model can tell that one option is
a message to eight people and the other is not.

## Requirements

- Node 20+, `@retinue/agentkit` as a peer dependency
- A Google Cloud OAuth app. **Gmail's scopes are *restricted***, which means the app must pass Google's
  verification — a security assessment taking weeks — before anyone outside your test users can consent.
  Calendar's are merely *sensitive*: verification, no assessment. `GOOGLE_SCOPES` exports which is which.

Full documentation: [docs.retinue.riseexperts.de](https://docs.retinue.riseexperts.de/integrations/google).

MIT
