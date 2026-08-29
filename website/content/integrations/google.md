---
sidebar_position: 8
---

# Google Workspace

Gmail and Calendar: search and read mail, draft, reply and send; read calendars, find a free slot, and manage
events.

```bash
npm i @retinue/tools-google
```

## Tools

### Gmail

| Tool | Effect | Approval | Scope |
|---|---|---|---|
| `gmail_search_messages` | `read` | never | `gmail.readonly` |
| `gmail_get_message` | `read` | never | `gmail.readonly` |
| `gmail_get_thread` | `read` | never | `gmail.readonly` |
| `gmail_list_labels` | `read` | never | `gmail.readonly` |
| `gmail_create_draft` | `internal-write` | **never** | `gmail.compose` |
| `gmail_send_message` | `external-write` | **always** | `gmail.send` |
| `gmail_reply_message` | `external-write` | **always** | `gmail.send`, `gmail.readonly` |
| `gmail_modify_labels` | `external-write` | **always** | `gmail.modify` |

There is deliberately **no delete or trash tool**. Deleting somebody's mail is not a capability this package
grants; `gmail_modify_labels` archives and marks read, which is the triage an agent is actually asked to do.

### Calendar

| Tool | Effect | Approval | Scope |
|---|---|---|---|
| `calendar_list_events` | `read` | never | `calendar.readonly` |
| `calendar_get_event` | `read` | never | `calendar.readonly` |
| `calendar_find_free_time` | `read` | never | `calendar.readonly` |
| `calendar_create_event` | `external-write` | **always** | `calendar.events` |
| `calendar_update_event` | `external-write` | **always** | `calendar.events` |
| `calendar_delete_event` | `destructive` | **always** | `calendar.events` |

## Wire it up

```ts
import { createAgent } from "@retinue/agentkit/providers";
import { bearer, refreshable, withRefreshingCredentials } from "@retinue/agentkit/tools";
import type { CredentialRefresher, CredentialResolver } from "@retinue/agentkit/tools";
import { createGoogleToolkit } from "@retinue/tools-google";

// Your own: reads the stored connection for this tenant.
declare const connectionResolver: CredentialResolver;

// Your own: exchanges the sealed refresh token for a new access token.
const googleRefresher: CredentialRefresher = {
  async refresh() {
    const { accessToken, expiresInSeconds } = await exchangeStoredRefreshToken();
    return refreshable(bearer(accessToken), new Date(Date.now() + expiresInSeconds * 1000).toISOString());
  },
};
declare function exchangeStoredRefreshToken(): Promise<{ accessToken: string; expiresInSeconds: number }>;

// A Google access token lives one hour. Without this the toolkit works until lunch.
const resolver = withRefreshingCredentials(connectionResolver, googleRefresher);

const agent = createAgent({
  manifest: {
    id: "assistant",
    name: "Assistant",
    instructions:
      "Help with mail and scheduling. Draft rather than send unless explicitly asked to send. " +
      "Find a free slot before proposing a meeting.",
    modelPolicy: { role: "smart" },
  },
  tools: [
    createGoogleToolkit({
      credentialRef: "google",
      resolver,
      include: ["gmail_search_messages", "gmail_get_thread", "gmail_create_draft", "calendar_find_free_time"],
    }),
  ],
});
```

## Credentials and scopes

**OAuth only.** Google has no personal-access-token equivalent for Gmail or Calendar — every path is a
consented grant, which is why this toolkit's `modes` has one entry where GitHub's has two.

### Restricted scopes, and what that costs you

This is the part to read before planning a rollout.

| Scope | Google's tier | What it means for you |
|---|---|---|
| `gmail.readonly` | **Restricted** | App verification **plus a security assessment** |
| `gmail.send` | **Restricted** | Same |
| `gmail.compose` | **Restricted** | Same |
| `gmail.modify` | **Restricted** | Same |
| `calendar.readonly` | Sensitive | Verification, no assessment |
| `calendar.events` | Sensitive | Verification, no assessment |

A **restricted** scope requires your Google Cloud app to pass verification *and* a security assessment — which
takes weeks and may require a third-party audit — before anyone outside your OAuth test-user list can consent.
Until then Gmail works for your listed testers and for nobody else.

**Sensitive** scopes need verification but no assessment. That is a materially smaller burden, and it is why a
deployment that enables only Calendar is in a very different position from one that enables Gmail.

`GOOGLE_SCOPES` exports this table, so a host can tell an operator which situation they are in rather than
letting them discover it from a consent screen.

Ask for the narrowest set that works. Each tool declares its own scopes, so enabling four Gmail tools should be
sent through consent for four tools' worth — asking for `gmail.modify` when only `gmail.readonly` is needed is
the difference between a consent a security team approves and one they refuse.

## Behaviour worth knowing

**A missing scope is refused before the call.** Google answers `403 PERMISSION_DENIED` with a message naming
the API rather than the scope, so a model reads it as a wrong identifier and retries with different arguments.
Each tool declares its scopes and the toolkit compares them against what the connection was granted, producing
an error that names the scope and says to reconnect — with nothing sent to Google.

When the grant is *unstated* — a static token carrying no scope metadata — it proceeds rather than refusing. A
check that cannot be performed must not break a working configuration, and Google's own 403 is mapped to
something readable as the fallback.

**The draft is the only ungated write, and that is deliberate.** If drafting and sending both cost an approval,
a model has no incentive to draft: the cheap path and the irreversible path are equally expensive, so it takes
the one that finishes the task. Making the reversible act free is what makes it the default. The draft lands in
a person's Gmail where they read it and press send — the outcome the approval gate was trying to produce.

**A reply stays in its thread, and the original is fetched to make that true.** A reply needs the original's
`Message-ID` for `In-Reply-To` and its `References` for the chain. Both live only on the real message, so the
toolkit fetches it. Building them from an id the caller passed produces a reply that sends perfectly and
arrives as a *new conversation* — which looks like success from every angle except the recipient's. When the
original has no `Message-ID`, the send is **refused** rather than silently starting a thread.

**Non-ASCII subjects are RFC 2047 encoded.** Raw UTF-8 in a header does not throw; it arrives as mojibake and
nobody tells you.

**A line break in a subject or address is refused.** A header ends at CRLF, so `Update\r\nBcc: someone@else`
is two headers and the second copies the mail. An agent composing a subject from an email it just read is
exactly that path — retrieved content is untrusted, per `docs/17`.

**A calendar it cannot read is not an empty one.** `calendar_find_free_time` reports unreadable calendars
separately and warns, because treating "cannot see" as "free" is how an agent books over somebody's day.
Overlapping busy blocks are merged before being inverted, or two people's overlapping meetings produce a "free"
slot that is free for neither.

**Attendees are always notified**, explicitly rather than by Google's default — which differs by endpoint.

## Limits

| Not offered | Why |
|---|---|
| Deleting or trashing mail | Not a capability this sprint grants. A message can always be found again; a deleted one cannot |
| Attachments, sending or reading | Multipart to a second host, the same deferral as Slack's `upload_file` |
| Filters, forwarding rules, vacation responders | Standing configuration that outlives the run that made it — the highest-consequence thing in a mailbox |
| Contacts, Directory, Admin SDK | A different API and a different consent, mostly organisation-wide |
| Calendar sharing and ACLs | Access-granting is the one act a wrong call cannot walk back |
| Recurring-event rule editing | Changing a rule silently changes every future instance; editing one instance is what people mean |
| Drive, Docs and Sheets | The other half of Workspace — [#235](https://github.com/Rise-Experts/retinue/issues/235) |
| Service accounts with domain-wide delegation | Impersonating any user in a domain. A real deployment shape, and one that deserves its own design rather than an inherited one |
