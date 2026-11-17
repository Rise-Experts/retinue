/**
 * Blank environment variables, and the deployed backend that could not generate anything.
 *
 * WHY THIS FILE EXISTS: `docker-compose.oracle.yml` passes optional variables through as
 * `RETINUE_MODEL_ID=${RETINUE_MODEL_ID:-}` — the normal compose idiom for "optional" — and they arrive in
 * the container as the **empty string**. `env["RETINUE_MODEL_ID"] ?? DEFAULT_MODEL_IDS[provider]` does not
 * fall through on `""`, so the resolved model id was `""`, every generation went to Google with an empty
 * model name, and the reply was `404 Not Found`.
 *
 * Nothing caught it: the value typechecks, `/healthz` and `/readyz` answer 200, the container reports
 * healthy with zero restarts, and the single clue was one boot line reading `no pricing for ""`. It was
 * found by calling `suggest_campaign_ideas` on the live backend and reading the error.
 *
 * `modelSelectionFrom` had no tests at all, which is the other half of the reason it shipped.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { optionalEnv, optionalNumberEnv } from "../env.js";
import { DEFAULT_MODEL_IDS, modelSelectionFrom } from "../model.js";
import { shareFlowManifest } from "../compose.js";

describe("optionalEnv", () => {
  it("treats blank as absent, which is what compose actually sends", () => {
    expect(optionalEnv("X", { X: "" })).toBeUndefined();
    expect(optionalEnv("X", { X: "   " })).toBeUndefined();
    expect(optionalEnv("X", {})).toBeUndefined();
  });

  it("trims, so a trailing newline from a secrets file is not part of the value", () => {
    // A value pasted into a `.env` or read from a mounted file arrives with whitespace more often than not.
    expect(optionalEnv("X", { X: " gemini-2.5-flash\n" })).toBe("gemini-2.5-flash");
  });
});

describe("optionalNumberEnv", () => {
  it("does not turn a blank into zero", () => {
    /**
     * `Number("")` is `0`, and `Number(process.env["PORT"] ?? 4000)` therefore binds **port 0** — a random
     * free port — for a deployment that passed `PORT=` through. The symptom looks like a networking fault
     * rather than a configuration one, which is what makes it expensive.
     */
    expect(optionalNumberEnv("PORT", 4000, { PORT: "" })).toBe(4000);
    expect(optionalNumberEnv("PORT", 4000, {})).toBe(4000);
  });

  it("falls back rather than propagating NaN", () => {
    expect(optionalNumberEnv("PORT", 4000, { PORT: "not-a-port" })).toBe(4000);
    expect(optionalNumberEnv("PORT", 4000, { PORT: "8080" })).toBe(8080);
  });
});

describe("modelSelectionFrom", () => {
  const base = { RETINUE_MODEL_API_KEY: "k" };

  it("defaults the model id when compose sent a blank one — the live failure", async () => {
    /**
     * The exact deployed environment: provider `google`, a key set, and `RETINUE_MODEL_ID=`. This
     * returned `""` before the fix.
     */
    const selection = await modelSelectionFrom({ ...base, RETINUE_MODEL_PROVIDER: "google", RETINUE_MODEL_ID: "" });
    expect(selection.modelId).toBe(DEFAULT_MODEL_IDS["google"]);
    expect(selection.modelId).not.toBe("");
  });

  it("still lets a deployment name its own model", async () => {
    // The defaults exist so the common case needs no extra variable, not to override a choice.
    const selection = await modelSelectionFrom({
      ...base,
      RETINUE_MODEL_PROVIDER: "google",
      RETINUE_MODEL_ID: "gemini-2.5-pro",
    });
    expect(selection.modelId).toBe("gemini-2.5-pro");
  });

  it("refuses a blank provider rather than defaulting it, unlike the model id", async () => {
    /**
     * The asymmetry is deliberate, and the first version of this fix got it wrong: `optionalEnv` was
     * applied to both variables, and `module.test.ts` — which already asserted that a blank provider is
     * refused — caught it.
     *
     * An absent model id has a safe provider-specific default. An absent provider does not, because the
     * key is already set and keys are provider-specific: defaulting to `openai` sends a Google key to
     * OpenAI, exactly the hazard `docker-compose.oracle.yml` warns about, and it surfaces inside the
     * first model call rather than at boot.
     */
    await expect(modelSelectionFrom({ ...base, RETINUE_MODEL_PROVIDER: "" })).rejects.toThrow(
      /RETINUE_MODEL_PROVIDER must be one of/,
    );
  });

  it("defaults the provider only when the variable is genuinely absent", async () => {
    // Absent is not blank. `openai` is the documented default and the error message above says so.
    const selection = await modelSelectionFrom({ ...base });
    expect(selection.provider).toBe("openai");
    expect(selection.modelId).toBe(DEFAULT_MODEL_IDS["openai"]);
  });

  it("refuses a blank api key, which it always did", async () => {
    // The one read that had it right. Kept under test so the fix above cannot regress it by symmetry.
    await expect(modelSelectionFrom({ RETINUE_MODEL_API_KEY: "" })).rejects.toThrow(/RETINUE_MODEL_API_KEY is required/);
  });

  it("names the valid providers when one is wrong", async () => {
    await expect(modelSelectionFrom({ ...base, RETINUE_MODEL_PROVIDER: "gogle" })).rejects.toThrow(/got "gogle"/);
  });
});

describe("the manifest's model policy", () => {
  /**
   * Found while writing the test above, and a different defect in the same neighbourhood.
   *
   * The manifest read the same variable — `modelPolicy: { modelId: env ?? "gpt-4o" }` — behind an
   * `as unknown as` cast, and the cast hid two things at once: `ModelPolicy` has **no `modelId` field**,
   * and its one required field, `role`, was absent. The platform says why in its own comment: *"Agents
   * never name a model, so re-pointing a role here changes no agent code."*
   */
  it("names a role, which is the only thing a ModelPolicy requires", () => {
    expect(shareFlowManifest().modelPolicy.role).toBe("smart");
  });

  it("does not name a model, and does not read the environment to do it", () => {
    /**
     * Inert today: this app always passes its own `resolveModel`, and the platform only falls back to
     * `registry.resolve(manifest.modelPolicy)` when nothing supplies one. Inert is not harmless — the day
     * a path forgets `resolveModel`, that fallback resolves whatever is here.
     */
    const before = process.env["RETINUE_MODEL_ID"];
    process.env["RETINUE_MODEL_ID"] = "";
    try {
      const policy = shareFlowManifest().modelPolicy as Record<string, unknown>;
      expect(policy["modelId"], "a model id here is a field the platform does not read").toBeUndefined();
    } finally {
      if (before === undefined) delete process.env["RETINUE_MODEL_ID"];
      else process.env["RETINUE_MODEL_ID"] = before;
    }
  });

  it("is where the concrete model is *not* chosen — that is resolveModelForTurn", async () => {
    // The pair of assertions that keeps the split honest: the policy names a role, the resolver names a
    // model, and the model id comes from the environment in exactly one place.
    const selection = await modelSelectionFrom({ RETINUE_MODEL_API_KEY: "k", RETINUE_MODEL_PROVIDER: "google" });
    expect(selection.modelId).toBe(DEFAULT_MODEL_IDS["google"]);
  });
});

describe("every optional environment read goes through the helper", () => {
  it("leaves no `env[\"NAME\"] ?? fallback` behind", () => {
    /**
     * The guard that stops a fifth site reintroducing this. A scan, because the defect is a *pattern* at
     * a call site: any new `process.env["X"] ?? y` is correct-looking, typechecks, and is wrong for
     * exactly the reason this file documents.
     *
     * `required()` in main.ts is not matched and does not need to be — it checks `=== ""` itself.
     */
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && name !== "env.ts")) {
      const text = readFileSync(resolve(dir, file), "utf8");
      for (const [line, index] of text.split("\n").map((l, i) => [l, i] as const)) {
        /**
         * Comments are skipped, and they had to be: the very comment in compose.ts *quoting* the old
         * line was the scan's first hit. Documenting a defect must not read as committing it.
         */
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
        /**
         * One deliberate exception, named rather than pattern-excused: `RETINUE_MODEL_PROVIDER` must
         * refuse a blank value rather than default it — see the test above for why the two variables
         * differ. Listing it here means a *second* exception has to be argued for too.
         */
        if (line.includes('env["RETINUE_MODEL_PROVIDER"]')) continue;
        // A literal-named env read followed by a fallback, in either access style.
        if (/(?:process\.)?env\[\s*"[A-Z_0-9]+"\s*\]\s*\?\?/.test(line) || /process\.env\.[A-Z_0-9]+\s*\?\?/.test(line)) {
          offenders.push(`${file}:${index + 1} ${trimmed}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds the files it is scanning, so an empty scan cannot pass", () => {
    // The guard on the guard: a moved directory would otherwise read as "no offenders".
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files).toContain("model.ts");
    expect(files).toContain("main.ts");
    expect(files).toContain("compose.ts");
  });
});
