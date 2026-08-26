## Unreleased

### Added

- **flows**: an agent step is a child run, which finishes teams (#202, #186) ([#202](https://github.com/Rise-Experts/retinue/issues/202)) `4e2b1601`
- **flows**: durable workflows, and teams as a kind of step (#187, #186) ([#187](https://github.com/Rise-Experts/retinue/issues/187)) `dd64602c`
- **parity**: a capability inventory, so a missing feature cannot read as parity ([#194](https://github.com/Rise-Experts/retinue/issues/194)) `47358636`
- **multimodal**: an attachment reaches the model, through the file path ([#185](https://github.com/Rise-Experts/retinue/issues/185)) `3bcaafec`
- **services**: a Nest.js service serves the platform, from the platform's schema ([#201](https://github.com/Rise-Experts/retinue/issues/201)) `4f7b1b03`
- **tools**: fifteen first-party tools, and four ways they were unreachable ([#188](https://github.com/Rise-Experts/retinue/issues/188)) `75eba978`
- **capabilities**: the composition root, and a capability that is off is enforced ([#196](https://github.com/Rise-Experts/retinue/issues/196)) `7240b1ad`
- **capabilities**: declare what a runtime does, and be held to it (#198, second half) ([#198](https://github.com/Rise-Experts/retinue/issues/198)) `e7b896e2`
- **runtime**: a run can belong to no conversation (#198, first half) ([#198](https://github.com/Rise-Experts/retinue/issues/198)) `e9f4afe0`
- **brand**: marks for the organisation and two candidate product names ([#184](https://github.com/Rise-Experts/retinue/issues/184)) `481962c6`
- **models**: a turn carries what the user actually sent ([#185](https://github.com/Rise-Experts/retinue/issues/185)) `dc70f08f`
- **shareflow**: make the parity gate and the Agno-reference check runnable ([#128](https://github.com/Rise-Experts/retinue/issues/128)) `ec14efb4`
- **usage**: per-model limits, every applicable limit enforced, and all of them visible (#182, #183) ([#182](https://github.com/Rise-Experts/retinue/issues/182)) `7f846f60`
- **usage**: a rolling quota window an admin can set, and the labels move to hover ([#181](https://github.com/Rise-Experts/retinue/issues/181)) `3056bcbc`
- **example**: a Tiptap composer with a / command menu, and a circular context meter ([#179](https://github.com/Rise-Experts/retinue/issues/179)) `0749abd0`
- **example**: a no-dependency single-process mode, worker-kill recovery, and two bugs (#155 AC-7, #176, #177) ([#155](https://github.com/Rise-Experts/retinue/issues/155)) `57ae0ac2`
- **example**: fetch_url, with the egress policy applied where the model chooses the argument ([#176](https://github.com/Rise-Experts/retinue/issues/176)) `5f6cec54`
- **usage**: per-person metrics and admin-configurable limits, end to end ([#175](https://github.com/Rise-Experts/retinue/issues/175)) `5efd9c07`
- **mcp**: bridge a real MCP server into the tool pipeline ([#173](https://github.com/Rise-Experts/retinue/issues/173)) `11c135d8`
- **skills**: wire the skills subsystem, and stop reaping a run that can never start (#171, #172) ([#171](https://github.com/Rise-Experts/retinue/issues/171)) `84e1931e`
- **context**: utilization, thread compaction, and the paging bug a load probe found (#167, #168, #169) ([#167](https://github.com/Rise-Experts/retinue/issues/167)) `40133036`
- **hitl**: batch questions into one interaction, with a tabbed panel above the composer (#155, #163) ([#155](https://github.com/Rise-Experts/retinue/issues/155)) `92a0c1be`
- **example**: a runnable example app, and the six platform gaps running it exposed ([#155](https://github.com/Rise-Experts/retinue/issues/155)) `ef585f91`
- **retention**: prune run_events past its retention period ([#151](https://github.com/Rise-Experts/retinue/issues/151)) `c49acde4`
- **security**: credential, egress, RLS and injection audit with a release checklist ([#145](https://github.com/Rise-Experts/retinue/issues/145)) `78e72523`
- **loadtest**: load, soak and failure injection with real infrastructure ([#144](https://github.com/Rise-Experts/retinue/issues/144)) `347b1380`
- **telemetry**: traces, metrics and structured logs across the run lifecycle ([#143](https://github.com/Rise-Experts/retinue/issues/143)) `8451ede8`
- **evals**: the release gate — thresholds, named regressions and a committed trend ([#142](https://github.com/Rise-Experts/retinue/issues/142)) `02461f05`
- **evaluation**: graders, the scoring harness and the regression report ([#141](https://github.com/Rise-Experts/retinue/issues/141)) `673a9ad0`
- **frontend**: the usage and cost panel ([#140](https://github.com/Rise-Experts/retinue/issues/140)) `5ffa20a1`
- **usage**: rollups, quota enforcement at admission, and reconciliation ([#139](https://github.com/Rise-Experts/retinue/issues/139)) `e86e540f`
- **frontend**: citation markers, source panels and a grounded treatment ([#138](https://github.com/Rise-Experts/retinue/issues/138)) `7a56b1d8`
- **citations**: per-claim provenance as a durable snapshot ([#137](https://github.com/Rise-Experts/retinue/issues/137)) `59772c80`
- **knowledge**: KeywordIndex and hybrid rank-fusion retrieval ([#136](https://github.com/Rise-Experts/retinue/issues/136)) `02fda555`
- **knowledge**: pgvector, chunking and the embedding pipeline ([#135](https://github.com/Rise-Experts/retinue/issues/135)) `76bbb4d5`
- **export**: deterministic PDF and Markdown rendering ([#134](https://github.com/Rise-Experts/retinue/issues/134)) `6ffd1c05`
- **artifacts**: ArtifactStore and the artifact lifecycle ([#133](https://github.com/Rise-Experts/retinue/issues/133)) `0be918e0`
- **documents**: OCR and vision for images and scans ([#132](https://github.com/Rise-Experts/retinue/issues/132)) `f46ec0b8`
- **documents**: PDF and text extraction, bounded and asynchronous ([#131](https://github.com/Rise-Experts/retinue/issues/131)) `e13df5a2`
- **files**: attachments are referenced, never injected ([#130](https://github.com/Rise-Experts/retinue/issues/130)) `ec3444b8`
- **files**: attachment lifecycle, file metadata store and object storage ([#129](https://github.com/Rise-Experts/retinue/issues/129)) `152e1d59`
- **parity**: gates, evaluator, cutover runbook and the gate that blocks removal ([#128](https://github.com/Rise-Experts/retinue/issues/128)) `59f54fc2`
- **hitl**: wire the approval loop end to end, and make allow-once mean once ([#126](https://github.com/Rise-Experts/retinue/issues/126)) `050e9816`
- **rollout**: per-workspace runtime flags, pinned per run, with a rehearsed rollback ([#127](https://github.com/Rise-Experts/retinue/issues/127)) `df0441cb`
- **shadow**: suppress external writes in the envelope, and diff two runs ([#126](https://github.com/Rise-Experts/retinue/issues/126)) `9ab6c518`
- **shareflow**: analytics — measured facts, and nothing that interprets them ([#125](https://github.com/Rise-Experts/retinue/issues/125)) `aa3b4ad7`
- **shareflow**: research tools with per-passage provenance ([#124](https://github.com/Rise-Experts/retinue/issues/124)) `cc1400b9`
- **shareflow**: generate_content with per-channel variants and bounded repair ([#123](https://github.com/Rise-Experts/retinue/issues/123)) `b33c8473`
- **shareflow**: migrate the seven skill bodies, reconciled against what is implemented ([#122](https://github.com/Rise-Experts/retinue/issues/122)) `f829c4de`
- **shareflow**: context providers, and a checkable claim policy ([#121](https://github.com/Rise-Experts/retinue/issues/121)) `39961b40`
- **shareflow**: Engagement and Leads ([#120](https://github.com/Rise-Experts/retinue/issues/120)) `32032f1f`
- **shareflow**: Publishing behind the approval gate with per-destination idempotency ([#119](https://github.com/Rise-Experts/retinue/issues/119)) `30eb2607`
- **shareflow**: Media — list, inspect, check, attach, convert ([#118](https://github.com/Rise-Experts/retinue/issues/118)) `294bc0fc`
- **shareflow**: Accounts — destinations, health and remediation ([#117](https://github.com/Rise-Experts/retinue/issues/117)) `556865cd`
- **shareflow**: Campaigns capabilities and content calendar ([#116](https://github.com/Rise-Experts/retinue/issues/116)) `e6e6b33c`
- **shareflow**: Posts capabilities over the existing post services ([#115](https://github.com/Rise-Experts/retinue/issues/115)) `50635e85`
- **shareflow**: integration workspace, service seam and boundary rules R8-R10 ([#114](https://github.com/Rise-Experts/retinue/issues/114)) `501cac42`
- **tools**: logic-function envelope — authz, approval, idempotency, delegation ([#113](https://github.com/Rise-Experts/retinue/issues/113)) `a85fd477`
- **deploy**: configuration, startup provisioning and health probes ([#110](https://github.com/Rise-Experts/retinue/issues/110)) `d38b438c`
- **server**: HTTP SSE endpoint with Last-Event-ID resume ([#109](https://github.com/Rise-Experts/retinue/issues/109)) `902f14e4`
- **server**: reference GraphQL host as a separate workspace ([#108](https://github.com/Rise-Experts/retinue/issues/108)) `da1da9b8`
- **worker**: process entrypoint with heartbeat, graceful shutdown, reaping ([#107](https://github.com/Rise-Experts/retinue/issues/107)) `e62a04e1`
- **redis**: DistributedLockStore over Redis ([#106](https://github.com/Rise-Experts/retinue/issues/106)) `3c4774b2`
- **bullmq**: durable JobDispatcher over BullMQ/Redis ([#105](https://github.com/Rise-Experts/retinue/issues/105)) `29b73757`
- **supabase**: store parity for all 19 ports + Realtime live source ([#104](https://github.com/Rise-Experts/retinue/issues/104)) `79277742`
- **rls**: row-level security policies for all 19 tables ([#103](https://github.com/Rise-Experts/retinue/issues/103)) `9420bded`
- **postgres**: PrincipalMemoryStore and BlobStore ([#102](https://github.com/Rise-Experts/retinue/issues/102)) `5e52d06e`
- **postgres**: SkillStore and McpConnectionStore ([#101](https://github.com/Rise-Experts/retinue/issues/101)) `71f5e267`
- **postgres**: UsageStore and IdempotencyStore ([#100](https://github.com/Rise-Experts/retinue/issues/100)) `3ace5c37`
- **postgres**: InteractionStore and ApprovalGrantStore ([#99](https://github.com/Rise-Experts/retinue/issues/99)) `2da31a62`
- **postgres**: ConversationRunCoordinator and UnitOfWork transactions ([#98](https://github.com/Rise-Experts/retinue/issues/98)) `542d7281`
- **postgres**: durable SessionStateStore and ThreadSummaryStore ([#97](https://github.com/Rise-Experts/retinue/issues/97)) `9c66aa29`
- **postgres**: durable MessageStore, AgentStore and ConversationBindingStore ([#96](https://github.com/Rise-Experts/retinue/issues/96)) `98a589fd`
- **postgres**: durable CheckpointStore + checkpoints table ([#95](https://github.com/Rise-Experts/retinue/issues/95)) `161557de`
- **postgres**: durable RunStore + runs table ([#93](https://github.com/Rise-Experts/retinue/issues/93)) `f4e5f840`
- **agents**: default AI-SDK engine + createAgent embedded facade `0a361c2e`
- **frontend**: optional UI component library ([#40](https://github.com/Rise-Experts/retinue/issues/40)) `d87b3473`
- **frontend**: localization — locale-keyed message catalog ([#44](https://github.com/Rise-Experts/retinue/issues/44)) `dfb4245f`
- **context-inspector**: conversationContext query + useSessionContext + panel shaping ([#39](https://github.com/Rise-Experts/retinue/issues/39)) `5edb0c88`
- **frontend**: headless React hooks + typed part reducers + reconnect ([#38](https://github.com/Rise-Experts/retinue/issues/38)) `248d7edc`
- **transports**: SSE transport adapter (embedded-profile streaming) ([#37](https://github.com/Rise-Experts/retinue/issues/37)) `2112d048`
- **graphql**: schema + thin resolvers + subscriptions ([#36](https://github.com/Rise-Experts/retinue/issues/36)) `67cdef30`
- **memory**: user-level (principal) memory — store, extraction, budgeted provider ([#47](https://github.com/Rise-Experts/retinue/issues/47)) `716e26fc`
- **mcp**: outbound MCP connections, egress policy, classification, namespacing, drift (#34, #35) ([#34](https://github.com/Rise-Experts/retinue/issues/34)) `bdb9a58e`
- **hitl**: durable questions + approvals with idempotent, unbypassable resume (#32, #33) ([#32](https://github.com/Rise-Experts/retinue/issues/32)) `cb3b4fb6`
- **context**: long-thread compaction into durable summaries ([#31](https://github.com/Rise-Experts/retinue/issues/31)) `07a004d2`
- **skills**: versioned, lazy-loaded, recorded-per-run skills ([#30](https://github.com/Rise-Experts/retinue/issues/30)) `69e967e4`
- **context**: context providers + budgeting + previewable prompt assembly ([#29](https://github.com/Rise-Experts/retinue/issues/29)) `79188b69`
- **tools**: tool registry — effects, permission-filtered catalog, meta-tools, lazy discovery ([#28](https://github.com/Rise-Experts/retinue/issues/28)) `78ac3d7b`
- **usage**: usage recording hook + pre-flight ceilings ([#27](https://github.com/Rise-Experts/retinue/issues/27)) `a780173e`
- **runtime**: per-conversation run serialization + atomic session-state write ([#26](https://github.com/Rise-Experts/retinue/issues/26)) `58030c14`
- **runtime**: streaming typed parts + transport-neutral event layer ([#25](https://github.com/Rise-Experts/retinue/issues/25)) `c6adc777`
- **runtime**: BullMQ-style durable runtime — claim, checkpoint, cancel, recover, retry ([#24](https://github.com/Rise-Experts/retinue/issues/24)) `5ab9bd7b`
- **persistence**: Supabase adapter — RLS + Realtime ([#21](https://github.com/Rise-Experts/retinue/issues/21)) `80e23adf`
- **persistence**: automatic schema provisioning — SchemaManager ([#22](https://github.com/Rise-Experts/retinue/issues/22)) `47d716ef`
- **authorization**: reference policy engine ([#23](https://github.com/Rise-Experts/retinue/issues/23)) `4d37f125`
- **models**: Vercel AI SDK provider factory ([#19](https://github.com/Rise-Experts/retinue/issues/19)) `04a61141`
- **models**: model registry resolution + cost computation ([#18](https://github.com/Rise-Experts/retinue/issues/18)) `8e64ea62`
- **persistence**: storage exemplar + in-memory adapter + conformance harness ([#17](https://github.com/Rise-Experts/retinue/issues/17)) `762417f5`
- **docs**: Docusaurus documentation site with TypeDoc API + llms/MCP ([#50](https://github.com/Rise-Experts/retinue/issues/50)) `de824a07`
- **evals**: representative evaluation dataset — 110 cases ([#13](https://github.com/Rise-Experts/retinue/issues/13)) `9f310b24`
- **events**: surface retries to the frontend (refs #24 #36 #38) ([#24](https://github.com/Rise-Experts/retinue/issues/24)) `c98cb652`
- monorepo bootstrap, CI and dependency-boundary check ([#11](https://github.com/Rise-Experts/retinue/issues/11)) `ea0fa533`

### Fixed

- **capabilities**: remove a gate nothing could call ([#198](https://github.com/Rise-Experts/retinue/issues/198)) `684bb1d3`
- **example**: four defects that were correct-looking and unobservable ([#178](https://github.com/Rise-Experts/retinue/issues/178)) `3d1525b1`
- **usage**: restart-safe record ids, and per-person metrics with configurable limits (#174, #175) ([#174](https://github.com/Rise-Experts/retinue/issues/174)) `b7badc61`
- a run now knows who it is for, and three features that were built but unreachable (#164, #165, #166) ([#164](https://github.com/Rise-Experts/retinue/issues/164)) `a47a435f`
- **shadow**: suppress at the registry, not only in the envelope ([#126](https://github.com/Rise-Experts/retinue/issues/126)) `397ec603`
- **sse**: match the graphql-sse wire format ([#111](https://github.com/Rise-Experts/retinue/issues/111)) `2ed1be1e`
- **test**: share one Postgres pool per conformance file ([#100](https://github.com/Rise-Experts/retinue/issues/100)) `72b2d35a`
- **security**: address second adversarial review — SSRF, fail-open approval, over-broad grant `8f70b8a8`
- **runtime**: address adversarial review of REQ-005 (C1 critical + M1/M2/M4) `6c20d921`
- **docs**: make repo root deployable (root wrangler.jsonc + docs:build) `bd993ebf`
- **docs**: self-contained website build so Cloudflare resolves backend deps ([#57](https://github.com/Rise-Experts/retinue/issues/57)) `18210e31`
- **docs**: root-aware deploy commands for Cloudflare (no Root-directory dependency) ([#56](https://github.com/Rise-Experts/retinue/issues/56)) `115eae2a`
- **docs**: TypeDoc resolves @agentkit/* from source; simplify build (refs #50) ([#50](https://github.com/Rise-Experts/retinue/issues/50)) `24a29df3`

### Performance

- **test**: share one PGlite instance per file, isolate by schema ([#111](https://github.com/Rise-Experts/retinue/issues/111)) `68f11aa1`

### Changed

- the package root goes from 392 exports to five ([#199](https://github.com/Rise-Experts/retinue/issues/199)) `6f4f3775`
- the host moves into the runtime's package as a subpath ([#196](https://github.com/Rise-Experts/retinue/issues/196)) `fc39a9e9`
- **backend**: subpath entries, and 9 dependencies become optional peers ([#196](https://github.com/Rise-Experts/retinue/issues/196)) `bc673943`

### Documentation

- **platform**: the boundary decided, and a check that a consumer cannot cross it ([#195](https://github.com/Rise-Experts/retinue/issues/195)) `09733f95`
- correct two READMEs that understated their packages, add a third, and document the limits work ([#161](https://github.com/Rise-Experts/retinue/issues/161)) `79ffde31`
- put the citation-rendering section in the frontend spec, not a new file `b66b5bf3`
- **site**: developer-platform docs — IA, landing page, search, themes (#50) ([#50](https://github.com/Rise-Experts/retinue/issues/50)) `48777f4f`
- **extraction**: twenty-sdk comparison & tool/function bridge decision ([#14](https://github.com/Rise-Experts/retinue/issues/14)) `de8968da`
- add user-level (principal) memory spec `7b9d3bf5`
- **extraction**: inventory Twenty/Agno modules & dependency edges ([#12](https://github.com/Rise-Experts/retinue/issues/12)) `be5cf72a`
- add localization (i18n) spec and wire into contracts `9c99ba75`
- **runtime**: specify Claude-style retry policy (refs #19 #24) ([#19](https://github.com/Rise-Experts/retinue/issues/19)) `36be158e`

### Tests

- **capabilities**: all 256 combinations, not six hand-picked ones ([#197](https://github.com/Rise-Experts/retinue/issues/197)) `54ee8c4d`
- **guard**: a shipped capability must be wired to something ([#170](https://github.com/Rise-Experts/retinue/issues/170)) `7acb1337`
- **interop**: consume the SSE endpoint with a real graphql-sse client ([#112](https://github.com/Rise-Experts/retinue/issues/112)) `410c4472`

### Build

- **backend**: stop shipping broken source maps, and verify the tarball (#196 AC-8) ([#196](https://github.com/Rise-Experts/retinue/issues/196)) `e1f3be25`
- **docs**: self-contained deploy script so Cloudflare deploy builds the site first `d871296b`

### CI

- a Jenkinsfile for test trends, and a guard so three definitions cannot drift `ffc4e303`
- run on a self-hosted runner, and a local gate that cannot drift from it `0fb87fdb`
- allow CI to be re-run on demand `f358ebc8`
- **docs**: build @agentkit packages before the site so TypeDoc resolves types `1726e95b`
- **docs**: deploy site via Cloudflare Workers Static Assets ([#50](https://github.com/Rise-Experts/retinue/issues/50)) `c1446104`

### Chores

- **release**: versions, a semver statement, a deprecation policy and a release check ([#189](https://github.com/Rise-Experts/retinue/issues/189)) `2fd81092`
- **shareflow**: the three cutover decisions, recorded (#128 AC-1, AC-3, AC-6) ([#128](https://github.com/Rise-Experts/retinue/issues/128)) `9149e4ab`
- scaffold branch for #97 ([#97](https://github.com/Rise-Experts/retinue/issues/97)) `009ea861`
- scaffold branch for #96 ([#96](https://github.com/Rise-Experts/retinue/issues/96)) `6034ba70`
- scaffold branch for #95 ([#95](https://github.com/Rise-Experts/retinue/issues/95)) `fd5bdfac`
- scaffold branch for #93 ([#93](https://github.com/Rise-Experts/retinue/issues/93)) `ceb00ae2`
- scaffold branch for #21 ([#21](https://github.com/Rise-Experts/retinue/issues/21)) `3708c04f`
- scaffold branch for #22 ([#22](https://github.com/Rise-Experts/retinue/issues/22)) `81e4ae89`
- scaffold branch for #23 ([#23](https://github.com/Rise-Experts/retinue/issues/23)) `8918c26a`
- scaffold branch for #17 ([#17](https://github.com/Rise-Experts/retinue/issues/17)) `fc50acc8`
- scaffold branch for #50 ([#50](https://github.com/Rise-Experts/retinue/issues/50)) `a812427b`
- scaffold branch for #14 ([#14](https://github.com/Rise-Experts/retinue/issues/14)) `c3f4935c`
- scaffold branch for #13 ([#13](https://github.com/Rise-Experts/retinue/issues/13)) `534ac471`
- scaffold branch for #12 ([#12](https://github.com/Rise-Experts/retinue/issues/12)) `d0111910`
- scaffold branch for #11 ([#11](https://github.com/Rise-Experts/retinue/issues/11)) `8a2523aa`

_8 commit(s) had no conventional-commit type and are not listed above._

