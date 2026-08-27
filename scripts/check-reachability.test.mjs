/**
 * Proves the reachability guard catches each shape of "built but unreachable" it was written for.
 *
 * A guard nobody has watched fail is a guard nobody should trust. Every case here corresponds to a real defect:
 * an exported capability with no caller (#165, #169), an event type in a closed union that nothing emits (#163),
 * and the two holes found by sabotaging the guard itself against the real tree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyse, parseEventTypes, parseFields, isTest } from "./check-reachability.mjs";

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

/* ------------------------------------------------- question 3: declared fields (#245) */

const declared = (over = {}) => ({
  type: "AgentManifest",
  file: "backend/src/agents/index.ts",
  scope: "platform",
  definers: ["backend/src/agents/index.ts", "backend/src/agents/define.ts"],
  fields: ["toolPolicy"],
  ...over,
});

test("a field read as a property access passes", () => {
  const failures = analyse({
    files: [{ path: "backend/src/engine.ts", code: `const p = manifest.toolPolicy;` }],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared()],
    scopes,
  });
  assert.deepEqual(failures, []);
});

test("a field nothing reads fails, naming it", () => {
  const failures = analyse({
    files: [{ path: "backend/src/engine.ts", code: `const x = 1;` }],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared()],
    scopes,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /AgentManifest\.toolPolicy is declared and never read/);
});

test("sabotage 1: the field's own default does not count as a read", () => {
  // `defineAgent` sets `toolPolicy: { preloaded: [], … }` and interprets nothing. The function that makes a
  // field inert mentions it by necessity, so counting the definer would pass on exactly the broken state.
  const failures = analyse({
    files: [
      {
        path: "backend/src/agents/define.ts",
        code: `export const defineAgent = (i) => ({ toolPolicy: { preloaded: [] }, ...i });\nconst d = x.toolPolicy;`,
      },
    ],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared()],
    scopes,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /never read/);
});

test("sabotage 2: a test asserting the default does not count as a read", () => {
  // The real one: `agent.test.ts` asserts `m.toolPolicy` equals the default, which passes forever whether or not
  // anything interprets the field. Filtered inside analyse, so the property does not depend on the file walk.
  const failures = analyse({
    files: [
      {
        path: "backend/src/agents/__tests__/agent.test.ts",
        code: `expect(m.toolPolicy).toEqual({ preloaded: [] });`,
      },
      { path: "backend/src/agents/thing.test.ts", code: `const q = manifest.toolPolicy;` },
    ],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared()],
    scopes,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /never read/);
  assert.ok(isTest("backend/src/agents/__tests__/agent.test.ts"));
});

test("constructing a value with the field set is not reading it", () => {
  // `toolPolicy:` in an object literal builds a manifest; `.toolPolicy` interprets one. The five dead fields
  // were all constructed and never interpreted, so a mention-based check would have passed on all of them.
  const failures = analyse({
    files: [{ path: "backend/src/host.ts", code: `const m = { toolPolicy: { preloaded: ["a"] } };` }],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared()],
    scopes,
  });
  assert.equal(failures.length, 1);
});

test("a field named only in a comment fails", () => {
  const failures = analyse({
    files: [{ path: "backend/src/engine.ts", code: `// one day we will honour manifest.toolPolicy here\n/* .toolPolicy */` }],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared()],
    scopes,
  });
  assert.equal(failures.length, 1);
});

test("an exemption with a reason is honoured", () => {
  const failures = analyse({
    files: [{ path: "backend/src/engine.ts", code: `const x = 1;` }],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared({ exempt: { toolPolicy: "Display only; rendered by the host." } })],
    scopes,
  });
  assert.deepEqual(failures, []);
});

test("an exemption with an empty reason fails", () => {
  // An exemption list without reasons is a place to hide a dead field. The reason is the value, so requiring it
  // to be non-empty is what makes "written down" structural rather than conventional.
  const failures = analyse({
    files: [{ path: "backend/src/engine.ts", code: `const x = 1;` }],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared({ exempt: { toolPolicy: "  " } })],
    scopes,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /exempt with no reason/);
});

test("a type whose fields cannot be parsed fails rather than passing vacuously", () => {
  // Renaming or moving the type would otherwise report success having examined nothing — the same shape
  // `requireEvents` exists to prevent for events.
  const failures = analyse({
    files: [{ path: "backend/src/engine.ts", code: `const x = 1;` }],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared({ fields: [] })],
    scopes,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no fields parsed/);
});

test("parseFields reads the top-level fields, and nothing past the closing brace", () => {
  // Two properties. Brace counting stops the body at the type's own `}` — a terminating regex on `};` would run
  // into the next declaration and check `Other`'s fields as if they were this type's. And matching only at line
  // start keeps an inline object's members out: `a` and `b` are fields of `nested`'s type, not of the manifest,
  // and reporting them would be a false alarm against code that is correct.
  const source = [
    "export type AgentManifest = {",
    "  readonly id: string;",
    "  readonly nested: { readonly a: string; readonly b: number };",
    "  readonly responseFormat: ResponseFormat;",
    "  readonly optional?: string;",
    "};",
    "export type Other = { readonly zzz: string };",
  ].join("\n");
  const fields = parseFields(source, "AgentManifest");
  assert.deepEqual(fields, ["id", "nested", "responseFormat", "optional"]);
  assert.ok(!fields.includes("zzz"), "must not read past the closing brace");
  assert.ok(!fields.includes("a"), "an inline object's members are not the type's fields");
});

test("parseFields on a renamed type returns nothing, which analyse turns into a failure", () => {
  assert.deepEqual(parseFields("export type Renamed = { readonly a: string };", "AgentManifest"), []);
});

test("adding a new field with no reader fails — AC-5", () => {
  // The durable property: this is what stops a ninth built-and-unreachable feature, rather than the five found
  // by grepping once.
  const source = "export type AgentManifest = {\n  readonly limits: X;\n  readonly brandNewThing: Y;\n};";
  const fields = parseFields(source, "AgentManifest");
  assert.ok(fields.includes("brandNewThing"));
  const failures = analyse({
    files: [{ path: "backend/src/engine.ts", code: `const s = manifest.limits.maxSteps;` }],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared({ fields })],
    scopes,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /brandNewThing/);
});

test("a known-defect exemption passes but must carry an issue number", () => {
  // `{ defect, issue }` keeps main green while the fix is filed, and the CLI prints it on every run. Without a
  // real issue number it is an ordinary silent exemption wearing a label, so the shape is enforced.
  const ok = analyse({
    files: [{ path: "backend/src/engine.ts", code: `const x = 1;` }],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared({ exempt: { toolPolicy: { defect: "no interpreter ships", issue: 244 } } })],
    scopes,
  });
  assert.deepEqual(ok, []);

  for (const bad of [{ defect: "no interpreter" }, { issue: 244 }, { defect: "  ", issue: 244 }, { defect: "x", issue: "244" }]) {
    const failures = analyse({
      files: [{ path: "backend/src/engine.ts", code: `const x = 1;` }],
      capabilities: [],
      eventTypes: [],
      declaredTypes: [declared({ exempt: { toolPolicy: bad } })],
      scopes,
    });
    assert.equal(failures.length, 1, `expected a failure for ${JSON.stringify(bad)}`);
    assert.match(failures[0], /exempt with no reason/);
  }
});

test("a field read from the reference host counts — the scope doctrine applies to fields too", () => {
  // `DefaultEngineDeps` hands the manifest to host callbacks, so a host interpreting `toolPolicy` in `buildTools`
  // is the intended design. Failing that would be the false alarm that gets a check deleted.
  const failures = analyse({
    files: [{ path: "examples/src/app.ts", code: `const t = manifest.toolPolicy.excluded;` }],
    capabilities: [],
    eventTypes: [],
    declaredTypes: [declared({ scope: "definition" })],
    scopes: { ...scopes, definition: ["backend/src", "examples/src"] },
  });
  assert.deepEqual(failures, []);
});
