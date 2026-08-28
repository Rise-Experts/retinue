---
title: OAuth connections
---

# Connecting a tenant to a provider

`@retinue/agentkit/connections` carries an OAuth 2.0 authorization-code flow with PKCE, a store for the
resulting credentials, and the cipher that protects them. A deployment mounts it rather than implementing it —
which matters beyond convenience: this is the piece where a mistake is *exploitable* rather than merely broken.

## Tools

None. This is a connection surface, not a toolkit — what it produces is the credential every other toolkit
resolves through `credentialRef`.

| Operation | Effect | Approval | Note |
|---|---|---|---|
| `start` | `read` | n/a | Returns a URL and records a server-side attempt. Nothing is stored for a redirect that fails the allowlist. |
| `callback` | `external-write` | n/a | Verifies the state, exchanges the code. Every check that can be made without the provider is made first. |
| `complete` | `internal-write` | n/a | Seals the token and stores the connection. |
| `disconnect` | `destructive` | n/a | Revokes at the provider **first**, then locally. |
| `list` | `read` | n/a | Never decrypts anything. |

## Wire it up

```ts
import {
  createAesGcmCipher,
  createMemoryOAuthAttemptStore,
  createOAuthConnectionService,
  createOAuthFlow,
} from "@retinue/agentkit/connections";

export const github = (store: never) => {
  const config = {
    provider: "github",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientId: process.env.GITHUB_CLIENT_ID ?? "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    scopes: ["repo", "read:org"],
    redirectUris: ["https://app.example.com/oauth/github/callback"],
  };
  const cipher = createAesGcmCipher({
    keys: [{ id: "k1", key: Buffer.from(process.env.RETINUE_SECRET_KEY ?? "", "base64") }],
  });
  return {
    flow: createOAuthFlow({ config, attempts: createMemoryOAuthAttemptStore() }),
    service: createOAuthConnectionService({ store, cipher, config }),
  };
};
```

Mount `start` and `callback` on your own router, with your own authentication. There is deliberately no router
here: a convenience wrapper would have to guess at the authentication, and guessing about authentication is how
a surface ends up open.

## Credentials and scopes

The **deployment's** OAuth app is registered with each provider, and its client secret comes from the
environment. It is never put in an authorization URL — a secret in a URL is in the browser history, the referrer
header and every proxy log on the way; it goes in the token request body, over the back channel.

Record what the provider **granted**, not what you asked for. A provider may grant fewer scopes, and
`scopeGap()` is what turns that into *"reconnect and grant `admin:org`"* rather than a vendor 403 that names
nothing actionable. A connection whose provider disclosed no scopes returns no gap — an absence is not a
refusal, and treating it as one would block working connections.

The key that seals stored credentials must be one **the application database cannot decrypt on its own**. See
[the cipher's own notes](https://github.com/Rise-Experts/retinue/blob/main/backend/src/connections/cipher.ts) for
why `pgcrypto` keyed from a column does not satisfy that, and why Supabase Vault is one implementation of the
seam rather than its foundation.

## Behaviour worth knowing

**`state` is single-use and bound to the person.** Not just the tenant — a code must not be redeemable by a
colleague. It is verified before the code is touched, so probing the callback never causes an outbound request
and never spends a real code.

**Every state failure gives the same message.** Unknown, replayed, expired, wrong tenant — one response. A
callback that distinguishes them is an oracle: it tells an attacker whether a state existed, which is enough to
confirm a guess. Log the distinction server-side.

**Redirect URIs are matched exactly.** Not by prefix, which `https://app.example.com.evil.tld` defeats, and not
by `URL` comparison, which normalises and would silently widen the allowlist over a trailing slash or a default
port.

**PKCE is on even when you have a client secret.** "We have a secret so we do not need PKCE" is an argument
about one threat; PKCE defends another. The verifier never leaves the server — sending it to the browser defeats
the whole mechanism.

**Disconnect revokes at the provider before removing locally.** The other order leaves a live token nobody can
see and nobody can stop, which is strictly worse than either failure alone. A provider with no revocation
endpoint is *reported*, not silently skipped.

**Revocation takes effect on runs already in flight**, because a credential is resolved per call. A run that
resolved one holds it for that call only; the next goes back to the store and fails.

## Limits

**No router, and no session cookie.** Mounting and authentication are the host's. What is offered here is the
part that is the same everywhere and dangerous to get wrong.

**No refresh.** A credential that expires is *reported* as expired rather than silently renewed — refresh is
tracked separately ([#233](https://github.com/Rise-Experts/retinue/issues/233)), and reporting is the honest
interim: "expired" is a message an operator can act on, where a vendor 401 says the token is invalid and sends
them to rotate something that was never wrong.

**No device flow, no client-credentials grant, no implicit flow.** Authorization-code with PKCE is what a
tenant-facing connection needs; the implicit flow is deprecated and will not be added.

**Not yet run against a live provider.** The flow is unit-tested down to the exact bytes of the token request,
and no OAuth application has been registered with a real provider from this repository — so
[#262](https://github.com/Rise-Experts/retinue/issues/262) AC-10 is outstanding rather than met.
