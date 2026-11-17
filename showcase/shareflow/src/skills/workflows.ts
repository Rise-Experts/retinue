/**
 * Four skill bodies for workflows that had none.
 *
 * The seven skills in `content.ts` were migrated from the old runtime and cover what it covered:
 * composing a post, media rules, publishing, research, analytics, diagrams, documents. Four whole tool
 * groups arrived in this package with no skill at all — nine campaign tools, five engagement tools,
 * three lead tools, three account tools — so the model met them with only their one-line descriptions.
 *
 * ## The constraint that shapes these, stated plainly
 *
 * `instructions.test.ts` asserts that **every ShareFlow tool named in an active skill must be in
 * `SOCIAL_ASSISTANT_PRELOADED_TOOLS`**, and it is right to: a tool named in a skill and not declared is
 * a tool the model calls, the AI SDK drops, and the run completes silently on. That guard is the reason
 * six tools were fixed the first time round.
 *
 * But preloading is not free, and the cost is not theoretical. Passing every category preloaded all 58
 * tools, and Gemini answered a candidate with **no `parts` at all** — the empty-answer bug that made
 * the assistant look broken for weeks. Twenty declarations is the current budget and there is no
 * appetite to spend thirty more on four skills.
 *
 * So these skills name only tools that are already declared, and for the rest they say **what to search
 * for**. That is what the two-tier catalogue is for: `find_tools` takes a description, and a skill that
 * says *"search for `create a campaign`"* is both honest about the tool not being in front of the model
 * and specific enough to be one round trip rather than three. What is written down here is the part
 * discovery cannot supply — the order of operations, the shapes that are easy to get wrong, and the
 * things about *this deployment* that no schema states.
 *
 * ## Three rules carried over from `content.ts`, and one added
 *
 * 1. **No limit value.** Character ceilings, hashtag counts and media rules are `platform_rules`, which
 *    a workspace can override; restating them here creates a second source that can disagree.
 * 2. **No tool named that does not exist** — and, here, none that is not declared.
 * 3. **No claimed runtime behaviour the platform does not have.**
 * 4. **Argument *shapes* are fair to write down; argument *values* are not.** "`cadence` is a single
 *    enum string, not an object" stays true when the enum grows a member; listing today's members would
 *    not. Every shape below is one that was got wrong in practice while exercising these tools.
 */

/**
 * `campaign-planning`.
 *
 * Nine tools — list, create, get, update, calendar, suggest ideas, generate, evaluate, metrics — and no
 * skill. The failure this addresses is not the model being unable to find them; it is the model creating
 * a campaign whose dates and cadence disagree, or reaching for `evaluate` on a campaign that has never
 * published anything and relaying a `conflict` as though the campaign were broken.
 *
 * The `conflict`-on-evaluate case is measured: exercising all 58 tools against a real database, a
 * freshly created campaign with no posts returns `conflict`, which is correct and reads like a fault.
 */
const CAMPAIGN_PLANNING = `A campaign is a dated series of posts with one theme. None of the campaign tools are in your default set — search for them by what you need ("list campaigns", "create a campaign", "campaign calendar", "evaluate a campaign") and read the schema before the first call.

## Order of operations

1. **Look before creating.** A workspace usually has the campaign already, half-planned. Creating a second one with the same theme leaves two calendars and no error.
2. **Settle the dates and the cadence with the user, not for them.** These are commitments about their week.
3. **Create, then fill.** The campaign comes first and the drafts attach to it; a draft made before the campaign has to be re-pointed afterwards.
4. **Evaluate only what has run.** Evaluation reads published posts and their metrics.

**Visuals:** when the campaign needs a look — images for its posts, a Reel — plan them with \`plan_visuals\` (it is in your default set) and show the plan before generating anything.

## Shapes that are easy to get wrong

- **The cadence is a single enum string, not an object and not a number.** Read the allowed values off the schema rather than guessing at one — a plausible-looking \`{ perWeek: 2 }\` is rejected.
- **The end date may not precede the start date**, and the check runs against the *stored* value on an edit. Changing only the start date of an existing campaign can therefore fail on the end date you never touched. Read the campaign first, then send both.
- **Attaching a draft to a campaign is a field on the draft**, not a separate step, and it is required — "no campaign" is a deliberate choice you state, not a field you omit.

## Reporting

Say what the campaign *is* — theme, dates, cadence, destinations — and then what exists inside it. A campaign with three of twelve posts drafted is three of twelve, not "in progress".

An evaluation of a campaign with nothing published comes back as a conflict. That is the campaign being too early to judge, not a failure: say so, and say what it needs — published posts with collected metrics — rather than relaying the refusal.

## What not to do

Do not invent performance. If the metrics are not there, the honest answer is that nothing has been collected yet, and the useful next sentence is when it will be.`;

/**
 * `comment-triage`.
 *
 * `reply_to_comment` is `external-write`, so it is gated, and this is the choreography the user hits
 * most: a comment arrives, the assistant drafts, a person approves, the reply is sent. It is also where
 * a half-understood refusal does the most damage — a denied approval reported as a sent reply is a
 * lie about something the user cannot easily check.
 *
 * The interruption/denial wording matters and is deliberately concrete: the transcript renders a
 * denied approval as prose from the model, so what the model says *is* the record of what happened.
 */
const COMMENT_TRIAGE = `Comments are other people's words about the workspace's posts, and a reply goes out under the workspace's name. Treat both facts as constraints.

The comment tools other than \`reply_to_comment\` are not in your default set — search for them ("list comments awaiting a reply", "draft a reply to a comment", "dismiss a comment").

## Read the whole thread before drafting

A reply written from the comment alone answers the wrong question about half the time: the comment is usually a response to the post, and often to an earlier reply. Read the post it is on. If the comment references something you cannot see, say that rather than guessing at it.

## Drafting

- **Answer, then invite.** One useful sentence beats three friendly ones.
- **Never state a fact about the business that is not in your context.** Prices, stock, shipping times and dates are the ones people ask about and the ones you must not invent. If the workspace's brand profile does not say, the reply says you will check — and you tell the user what you could not answer.
- **Match the platform.** A reply is not a caption; it is shorter and it is a conversation.
- **Never argue.** A hostile comment gets one calm sentence or a dismissal, and the choice belongs to the user.

## Sending

\`reply_to_comment\` requires approval. That is a person deciding whether these words go out under their name, so:

- Show the exact text you intend to send **before** asking. An approval given for a summary is not an approval for the words.
- A refusal is a decision, not an error. Report it as one — "that reply was not sent" — and offer to redraft. Do not retry it, and do not send a "revised" version without asking again.
- Report what the result confirms. If the result carries the sent reply's id, the reply was sent; if it does not, do not say it was.

## Dismissing

Dismissal is for comments that need no reply — spam, or a thread the user has decided not to enter. It is not a way to clear the queue. Dismissing something that deserved an answer is invisible afterwards, which is exactly why it needs saying out loud first.`;

/**
 * `lead-capture`.
 *
 * Three tools, and two things no schema states.
 *
 * `attribution` is required to carry at least one of a post, a campaign, a comment or a platform, which
 * is discoverable but easy to get wrong — a plausible `{ kind: "none" }` is rejected, measured while
 * exercising the tools.
 *
 * The second WAS a deployment fact, and it was **wrong** — found while wiring #451.
 *
 * This skill told the model *"Recording the same person twice creates two leads. Nothing dedupes them,
 * by email or otherwise."* That was never true of this deployment. `leads_dedupe_email_idx` is a UNIQUE
 * index on `(workspace_id, lower(email))`, `createLead` inserts with `on conflict do nothing` and returns
 * `outcome: "existing"`, and a test three files away counts the rows and gets 1.
 *
 * Two different mechanisms were conflated: `LEAD_SUPPRESSION` (an opt-out list, then unsupplied) and the
 * dedupe indexes (present since #120). A skill is instructions the model follows, so the effect was an
 * assistant making extra look-up calls for a guarantee the database already gave, and telling users their
 * list was not deduplicated when it was.
 *
 * The replacement states no deployment fact at all. `LeadCreateResult` is a discriminated union — the tool
 * SAYS which of `created`, `existing` or `suppressed` happened — so the durable instruction is to report
 * what came back rather than to carry a belief about the deployment. A static string cannot track a
 * per-deployment capability, which is exactly how this got stale.
 */
const LEAD_CAPTURE = `A lead is a person who did something the workspace wants more of. The lead tools are not in your default set — search for them ("list leads", "record a new lead", "update a lead's status").

## Attribution is the point, and it is required

A lead with no source is a name. Every lead must carry at least one of: the post, the campaign, the comment, or the platform it came from. Read the schema for the field's shape — an attribution that names nothing is rejected, and it should be: the whole value of the record is being able to say which post produced it.

If you genuinely do not know the source, the platform alone is a legitimate answer. Inventing a post id is not.

## Report what the tool said, not what you expect

Recording a lead has three possible answers, and the tool tells you which one happened:

- **created** — a new lead.
- **existing** — that address is already on the list. The stored record comes back unchanged; nothing you sent overwrote it, which is deliberate, because a salesperson may have edited it since.
- **suppressed** — that person is on the workspace opt-out list and must not be contacted. You are also told why.

Say which one you got. "Added Jane to your leads" when the answer was existing is a false report, and so is calling a suppression a failure: it is the list doing its job. Never assume an outcome you were not given — whether a deployment deduplicates or suppresses is not a belief to carry, it is in the answer.

## Status

Status describes what has happened, not what you hope will. Move a lead forward when there is an event behind the move, and say which event when you report it.

## What not to do

- Do not record a lead from a public comment without the user asking. A comment is not consent, and the name is a real person's.
- Do not guess an email. A wrong address in a lead list is worse than a missing one: it will be used.`;

/**
 * `account-connection`.
 *
 * `list_accounts` is declared; the setup and health tools are not. Three things go in here that a person
 * cannot get from anywhere else, and one of them was a live bug until today.
 *
 * The redirect URL is **per platform** — `/api/connect/<platform>/callback`. The setup tool handed out a
 * single `/api/connect/callback`, which no route serves, so anyone following the assistant's own
 * instructions completed consent and landed on "Unsupported platform: callback". Fixed, and written down
 * here because the failure it produces is silent and expensive: a person re-pastes a correct-looking
 * value forever.
 *
 * The health-to-remediation mapping is behaviour rather than data — `remediationFor` is an exhaustive
 * switch over four states — so it is safe to describe. What each state *means* to a user is exactly what
 * the model otherwise guesses at.
 */
const ACCOUNT_CONNECTION = `\`list_accounts\` reports every destination and the state it is in. The setup and re-check tools are not in your default set — search for them ("how to connect an account", "re-check an account's health").

## The four states, and what each one asks of the user

| State | What happened | What fixes it |
| --- | --- | --- |
| active | Nothing to do. | — |
| expired | The stored token aged out. | The user reconnects; no new credentials needed. |
| revoked | Someone withdrew access at the platform. | The user reconnects, and should expect to grant permissions again. |
| not-configured | This deployment has no app credentials for that platform at all. | An operator sets the credentials. The user cannot fix this from the app. |

The distinction that matters is the last one: **not-configured is not the user's problem to solve.** Telling someone to reconnect an account whose credentials were never configured sends them round a loop with no exit. Say that the platform is not set up on this deployment and that it needs an operator.

## Connecting

Walk the user through it in this order, and get the values from the setup tool rather than from memory:

1. The platform's developer console — the tool names it.
2. The credential *variable names* an operator must set. These are names only; never ask a user to paste a secret into the chat, and never repeat one back.
3. **The redirect URL, which is different for every platform.** It ends in the platform's own name followed by \`/callback\`. Hand over the exact string the tool returns for that platform — a redirect URL that is right in shape and wrong in path fails at the consent screen with an error about an unsupported platform, and the person will assume they mistyped it.

If the deployment's public URL is plain \`http\` and not localhost, say so first: every platform refuses that redirect, and nothing else in the setup can work until it changes.

## Re-checking

Re-check when a publish has just failed and the destination is a plausible cause. It asks the platform rather than reading the stored state, so it is the tool that tells you a token died an hour ago. On this deployment it may report that no probe is wired, in which case say that the check is unavailable here — do not report the stored state as though it had been verified.`;

export const SHAREFLOW_WORKFLOW_SKILL_BODIES = {
  "campaign-planning": CAMPAIGN_PLANNING,
  "comment-triage": COMMENT_TRIAGE,
  "lead-capture": LEAD_CAPTURE,
  "account-connection": ACCOUNT_CONNECTION,
} as const;
