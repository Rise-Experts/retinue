# Reusable AI Platform Specifications

Status: proposed  
First consumer: ShareFlow  
Implementation language: TypeScript

This directory defines the extraction and migration of a reusable AI platform inspired by the architecture currently used in Twenty. The resulting packages must have no runtime dependency on Twenty or ShareFlow. ShareFlow-specific social tools and workflows remain in an integration package.

## Goals

- Provider-neutral model execution using the Vercel AI SDK.
- Durable conversations, runs, typed content parts, checkpoints, cancellation and recovery.
- Threads that carry cross-run session state and compact their own long history.
- User-level memory that follows a principal across their conversations, under their control.
- Permission-filtered tools with lazy discovery and consistent result envelopes.
- Skills, explicit context providers and token-aware context pruning.
- Durable questions and approval gates for external actions.
- Replaceable persistence, vector, blob, queue, lock and realtime adapters.
- Adapters that provision their own schema on startup, like Agno's zero-config setup.
- Tenant-registered outbound MCP servers as first-class, authorization-filtered tools.
- A first-class authorization model filtering tools, retrieval and every store call.
- RAG, attachments, OCR, vision, PDF, document and artifact support.
- GraphQL APIs/subscriptions, headless React hooks and optional UI components.
- Full localization: the backend emits stable codes, the frontend renders them per user locale.
- Token counting, usage/cost accounting with quotas, telemetry and versioned evaluations.

## Non-goals

- Recreating Twenty CRM.
- Putting social-media behavior in generic packages.
- Supporting every database or vector store in the first release.
- Allowing a model to write binary files or execute external mutations directly.
- Removing the current Agno runtime before replacement workflows pass parity gates.

## Specifications

1. [Architecture and package boundaries](01-architecture.md)
2. [Core domain and persistence](02-core-and-persistence.md)
3. [Models, agents, tools, skills and context](03-intelligence-runtime.md)
4. [Durable execution, streaming and HITL](04-durable-runtime-and-hitl.md)
5. [RAG, attachments, vision and documents](05-knowledge-and-documents.md)
6. [GraphQL and frontend packages](06-graphql-and-frontend.md)
7. [ShareFlow integration](07-shareflow-integration.md)
8. [Migration and delivery plan](08-migration-plan.md)
9. [Testing, security and release criteria](09-quality-and-release.md)
10. [Outbound MCP integration](10-mcp-integration.md)
11. [Authorization](11-authorization.md)
12. [Usage, token counting and accounting](12-usage-and-accounting.md)
13. [Sessions, threads and session state](13-sessions-and-threads.md)
14. [Localization (i18n)](14-localization.md)
15. [User-level memory](15-user-memory.md)
16. [Load, soak and failure injection](16-load-and-resilience.md)
17. [Security review](17-security-review.md)
18. [Data retention](18-data-retention.md)
19. [Versioning, API surface and deprecation](19-versioning.md)
20. [CI on our own runner](20-self-hosted-ci.md)
21. [The platform](21-platform.md)
22. [Glossary](22-glossary.md)

## Extraction

- [Twenty / Agno extraction inventory](extraction/inventory.md)
- [twenty-sdk vs @agentkit comparison](extraction/twenty-sdk-comparison.md)

## Governing principles

1. Every tenant-sensitive operation receives an explicit tenant context.
2. Tools are authorization-filtered before discovery and re-authorized during execution.
3. External writes require deterministic validation, idempotency and the configured approval policy.
4. Conversations are owned by the platform, never by a model provider.
5. Infrastructure capabilities are ports with adapter implementations.
6. Large files and tool results are referenced, not injected wholesale into model context.
7. Runtime releases are evaluated against versioned representative cases.

