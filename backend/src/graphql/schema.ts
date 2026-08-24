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
    """
    The window in words — "the day", "any 5 hours" (#181).

    period stayed for the calendar case and is **null** for a rolling window, because no RollupPeriod describes
    one and returning "hour" for a five-hour window would be a wrong answer rather than a missing one. A client
    rendering the window reads this field; one keying a chart by bucket reads period and correctly finds nothing
    to key by.
    """
    window: String!
    period: String
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

  """
  One question put to a person, as it must be *rendered* — #163.

  The event that suspends a run carries only an interactionId, deliberately: events are thin, and a payload
  that duplicated the question would be a second copy to keep in step with the stored one. But nothing exposed
  the stored one either, so a client could answer a question it had no way to display. The example's picker
  rendered an empty text box next to "The assistant has a question", which is the whole gap in one screenshot.
  """
  type PendingQuestionSpec {
    "Stable key the answer is filed under."
    key: String!
    prompt: String!
    "A short closed list, when there is one. Empty means free text."
    options: [String!]!
    "Several choices are allowed, not one."
    multiple: Boolean!
    "Free text is accepted alongside the options."
    allowOther: Boolean!
  }

  type PendingQuestion {
    interactionId: ID!
    runId: ID!
    questions: [PendingQuestionSpec!]!
    createdAt: DateTime!
  }

  """
  The approval a run is parked on — the read side of decideApproval (#163).

  The same gap as pendingQuestion and milder rather than absent: approval.requested also carries only an
  interaction id, so a client had no summary to show and fell back to a generic "Run a tool?". Asking someone
  to authorise an action the card cannot name is how approval becomes a reflex.
  """
  type PendingApprovalDetail {
    interactionId: ID!
    runId: ID!
    toolName: String!
    "One line a person can decide on, written by the host's summarizer."
    summary: String!
    riskCategory: String!
    expiresAt: DateTime!
    "The arguments the approval is for, so what runs is what was shown."
    normalizedInput: JSON!
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
    """
    The question a run is parked on, or null — the read side of answerQuestion (#163).

    Null covers both "this run was never asked anything" and "it has been answered already", because a client
    has the same thing to do in either case: show no picker. A run that is waiting is the only state with a
    question to render.
    """
    pendingQuestion(runId: ID!): PendingQuestion
    "The approval a run is parked on, or null (#163)."
    pendingApproval(runId: ID!): PendingApprovalDetail
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
