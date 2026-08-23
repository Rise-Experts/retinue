/**
 * The security review as a **repeatable checklist** — REQ-033 (#145), AC-6.
 *
 * Data, not prose, for the reason every list in this codebase is data: a checklist in a document is one that
 * drifts from the code silently, and the drift is found by whoever needed the check it lost.
 *
 * Each entry names the property, the acceptance criterion it serves, and **how it is verified** — a test id, a
 * build gate, or "by reading, at each release". That last kind is the honest one: some properties cannot be
 * asserted by a machine, and pretending otherwise produces a green tick where a person should have looked.
 *
 * `verifiedBy: "manual"` entries are what make this a *checklist* rather than a test suite. They are the reason
 * #145 asks for it to be re-run at each release instead of treated as done.
 */

export const SECURITY_AREAS = ["credentials", "egress", "isolation", "prompt-injection"] as const;
export type SecurityArea = (typeof SECURITY_AREAS)[number];

export type VerificationKind =
  /** An automated test asserts it. The id is greppable. */
  | "test"
  /** A build gate fails on violation — a boundary rule, a conformance cell, a coverage check. */
  | "build-gate"
  /** A type makes the violation impossible to express. The strongest kind, and the rarest. */
  | "type"
  /** A person reads it at each release. Named, so the absence of automation is visible. */
  | "manual";

export type SecurityCheck = {
  readonly id: string;
  readonly area: SecurityArea;
  /** The property, phrased so the answer is yes or no. A check whose answer is "mostly" is two checks. */
  readonly property: string;
  readonly criterion: string;
  readonly verifiedBy: VerificationKind;
  /** Where to look: a test name, a rule id, a file. Greppable on purpose. */
  readonly evidence: string;
};

export const SECURITY_CHECKS: readonly SecurityCheck[] = [
  // ---------------------------------------------------------------------------------- credentials (AC-1)
  {
    id: "cred-no-secret-field",
    area: "credentials",
    property: "No persisted type has a field capable of holding a secret value.",
    criterion: "AC-1",
    verifiedBy: "type",
    evidence: "McpAuth is a union whose only auth field is `credentialRef: string`; mcp_connections has no value column",
  },
  {
    id: "cred-no-secret-in-url",
    area: "credentials",
    property: "An endpoint URL carrying userinfo is refused, so a secret cannot be inlined in a URL.",
    criterion: "AC-1",
    verifiedBy: "test",
    evidence: "security-audit.test.ts → 'refuses an endpoint URL carrying credentials'",
  },
  {
    id: "cred-not-in-logs",
    area: "credentials",
    property: "No credential field can appear in a log line, because the field allowlist has no name that could carry one.",
    criterion: "AC-1",
    verifiedBy: "test",
    evidence: "telemetry.test.ts → redaction suite; LOG_FIELD_ALLOWLIST guard",
  },
  {
    id: "cred-not-in-envelope",
    area: "credentials",
    property: "No tool result or error envelope carries a credential, and an error records a code rather than a message.",
    criterion: "AC-1",
    verifiedBy: "test",
    evidence: "security-audit.test.ts → 'no envelope type has a secret-shaped field'",
  },
  {
    id: "cred-frontend-cannot-bypass",
    area: "credentials",
    property: "The frontend holds no credential capable of bypassing tenant isolation.",
    criterion: "AC-1",
    verifiedBy: "build-gate",
    evidence: "boundary rule R2 — the frontend may only `import type` from the backend, so it holds no store, no key and no connection",
  },
  {
    id: "cred-host-supplied-strings",
    area: "credentials",
    property: "Fields the platform stores but does not author carry a documented constraint.",
    criterion: "AC-1",
    verifiedBy: "manual",
    evidence: "mcp_connections.last_error is host-populated; docs/17 states it must be a classified message, never a raw driver error",
  },

  // ---------------------------------------------------------------------------------- egress (AC-2)
  {
    id: "egress-single-point",
    area: "egress",
    property: "Every outbound destination the platform chooses is validated at exactly one function.",
    criterion: "AC-2",
    verifiedBy: "test",
    evidence: "security-audit.test.ts → 'every outbound path is validated at one point'",
  },
  {
    id: "egress-deny-by-default",
    area: "egress",
    property: "An endpoint that matches no rule is refused; the default is deny, not allow.",
    criterion: "AC-2",
    verifiedBy: "test",
    evidence: "mcp egress suite; security-audit.test.ts → private/loopback/metadata cases",
  },
  {
    id: "egress-no-research-path",
    area: "egress",
    property: "There is no second outbound path that bypasses the policy.",
    criterion: "AC-2",
    verifiedBy: "test",
    evidence: "security-audit.test.ts → 'no module outside the MCP transport and the storage adapter calls fetch'",
  },

  // ---------------------------------------------------------------------------------- isolation (AC-3)
  {
    id: "rls-coverage",
    area: "isolation",
    property: "Every table any migration creates has a tenant policy or a written exemption.",
    criterion: "AC-3",
    verifiedBy: "build-gate",
    evidence: "supabase-rls.test.ts → coverage gate, derived from MIGRATIONS *and* VECTOR_MIGRATIONS",
  },
  {
    id: "rls-forced",
    area: "isolation",
    property: "Policies are FORCEd, so the owning role does not bypass them.",
    criterion: "AC-3",
    verifiedBy: "test",
    evidence: "rls.ts policyFor emits FORCE ROW LEVEL SECURITY; supabase-rls.test.ts asserts isolation under a non-superuser role",
  },
  {
    id: "rls-principal-scoping",
    area: "isolation",
    property: "principal_memory is scoped to the principal as well as the tenant.",
    criterion: "AC-3",
    verifiedBy: "test",
    evidence: "TENANT_SCOPED_TABLES entry carries PRINCIPAL_PREDICATE; supabase-rls.test.ts asserts a same-tenant other principal cannot read",
  },
  {
    id: "rls-gate-cannot-be-bypassed",
    area: "isolation",
    property: "A new table cannot ship uncovered, whichever migration list it is added to.",
    criterion: "AC-3",
    verifiedBy: "test",
    evidence: "security-audit.test.ts → 'the RLS gate sees a table added to either migration list'",
  },
  {
    id: "rls-not-behind-pooler",
    area: "isolation",
    property: "Session-scoped tenant binding is never used behind a transaction-mode pooler.",
    criterion: "AC-3",
    verifiedBy: "manual",
    evidence: "rls.ts documents the hazard on the binding function; a deployment must confirm its connection mode",
  },

  // ---------------------------------------------------------------------------------- injection (AC-4)
  {
    id: "inj-origin-required",
    area: "prompt-injection",
    property: "Every context section declares whether its content may instruct the agent.",
    criterion: "AC-4",
    verifiedBy: "type",
    evidence: "ContextSection.origin is required with no default, so a new provider must decide",
  },
  {
    id: "inj-enveloped",
    area: "prompt-injection",
    property: "External content reaches the prompt inside a delimited block preceded by a standing data-only instruction.",
    criterion: "AC-4",
    verifiedBy: "test",
    evidence: "security-audit.test.ts → 'external content is enclosed, not interpolated'",
  },
  {
    id: "inj-delimiter-forgery",
    area: "prompt-injection",
    property: "Content cannot close its own envelope, forge a heading, or emit a chat-template turn marker.",
    criterion: "AC-4",
    verifiedBy: "test",
    evidence: "security-audit.test.ts → planted payloads for each forgery class",
  },
  {
    id: "inj-untrusted-values-in-platform-sections",
    area: "prompt-injection",
    property: "A platform section that interpolates untrusted values neutralises them.",
    criterion: "AC-4",
    verifiedBy: "test",
    evidence: "security-audit.test.ts → 'a filename cannot forge a heading in the attachment section'",
  },
  {
    id: "inj-tool-results-are-parts",
    area: "prompt-injection",
    property: "An MCP or tool result enters history as a tool-result part, not as prompt instruction.",
    criterion: "AC-4",
    verifiedBy: "type",
    evidence: "MessagePart is a discriminated union; providerMetadata cannot change a part's type (validation.test.ts)",
  },
  {
    id: "inj-extraction-is-data",
    area: "prompt-injection",
    property: "Extracted document text is stored as content, and reaches a model only through a tool result or an external-origin section.",
    criterion: "AC-4",
    verifiedBy: "manual",
    evidence: "no in-package provider surfaces extracted text; a host that adds one must set origin: 'external'",
  },
];

/**
 * Source files permitted to declare a secret-shaped field, each with the reason.
 *
 * The audit scans the whole shipped tree for a field that could hold a secret *value*, because the guarantee
 * worth having is "a new `apiKey` cannot be added without this failing" rather than "today's types are clean".
 * A provider credential has to exist somewhere in memory to authenticate, so the honest answer is an exemption
 * with a written constraint — not a narrower scan that would also stop noticing the next real one.
 *
 * Same shape as `RLS_EXEMPT_TABLES`, for the same reason: a silent hole in a gate is indistinguishable from a
 * forgotten case.
 */
export const CREDENTIAL_FIELD_EXEMPTIONS: readonly { readonly file: string; readonly reason: string }[] = [
  {
    file: "models/provider-factory.ts",
    reason:
      "`ProviderCredentials.apiKey` is the model provider's own key, supplied by the host at wiring time and " +
      "handed straight to the AI SDK. Process-local: it is never written to a table, never placed in a message " +
      "part or a result envelope, and cannot be logged because no allowlisted log field could carry it. A " +
      "credential must exist in memory to authenticate; what AC-1 forbids is storing, passing, returning or " +
      "logging one, and none of those happen here.",
  },
];

/** Checks with no automated backing. The set a person must actually walk at each release. */
export const manualChecks = (): readonly SecurityCheck[] =>
  SECURITY_CHECKS.filter((check) => check.verifiedBy === "manual");
