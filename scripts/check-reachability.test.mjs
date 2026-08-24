/**
 * Proves the reachability guard catches each shape of "built but unreachable" it was written for.
 *
 * A guard nobody has watched fail is a guard nobody should trust. Every case here corresponds to a real defect:
 * an exported capability with no caller (#165, #169), an event type in a closed union that nothing emits (#163),
 * and the two holes found by sabotaging the guard itself against the real tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyse, parseEventTypes } from "./check-reachability.mjs";

const scopes = { host: ["examples/src"], platform: ["backend/src"] };
const capability = (over = {}) => ({ name: "thing", symbol: "createThing", scope: "host", why: "because", ...over });

test("a capability referenced from the reference host passes", () => {
  const failures = analyse({
    files: [
      { path: "backend/src/thing.ts", code: `export const createThing = () => ({});` },
      { path: "examples/src/app.ts", code: `const t = createThing();` },
    ],
    capabilities: [capability()],
    eventTypes: [],
  });
  assert.deepEqual(failures, []);
});

test("a capability with no caller anywhere fails", () => {
  const failures = analyse({
    files: [{ path: "backend/src/thing.ts", code: `export const createThing = () => ({});` }],
    capabilities: [capability()],
    eventTypes: [],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /unreachable/);
});

test("the declaring module does not count as its own consumer", () => {
  // The whole failure mode: an export referenced only where it is declared. Counting the declaration would make
  // every unreachable capability look wired.
  const failures = analyse({
    files: [
      {
        path: "examples/src/thing.ts",
        code: `export const createThing = () => ({});\nconst unused = createThing;`,
      },
    ],
    capabilities: [capability()],
    eventTypes: [],
  });
  assert.equal(failures.length, 1);
});

test("a capability named only in a comment fails", () => {
  // Every one of the four real defects was described in detail by the code around it. Prose is not wiring.
  const failures = analyse({
    files: [
      { path: "backend/src/thing.ts", code: `export const createThing = () => ({});` },
      { path: "examples/src/app.ts", code: `// we should call createThing() here one day\n/* createThing */` },
    ],
    capabilities: [capability()],
    eventTypes: [],
  });
  assert.equal(failures.length, 1);
});

test("an import is not a use", () => {
  // Found by sabotaging this guard: deleting the wiring call while leaving the import in place passed, which is
  // exactly the state being hunted — symbol present, wiring gone.
  const failures = analyse({
    files: [
      { path: "backend/src/thing.ts", code: `export const createThing = () => ({});` },
      { path: "examples/src/app.ts", code: `import { createThing } from "./thing.js";\nconst x = 1;` },
    ],
    capabilities: [capability()],
    eventTypes: [],
  });
  assert.equal(failures.length, 1);
});

test("a multi-line import is not a use either", () => {
  const failures = analyse({
    files: [
      { path: "backend/src/thing.ts", code: `export const createThing = () => ({});` },
      {
        path: "examples/src/app.ts",
        code: `import {\n  somethingElse,\n  createThing,\n} from "./thing.js";\nconst x = 1;`,
      },
    ],
    capabilities: [capability()],
    eventTypes: [],
  });
  assert.equal(failures.length, 1);
});

test("a capability wired in the wrong scope fails", () => {
  // "Referenced somewhere" is not the question. A platform capability wired only by an example is still a
  // capability every other host has to wire itself.
  const failures = analyse({
    files: [
      { path: "backend/src/thing.ts", code: `export const createThing = () => ({});` },
      { path: "examples/src/app.ts", code: `const t = createThing();` },
    ],
    capabilities: [capability({ scope: "platform" })],
    eventTypes: [],
  });
  assert.equal(failures.length, 1);
});

test("a declared file that does not exist fails rather than passing vacuously", () => {
  const failures = analyse({
    files: [{ path: "examples/src/app.ts", code: `const t = createThing();` }],
    capabilities: [capability({ file: "examples/src/gone.ts" })],
    eventTypes: [],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /does not exist/);
});

test("an event nothing emits fails, even when everything handles it", () => {
  // How #163 hid: `question.requested` was in the union, the worker switched on it, the telemetry map named it,
  // the frontend reduced it — and no code path produced one. Every exhaustiveness check passed.
  const failures = analyse({
    files: [
      {
        path: "backend/src/worker.ts",
        code: `switch (e.type) { case "run.queued": return "queued"; }`,
      },
    ],
    capabilities: [],
    eventTypes: ["run.queued"],
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /never emitted/);
});

test("an event emitted as a type literal passes", () => {
  const failures = analyse({
    files: [{ path: "backend/src/worker.ts", code: `await emit({ type: "run.queued" });` }],
    capabilities: [],
    eventTypes: ["run.queued"],
  });
  assert.deepEqual(failures, []);
});

test("an exempted event passes, and the exemption is data", () => {
  const failures = analyse({
    files: [{ path: "backend/src/x.ts", code: `const nothing = 1;` }],
    capabilities: [],
    eventTypes: ["run.queued"],
    exemptEvents: { "run.queued": "produced by the reducer's fold" },
  });
  assert.deepEqual(failures, []);
});

test("no event types at all is a failure, not a pass", () => {
  // A guard that silently checks nothing is worse than no guard: it reports success.
  const failures = analyse({ files: [], capabilities: [], eventTypes: [], requireEvents: true });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /vacuously/);
});

test("parseEventTypes reads the closed union", () => {
  const types = parseEventTypes(
    `export const RUN_EVENT_TYPES = [\n  "run.queued",\n  "part.added",\n] as const;\nexport type X = 1;`,
  );
  assert.deepEqual(types, ["run.queued", "part.added"]);
});

test("parseEventTypes returns nothing when the union moves, so the guard fails loudly", () => {
  // Rather than silently checking zero events if the source is refactored.
  assert.deepEqual(parseEventTypes(`export const SOMETHING_ELSE = ["a"] as const;`), []);
});
