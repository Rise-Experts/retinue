# Testing, Security and Release Criteria

## Test layers

- Schema and serialization tests.
- Adapter conformance suites.
- Runtime state-machine tests.
- Session-state concurrency, run-ordering and thread-compaction tests.
- Provider contract tests using recorded fixtures where allowed.
- Tool authorization and input-validation tests.
- Authorization policy decision, tool-filtering and scope tests.
- Outbound MCP classification, egress-policy and catalog-drift tests.
- Usage reconciliation, ceiling and quota-enforcement tests.
- Automatic schema-provisioning and concurrent-startup tests.
- RLS and cross-tenant isolation tests.
- Queue concurrency, crash and recovery tests.
- HITL resume and idempotency tests.
- GraphQL resolver and subscription tests.
- React reducer/reconnection tests.
- RAG retrieval/citation evaluations.
- ShareFlow workflow end-to-end tests.

## Evaluation dimensions

- Task completion.
- Correct workflow and tool selection.
- Authorization compliance.
- External-action safety.
- Structured-output validity.
- Groundedness and citation correctness.
- Brand/domain quality for application evaluations.
- Latency, cost and time to first token.
- Recovery after provider, tool, worker and network failures.

## Security requirements

- Explicit tenant scope on every store/tool/context call.
- Authorization before discovery and before execution.
- Secret redaction from prompts, logs and tool results.
- File type/size inspection and optional malware adapter.
- Retrieved/file content treated as untrusted.
- Remote MCP descriptions, hints, resources and prompts treated as untrusted; unclassified MCP tools require approval.
- Outbound MCP endpoints validated against an egress policy; credentials referenced, never inlined.
- Signed, expiring file references.
- Audit records for configuration, approvals and external writes.
- Data-retention and deletion propagation through RAG indexes.
- No arbitrary skill script execution by default.

## Operational requirements

- OpenTelemetry-compatible traces.
- Metrics for tokens, cache, cost, steps, tools and latency.
- Health checks for providers and adapters.
- Dead-letter handling and replay tooling.
- Migrations are versioned and reversible when feasible.
- Model/tool/skill/agent versions recorded per run.

## Package quality

- ESM-first builds with explicit exports.
- Strict TypeScript and runtime schema validation.
- Semantic versioning and changesets.
- API extraction checks for accidental breaking changes.
- Dependency and license inventory generated for releases.
- Examples compile against published package artifacts.

## ShareFlow rollout gates

Before replacing an Agno workflow:

- New workflow passes the same representative cases.
- No security or authorization regression.
- External writes are idempotent.
- Quality is equal or better by human scoring.
- Latency and cost are within the agreed envelope.
- Feature-flag rollback is verified.

## Version 1.0 definition of done

- No generic package imports Twenty or ShareFlow.
- At least two applications validate reuse.
- Memory, PostgreSQL and Supabase adapters pass the conformance suite.
- Runs survive refresh and worker restart.
- Threads carry session state across runs, and runs in one thread never execute concurrently.
- Pending interactions survive deployment.
- Unauthorized tools cannot be learned or executed, native or MCP-imported.
- Token and cost usage reconcile to provider actuals and enforce ceilings and quotas.
- A supported adapter provisions its schema on startup from an empty database.
- RAG citations resolve to exact authorized source locations.
- File and deletion isolation is proven.
- Provider switching requires no application rewrite.
- Evaluation regressions block releases.
- Public APIs, adapter guides, migrations and integration examples are documented.

