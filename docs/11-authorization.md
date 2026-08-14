# Authorization

Authorization is referenced throughout the platform — `authorizationPolicyId` on agents,
`authorizationPolicy` in composition, `roleIds` on the execution context, permission-filtered
tool catalogs and permission-scoped knowledge chunks. This specification defines the model
those references share.

Authorization is a first-class port, never scattered `if` checks inside services.

## Principle

Every tenant-sensitive decision — discover a tool, execute a tool, read a file, retrieve a
chunk, open a conversation — is a permission check against the caller's
`ExecutionContext`. Model-generated input can never widen the caller's permissions.

## Policy port

```ts
interface AuthorizationPolicy {
  can(context: ExecutionContext, action: string, resource: ResourceRef): Promise<Decision>;
  filterTools(context: ExecutionContext, tools: ToolDescriptor[]): Promise<ToolDescriptor[]>;
  scope(context: ExecutionContext, resourceType: string): Promise<PermissionScope>;
}

type Decision = { allow: boolean; reason?: string; obligations?: Obligation[] };
```

- `can` answers a single point decision and may return obligations (for example, "requires
  approval" or "redact field X").
- `filterTools` produces the permission-filtered catalog before discovery.
- `scope` returns the query-time filter (tenant, roles, resource ACL) applied *before*
  search, so retrieval and listing never return unauthorized rows.

## Permission model

- Principals hold roles through memberships; roles grant permissions.
- Permissions are `action` + `resourceType` pairs, optionally narrowed by resource
  attributes (owner, collection, sensitivity, connection).
- Tenant policy may further restrict, but never expand, administrator defaults.
- Decisions are deterministic and cache-safe for the life of a request.

## Two-phase tool authorization

```mermaid
flowchart LR
  Catalog["Full tool set"] --> Filter["filterTools (pre-discovery)"]
  Filter --> Discoverable["Compact catalog"]
  Discoverable --> Exec["execute_tool"]
  Exec --> Recheck["can (pre-execution)"]
  Recheck -->|allow| Run["Run tool"]
  Recheck -->|deny| Reject["Reject"]
```

A tool that was discoverable earlier is re-authorized at execution. Direct execution of a
tool absent from discovery is rejected, not silently run.

## Relationship to other concerns

- **Approvals** (doc 04): an `external-write`/`destructive` effect combined with an
  obligation triggers `request_approval`. Authorization decides *who may*, approval decides
  *this specific action now*.
- **RLS** (doc 02): database row-level security enforces the same scope at the storage
  boundary as a defense in depth. `scope()` and RLS must agree.
- **RAG** (doc 05): `scope()` supplies the authorization filter applied before vector and
  keyword search.

## Auditing

Every deny, every granted external write and every obligation is recorded as an audit event
with context identity, action, resource and reason. Authorization changes are versioned.

## Acceptance criteria

- No store, tool or retrieval path executes without an explicit authorization decision.
- Unauthorized tools are absent from discovery and rejected on direct execution.
- Retrieval and list results never cross tenant or role scope, proven by isolation tests.
- Storage RLS and the policy port produce the same visibility for the same context.
- Denials and authorized external writes are auditable with a stable reason.
