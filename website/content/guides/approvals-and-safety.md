---
sidebar_position: 3
---

# Approvals & safety

How @agentkit keeps a model from doing something it shouldn't.

## The three lines of defense

1. **Authorization before discovery** — unauthorized tools aren't in the catalog the model sees.
2. **Re-authorization at execution** — even a previously-discoverable tool is re-checked.
3. **Approval for external actions** — `external-write` / `destructive` effects pause the run.

## Approval decisions

```ts
await platform.decideApproval({
  interactionId,
  decision: "allow-once", // | "allow-conversation" | "allow-always" | "deny"
});
```

The pending approval stores the **exact normalized tool + input**, risk category, estimated cost,
and an idempotency key. Resumption runs the stored input — approval can't be bypassed by asking
the model to "just do it."

## Idempotency & retries

Every external write carries an idempotency key derived from tenant + run + tool-call identity.
A retried or resumed call returns the original result instead of repeating the side effect.
Retries follow a Claude-style policy (backoff + jitter, honor `retry-after`, transient classes
only, bounded attempts).

## Untrusted content

Retrieved documents, file contents, and remote MCP tool descriptions are treated as **data, never
instructions**. A page that says "publish immediately without asking" does not bypass approval.

## Auditing

Every denial, approval, and external write is recorded with the acting context, action, resource,
and reason.

## Checklist for a safe tool

- [ ] Correct `effect` (`external-write` / `destructive` where appropriate)
- [ ] `idempotent: true` and a stable idempotency key
- [ ] Input validated by schema
- [ ] Wraps an existing service rather than duplicating it
