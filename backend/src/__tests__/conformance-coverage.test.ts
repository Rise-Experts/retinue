/**
 * The coverage guard for the conformance suite (#91).
 *
 * The original suite verified 1 port of 19 while its acceptance criterion read "passes the full
 * conformance suite" — so #20 could close green with a single table implemented. Widening the suite
 * fixes that once; this test is what stops it happening again, by making an unclassified or
 * newly-methodful port a build failure rather than a silent omission.
 *
 * TypeScript interfaces do not exist at runtime, so the guard reads the port sources directly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_COVERAGE,
  DEFERRED_INFRASTRUCTURE_PORTS,
  HARNESS_MODULES,
  ISOLATION_EXEMPT_PORTS,
  MATRIX_ADAPTERS,
  NON_STORAGE_PORTS,
  PLACEHOLDER_PORTS,
  REGISTERED_PORTS,
  SCANNED_PORT_MODULES,
} from "../testing/conformance/index.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type FoundPort = { readonly name: string; readonly hasMethods: boolean; readonly module: string };

/** Strip comments so a method signature mentioned in prose is never mistaken for a real one. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/**
 * Extract each `export interface X { … }` and whether its body declares anything. Brace-counting
 * rather than a greedy regex, so a nested object type inside a method signature does not truncate
 * the body early.
 */
const findPorts = (relativePath: string): readonly FoundPort[] => {
  const source = stripComments(readFileSync(resolve(PACKAGE_ROOT, relativePath), "utf8"));
  const found: FoundPort[] = [];
  const header = /export interface (\w+)[^{]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(source)) !== null) {
    const name = match[1]!;
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
      i += 1;
    }
    const body = source.slice(start, i - 1).trim();
    found.push({ name, hasMethods: body.length > 0, module: relativePath });
  }
  return found;
};

const ALL_PORTS: readonly FoundPort[] = SCANNED_PORT_MODULES.flatMap(findPorts);
const registered = new Set(REGISTERED_PORTS.map((p) => p.port));
const placeholders = new Set(PLACEHOLDER_PORTS);
const deferred = new Set(DEFERRED_INFRASTRUCTURE_PORTS);
const nonStorage = new Set(NON_STORAGE_PORTS);

describe("conformance coverage guard", () => {
  it("finds the port interfaces at all — the guard is not vacuously passing", () => {
    // If the scan silently found nothing, every assertion below would pass while verifying nothing.
    expect(ALL_PORTS.length).toBeGreaterThanOrEqual(20);
    expect(ALL_PORTS.map((p) => p.name)).toContain("ConversationStore");
  });

  it("classifies every exported port interface exactly once", () => {
    const unclassified = ALL_PORTS.filter(
      (p) =>
        !registered.has(p.name) &&
        !placeholders.has(p.name) &&
        !deferred.has(p.name) &&
        !nonStorage.has(p.name),
    );
    expect(
      unclassified.map((p) => `${p.name} (${p.module})`),
      "A new port must be classified in src/testing/conformance/index.ts: add a harness to " +
        "REGISTERED_PORTS, or justify it in PLACEHOLDER_PORTS / DEFERRED_INFRASTRUCTURE_PORTS / " +
        "NON_STORAGE_PORTS.",
    ).toEqual([]);

    for (const port of ALL_PORTS) {
      const buckets = [registered, placeholders, deferred, nonStorage].filter((b) => b.has(port.name));
      expect(buckets.length, `${port.name} is classified in ${buckets.length} lists, expected 1`).toBe(1);
    }
  });

  it("fails when a placeholder port gains methods without a harness", () => {
    const grown = ALL_PORTS.filter((p) => placeholders.has(p.name) && p.hasMethods);
    expect(
      grown.map((p) => p.name),
      "These ports now declare methods, so they need a conformance harness and a move from " +
        "PLACEHOLDER_PORTS to REGISTERED_PORTS.",
    ).toEqual([]);
  });

  it("every registered port actually exists and declares methods", () => {
    const byName = new Map(ALL_PORTS.map((p) => [p.name, p]));
    for (const { port } of REGISTERED_PORTS) {
      const found = byName.get(port);
      expect(found, `${port} is registered but was not found in the scanned modules`).toBeDefined();
      expect(found?.hasMethods, `${port} is registered but declares no methods`).toBe(true);
    }
  });

  it("registers a distinct harness per port", () => {
    const harnesses = REGISTERED_PORTS.map((p) => p.harness);
    expect(new Set(harnesses).size).toBe(harnesses.length);
    expect(new Set(REGISTERED_PORTS.map((p) => p.port)).size).toBe(REGISTERED_PORTS.length);
  });
});

/**
 * The isolation guard. The `AgentStore` leak #91 surfaced was invisible to the type system: the
 * method accepted `TenantScope` and destructured only `{ agentId, version }`. Nothing but an
 * explicit cross-tenant assertion catches that, so every tenant-scoped harness must carry one and
 * this test fails if one loses it.
 */
describe("conformance isolation guard", () => {
  /** Harness bodies, split out of the harness sources by `export function XConformance`. */
  const harnessBodies = (): ReadonlyMap<string, string> => {
    const bodies = new Map<string, string>();
    for (const file of HARNESS_MODULES) {
      const source = readFileSync(resolve(PACKAGE_ROOT, file), "utf8");
      const parts = source.split(/\nexport function (\w+Conformance)/);
      for (let i = 1; i < parts.length; i += 2) bodies.set(parts[i]!, parts[i + 1] ?? "");
    }
    return bodies;
  };

  const exempt = new Set(ISOLATION_EXEMPT_PORTS.map((e) => e.port));

  it("locates every registered harness in the sources — not vacuously passing", () => {
    const bodies = harnessBodies();
    const missing = REGISTERED_PORTS.filter((p) => !bodies.has(p.harness)).map((p) => p.harness);
    expect(missing, "harness named in REGISTERED_PORTS but not found in HARNESS_MODULES").toEqual([]);
  });

  it("every tenant-scoped harness asserts a cross-tenant read returns nothing", () => {
    const bodies = harnessBodies();
    const withoutIsolation = REGISTERED_PORTS.filter(({ port, harness }) => {
      if (exempt.has(port)) return false;
      const body = bodies.get(harness) ?? "";
      // A second tenant (T2/t2) or second principal must appear in an assertion. Case-sensitive on
      // purpose: the moved conversation-store harness uses `t2`, the newer ones use `T2`.
      return !/\b[Tt]2\b/.test(body) && !/\bP2\b/.test(body);
    });
    expect(
      withoutIsolation.map((p) => `${p.port} (${p.harness})`),
      "Each of these harnesses must assert that a read in another tenant's context returns " +
        "nothing — or be given a reasoned entry in ISOLATION_EXEMPT_PORTS. See the AgentStore " +
        "leak #91 found: TenantScope on the signature does not mean the adapter honours it.",
    ).toEqual([]);
  });

  /**
   * The matrix keys each cell off the describe title, so the `${Port} conformance` convention is
   * load-bearing rather than cosmetic. Guarded here: a renamed describe would silently drop that
   * port's row from the published matrix, which would read as "not covered" instead of failing.
   */
  it("names every harness describe block `<Port> conformance`, which the matrix keys on", () => {
    const bodies = harnessBodies();
    const wrong: string[] = [];
    for (const { port, harness } of REGISTERED_PORTS) {
      const body = bodies.get(harness) ?? "";
      if (!body.includes(`describe("${port} conformance"`)) wrong.push(`${port} (${harness})`);
    }
    expect(
      wrong,
      'Each harness must open with describe("<Port> conformance", …) — scripts/conformance-matrix.mjs ' +
        "maps that title back to the port to build the adapter × port table.",
    ).toEqual([]);
  });

  it("keeps the exemption list honest — every exempt port is actually registered", () => {
    const registeredNames = new Set(REGISTERED_PORTS.map((p) => p.port));
    for (const { port, reason } of ISOLATION_EXEMPT_PORTS) {
      expect(registeredNames.has(port), `${port} is exempt but not a registered port`).toBe(true);
      expect(reason.length, `${port}'s exemption needs a stated reason`).toBeGreaterThan(20);
    }
  });
});

/**
 * The adapter-coverage guard — AC-3 of #92, in its amended form.
 *
 * Every adapter must account for every registered port: either it implements it, or it declares the
 * gap against the SPEC that will close it. A registered port missing from both lists is an
 * unclassified absence and fails the build. That is the difference between "we know this is not done
 * yet" and "we forgot", which is precisely the distinction #20 lacked when it closed green.
 */
describe("adapter coverage guard", () => {
  const allPorts = REGISTERED_PORTS.map((p) => p.port);

  it("covers every adapter the matrix reports on", () => {
    expect(ADAPTER_COVERAGE.map((a) => a.adapter).sort()).toEqual([...MATRIX_ADAPTERS].sort());
  });

  it("every adapter accounts for every registered port — no unclassified absence", () => {
    for (const { adapter, implemented, notImplemented, notApplicable } of ADAPTER_COVERAGE) {
      const accounted = new Set([
        ...implemented,
        ...notImplemented.map((n) => n.port),
        ...(notApplicable ?? []).map((n) => n.port),
      ]);
      const unaccounted = allPorts.filter((p) => !accounted.has(p));
      expect(
        unaccounted,
        `Adapter "${adapter}" neither implements nor declares a gap for these ports. Add them to ` +
          `ADAPTER_COVERAGE — as implemented (and wire the harness into its test entrypoint), as ` +
          `notImplemented with the issue that will add them, or as notApplicable with the reason it ` +
          `never will.`,
      ).toEqual([]);
    }
  });

  it("gives every not-applicable exemption a real reason", () => {
    // A third answer is only useful if it has to be argued for. "n/a" with no reason is the silent gap the
    // other two categories exist to prevent, wearing a different label.
    for (const { adapter, notApplicable } of ADAPTER_COVERAGE) {
      for (const entry of notApplicable ?? []) {
        expect(
          entry.reason.length,
          `Adapter "${adapter}" exempts ${entry.port} without explaining why it never applies`,
        ).toBeGreaterThan(80);
      }
    }
  });

  it("never claims a port is both pending and inapplicable", () => {
    // They are contradictory claims: one says an issue will add it, the other says nothing ever will.
    for (const { adapter, notImplemented, notApplicable } of ADAPTER_COVERAGE) {
      const both = (notApplicable ?? []).filter((n) => notImplemented.some((p) => p.port === n.port));
      expect(both.map((b) => b.port), `Adapter "${adapter}" lists these as both pending and inapplicable`).toEqual(
        [],
      );
    }
  });

  it("never claims a port both ways", () => {
    for (const { adapter, implemented, notImplemented, notApplicable } of ADAPTER_COVERAGE) {
      const both = implemented.filter(
        (p) => notImplemented.some((n) => n.port === p) || (notApplicable ?? []).some((n) => n.port === p),
      );
      expect(both, `Adapter "${adapter}" lists these ports as both implemented and not`).toEqual([]);
    }
  });

  it("never references a port that is not registered", () => {
    const known = new Set(allPorts);
    for (const { adapter, implemented, notImplemented } of ADAPTER_COVERAGE) {
      const unknown = [...implemented, ...notImplemented.map((n) => n.port)].filter((p) => !known.has(p));
      expect(unknown, `Adapter "${adapter}" references ports that are not in REGISTERED_PORTS`).toEqual([]);
    }
  });

  it("tracks every gap to a plausible issue reference", () => {
    for (const { adapter, notImplemented } of ADAPTER_COVERAGE) {
      for (const { port, trackedBy } of notImplemented) {
        expect(
          trackedBy,
          `${adapter}/${port} needs a tracking issue like "#93", so the gap is followable`,
        ).toMatch(/^#\d+$/);
      }
    }
  });

  /**
   * Emits the registry for `scripts/conformance-matrix.mjs`. A test writing a file is deliberate:
   * `src/testing/**` is excluded from the build (correctly — the harness must not ship), so the
   * matrix script cannot import the registry from `dist`. Re-deriving it by parsing the TypeScript
   * would give the matrix a second, drifting source of truth. Emitting it here keeps exactly one.
   */
  it("emits the registry the matrix generator consumes", () => {
    const out = resolve(PACKAGE_ROOT, ".conformance");
    mkdirSync(out, { recursive: true });
    const payload = {
      ports: REGISTERED_PORTS,
      adapters: ADAPTER_COVERAGE,
      isolationExempt: ISOLATION_EXEMPT_PORTS,
      placeholders: PLACEHOLDER_PORTS,
      deferredInfrastructure: DEFERRED_INFRASTRUCTURE_PORTS,
    };
    writeFileSync(resolve(out, "registry.json"), `${JSON.stringify(payload, null, 2)}\n`);
    expect(existsSync(resolve(out, "registry.json"))).toBe(true);
  });

  it("keeps the memory adapter as the complete reference implementation", () => {
    const memory = ADAPTER_COVERAGE.find((a) => a.adapter === "memory");
    expect(memory).toBeDefined();
    // If the reference adapter ever stops implementing everything, the matrix loses its baseline
    // and "identical behaviour across adapters" becomes unmeasurable.
    expect(memory?.notImplemented).toEqual([]);
    expect([...(memory?.implemented ?? [])].sort()).toEqual([...allPorts].sort());
  });
});
