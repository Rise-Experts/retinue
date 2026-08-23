/**
 * GraphQL schema (SDL) — `docs/06-graphql-and-frontend.md` → GraphQL boundary.
 *
 * The package ships the schema as SDL plus a thin resolver map (see `./resolvers`), so a host can
 * mount it on any GraphQL server (Yoga, Apollo, Mercurius) without the library taking a server
 * dependency. Resolvers stay thin: authenticate, validate, build the execution context, call a
 * platform service. Subscriptions carry the stable `RunEvent` set and support resuming after a
 * cursor via `openRunEventStream`.
 */

export const typeDefs = /* GraphQL */ `
  scalar JSON
  scalar DateTime

  type Conversation {
    id: ID!
    title: String!
    version: Int!
    archivedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type ConversationPage {
    items: [Conversation!]!
    nextCursor: String
  }

  enum RunStatus {
    queued
    running
    waiting_for_question
    waiting_for_approval
    retry_pending
    completed
    failed
    cancelled
  }

  type Run {
    id: ID!
    conversationId: ID!
    status: RunStatus!
    createdAt: DateTime!
    finishedAt: DateTime
  }

  type ToolCatalogEntry {
    name: String!
    label: String!
    description: String!
    category: String!
    effect: String!
  }

  type ToolCatalog {
    preloaded: [JSON!]!
    discoverable: [ToolCatalogEntry!]!
    meta: [ToolCatalogEntry!]!
  }

  type UsageTotals {
    inputTokens: Int!
    outputTokens: Int!
    cachedInputTokens: Int!
    costMinorUnits: Int!
    eventCount: Int!
  }

  "One period's consumption. #139's rollups, so a chart never scans raw records."
  type UsageBucket {
    bucketStart: String!
    totals: UsageTotals!
    currency: String!
  }

  "Consumption grouped by model or conversation over the requested range."
  type UsageBreakdownEntry {
    key: String!
    totals: UsageTotals!
  }

  """
  Where the tenant stands against its limit.

  Absent when no limit is configured — which means unbounded, not zero. A UI must show "no limit set"
  rather than a full bar.
  """
  type UsageQuota {
    period: String!
    costLimitMinorUnits: Int
    inputTokenLimit: Int
    outputTokenLimit: Int
    "The fraction of the limit at which a warning shows. Sent so the UI cannot disagree with the server."
    warnAt: Float!
    "True once any dimension is past warnAt and still admitted."
    warning: Boolean!
    "True once any dimension has reached its limit, so work is being refused."
    exceeded: Boolean!
  }

  """
  The usage report a spend panel renders.

  One query rather than several, so a panel cannot show a total from one moment and a breakdown from another.
  """
  type UsageReport {
    period: String!
    from: String!
    to: String!
    totals: UsageTotals!
    buckets: [UsageBucket!]!
    byModel: [UsageBreakdownEntry!]!
    byConversation: [UsageBreakdownEntry!]!
    quota: UsageQuota
    currency: String!
  }

  "A single transport event; payload carries the typed part / lifecycle detail."
  type RunEvent {
    type: String!
    runId: ID!
    sequence: Int!
    occurredAt: DateTime!
    payload: JSON!
  }

  input QuestionAnswerInput {
    interactionId: ID!
    runId: ID!
    answers: JSON!
  }

  input ApprovalDecisionInput {
    interactionId: ID!
    runId: ID!
    decision: String!
  }

  "A section that shaped a turn's prompt — for the context inspector (#39)."
  type InspectedSection {
    title: String!
    providerId: String!
    kind: String!
    provenance: String!
    estimatedTokens: Int!
    sensitivity: String!
    included: Boolean!
    prunedReason: String
  }

  type ContextInspection {
    sections: [InspectedSection!]!
    totalTokens: Int!
    budget: JSON!
  }

  type Query {
    conversations(limit: Int!, cursor: String): ConversationPage!
    conversation(id: ID!): Conversation
    run(id: ID!): Run
    toolCatalog(preloaded: [String!]!, categories: [String!]!, excluded: [String!]!): ToolCatalog!
    usage(runId: ID): UsageTotals!
    """
    Consumption and cost by period, with breakdowns and quota state (#140).

    An extension of the usage query rather than a second endpoint: a panel showing a total from one query and a
    breakdown from another can show two moments at once, and the discrepancy looks like a bug in the numbers.
    """
    usageReport(period: String!, from: String!, to: String!, breakdownLimit: Int): UsageReport!
    "What context shaped a turn — attributes memory/tools/history that influenced the prompt."
    conversationContext(conversationId: ID!, runId: ID): ContextInspection
  }

  type Mutation {
    createConversation(id: ID!, title: String!): Conversation!
    renameConversation(id: ID!, expectedVersion: Int!, title: String!): Conversation!
    archiveConversation(id: ID!, expectedVersion: Int!): Conversation!
    deleteConversation(id: ID!): Boolean!
    sendMessage(conversationId: ID!, runId: ID!): Run!
    cancelRun(runId: ID!): Boolean!
    answerQuestion(input: QuestionAnswerInput!): Boolean!
    decideApproval(input: ApprovalDecisionInput!): Boolean!
  }

  type Subscription {
    "Conversation/run events, resumable after a cursor (sequence)."
    runEvents(runId: ID!, conversationId: ID!, after: Int): RunEvent!
  }
`;
