/**
 * Run the agent evaluation against a deployment — #669. The protocol and the scoring are in
 * `src/eval/agent-eval.ts`; this sends the turns and collects what each one stored.
 *
 * It talks to the ShareFlow service directly, with the headers the web app sends (deployment.ts →
 * createAuthenticator), so the secret is read from the environment and never printed. On the production box,
 * inside the running container, where `SHARED_API_SECRET` is already set:
 *
 *     docker exec -e EVAL_WORKSPACE_ID=<workspace> -e EVAL_USER_ID=<member> \
 *       social_share-shareflow-1 node scripts/agent-eval.mjs
 *
 * Locally (see README → "Running the whole thing locally"): `npm run build`, then the same with
 * EVAL_BASE_URL=http://127.0.0.1:4000 SHARED_API_SECRET=… node scripts/agent-eval.mjs
 *
 * Settings, all from the environment:
 *
 *     EVAL_WORKSPACE_ID, EVAL_USER_ID   required — the workspace the turns run in, and a member of it
 *     EVAL_BASE_URL                     default http://127.0.0.1:4000
 *     EVAL_MODEL                        a model id for the turn settings; default: the workspace's own
 *     EVAL_ARCHIVE_PARTS                filler turns for the long-context run (default 0 = design run only)
 *     EVAL_TARGET_TOKENS                stop the filler once the conversation is this big (default 1000000)
 *     EVAL_ONLY                         comma-separated step ids, e.g. "seed,price-sheet" ("archive" for the filler;
 *                                       "deck-quote-attribution" needs the deck steps before it, or EVAL_CONVERSATION_ID)
 *     EVAL_CONVERSATION_ID              continue an earlier eval chat instead of starting a new one
 *     EVAL_OUT                          directory for report.md and report.json (default: the OS temp dir)
 *     EVAL_TURN_TIMEOUT_MS              per turn (default 600000)
 *
 * Every turn costs what a chat turn costs (credits, or the BYO key's provider). Run the long-context part in
 * a workspace whose limit allows it. Exit code: 0 when every check passed, 1 when any failed, 2 on bad input.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { DESIGN_STEPS, EDIT_STEPS, FINAL_RECALL, RULE_STEPS, archiveStep, score, report, summarise } = await import("../dist/eval/agent-eval.js");

const env = process.env;
const need = (name) => {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`${name} is required. See the header of scripts/agent-eval.mjs.`);
    process.exit(2);
  }
  return value.trim();
};

const secret = need("SHARED_API_SECRET");
const workspaceId = need("EVAL_WORKSPACE_ID");
const userId = need("EVAL_USER_ID");
const base = (env.EVAL_BASE_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const model = env.EVAL_MODEL?.trim() || undefined;
const archiveParts = Number(env.EVAL_ARCHIVE_PARTS ?? "0");
const targetTokens = Number(env.EVAL_TARGET_TOKENS ?? "1000000");
const only = env.EVAL_ONLY?.split(",").map((id) => id.trim()).filter(Boolean);
const turnTimeoutMs = Number(env.EVAL_TURN_TIMEOUT_MS ?? "600000");
const outDir = env.EVAL_OUT ?? join(tmpdir(), `agent-eval-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const headers = {
  "x-api-secret": secret,
  "x-workspace-id": workspaceId,
  "x-user-id": userId,
  "x-roles": "editor",
  "content-type": "application/json",
};

const call = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
};

/** Read the run's events until it ends. Returns how it ended and when the first part arrived. */
const follow = async (runId, conversationId, started) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), turnTimeoutMs);
  let firstPartMs;
  try {
    const response = await call(`/api/events?${new URLSearchParams({ runId, conversationId })}`, { headers: { accept: "text/event-stream" }, signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { status: "completed", firstPartMs, closed: true };
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (data === "") continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.type === "part.added" && firstPartMs === undefined) firstPartMs = Date.now() - started;
        if (event.type === "run.completed") return { status: "completed", firstPartMs };
        // #714: a gated call waits for a person; the eval approves nothing, so the turn ends here, unanswered.
        if (event.type === "approval.requested") return { status: "paused", error: `waiting for approval: ${String(event.payload?.toolName ?? event.toolName ?? "a gated tool")}`, firstPartMs };
        if (event.type === "run.failed" || event.type === "run.cancelled" || event.type === "stream.failed") {
          const error = event.error?.message ?? event.message ?? event.payload?.error?.message ?? event.type;
          return { status: "failed", error: String(error).slice(0, 300), firstPartMs };
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) return { status: "timeout", firstPartMs };
    return { status: "error", error: error instanceof Error ? error.message : String(error), firstPartMs };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

/** Messages after the last one already read — keyset paging from that message, as the store pages. */
let lastSeen;
const newMessages = async (conversationId) => {
  const items = [];
  for (;;) {
    const cursor = lastSeen === undefined ? undefined : Buffer.from(JSON.stringify({ c: lastSeen.createdAt, i: lastSeen.id })).toString("base64");
    const query = new URLSearchParams({ limit: "100", ...(cursor === undefined ? {} : { cursor }) });
    const page = await (await call(`/api/conversations/${encodeURIComponent(conversationId)}/messages?${query}`)).json();
    items.push(...page.items);
    if (page.items.length > 0) lastSeen = page.items[page.items.length - 1];
    if (page.nextCursor === undefined || page.items.length === 0) return items;
  }
};

const getArtifact = async (artifactId) => {
  const response = await fetch(`${base}/api/tools/get_artifact`, { method: "POST", headers, body: JSON.stringify({ artifactId }) });
  if (!response.ok) return undefined;
  const body = await response.json();
  const view = body?.data ?? body?.value ?? body;
  return typeof view?.content === "string" ? { artifactId, kind: String(view.kind), content: view.content, version: view.version } : undefined;
};

const resultValue = (output) => (output !== null && typeof output === "object" && "value" in output && typeof output.type === "string" ? output.value : output);

const known = new Set();
let conversationId = env.EVAL_CONVERSATION_ID?.trim() || undefined;

const runStep = async (step) => {
  const started = Date.now();
  const body = { message: step.message, ...(conversationId === undefined ? {} : { conversationId }), ...(model === undefined ? {} : { settings: { model } }) };
  let turn;
  try {
    turn = await (await call("/api/message", { method: "POST", body: JSON.stringify(body) })).json();
  } catch (error) {
    return { step, status: "error", error: error instanceof Error ? error.message : String(error), text: "", calls: [], results: [], documents: [], earlierDocumentIds: [...known], latencyMs: Date.now() - started };
  }
  conversationId = turn.conversationId;
  const ended = await follow(turn.runId, turn.conversationId, started);
  const latencyMs = Date.now() - started;

  const messages = (await newMessages(turn.conversationId).catch(() => [])).filter((message) => message.runId === turn.runId && message.role !== "user");
  const parts = messages.flatMap((message) => message.parts ?? []);
  const text = parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
  const calls = parts.filter((part) => part.type === "tool-call").map((part) => ({ toolName: part.toolName, input: part.input }));
  const results = parts.filter((part) => part.type === "tool-result").map((part) => ({ toolName: part.toolName, output: part.output }));

  // The documents the turn touched, in call order, read back as they are now.
  const touched = [];
  for (const part of parts) {
    if (part.type === "tool-call" && typeof part.input?.artifactId === "string") touched.push(part.input.artifactId);
    if (part.type === "tool-result" && part.toolName === "create_artifact") {
      const id = resultValue(part.output)?.artifactId;
      if (typeof id === "string") touched.push(id);
    }
  }
  const unique = [...new Set(touched.reverse())].reverse();
  const documents = (await Promise.all(unique.map(getArtifact))).filter(Boolean);
  const earlierDocumentIds = [...known];
  for (const id of unique) known.add(id);

  const usage = await call(`/api/usage?${new URLSearchParams({ runId: turn.runId })}`).then((response) => response.json()).catch(() => undefined);
  // An empty transcript with the stream simply closed is not an answer.
  const status = ended.status === "completed" && messages.length === 0 && ended.closed === true ? "failed" : ended.status;
  return { step, status, ...(ended.error === undefined ? {} : { error: ended.error }), text, calls, results, documents, earlierDocumentIds, ...(usage === undefined ? {} : { usage }), latencyMs, ...(ended.firstPartMs === undefined ? {} : { firstPartMs: ended.firstPartMs }) };
};

const rows = [];
const record = (observation) => {
  const checks = score(observation);
  rows.push({ observation, checks });
  const failed = checks.filter((check) => !check.pass);
  const tokens = observation.usage?.inputTokens;
  console.error(
    `${observation.step.id.padEnd(22)} ${failed.length === 0 ? "ok  " : "FAIL"} ${String(checks.length - failed.length)}/${String(checks.length)}` +
      `  ${tokens === undefined ? "" : `${Math.round(tokens / 1000)}k ctx`}  ${(observation.latencyMs / 1000).toFixed(1)}s` +
      (failed.length === 0 ? "" : `  — ${failed.map((check) => check.name).join(", ")}`),
  );
  return observation;
};

const wanted = (step) => only === undefined || only.includes(step.id);
for (const step of DESIGN_STEPS.filter(wanted)) record(await runStep(step));
// #665: in the design chat, on the deck the steps above made.
for (const step of EDIT_STEPS.filter(wanted)) record(await runStep(step));

let consecutiveFailures = 0;
for (let part = 1; part <= archiveParts; part += 1) {
  if (only !== undefined && !only.includes("archive")) break;
  const step = archiveStep(part);
  const observation = record(await runStep(step));
  consecutiveFailures = observation.status === "completed" ? 0 : consecutiveFailures + 1;
  // F2: the 520k lock. Three refusals in a row is the finding; a hundred more prove nothing and cost money.
  if (consecutiveFailures >= 3) {
    console.error("three turns in a row failed — stopping the long run here");
    break;
  }
  if (summarise(rows).sentTokensEstimate >= targetTokens) break;
}
if (archiveParts > 0 || (only !== undefined && only.includes(FINAL_RECALL.id))) record(await runStep(FINAL_RECALL));

// #714: the rule cases, each in a chat of its own, so none sees the design run or another case.
const designConversationId = conversationId;
for (const step of RULE_STEPS.filter(wanted)) {
  conversationId = undefined;
  lastSeen = undefined;
  record(await runStep(step));
}
conversationId = designConversationId;

const meta = {
  Date: new Date().toISOString(),
  Deployment: base,
  Workspace: workspaceId,
  Conversation: conversationId ?? "—",
  "Model setting": model ?? "workspace default",
  "Archive parts": String(archiveParts),
};
const markdown = report(rows, meta);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.md"), markdown);
writeFileSync(join(outDir, "report.json"), JSON.stringify({ meta, summary: summarise(rows), rows }, null, 2));
console.log(markdown);
console.error(`report: ${join(outDir, "report.md")}`);
process.exit(rows.every((row) => row.checks.every((check) => check.pass)) ? 0 : 1);
