/**
 * Reading configuration out of the environment, where a blank value means *unset*.
 *
 * ## The bug this exists because of
 *
 * `docker-compose.oracle.yml` passes optional variables through as `RETINUE_MODEL_ID=${RETINUE_MODEL_ID:-}`,
 * which is the normal way to make a variable optional in compose — and it arrives in the container as the
 * **empty string**, not as unset. So this:
 *
 * ```ts
 * const modelId = env["RETINUE_MODEL_ID"] ?? DEFAULT_MODEL_IDS[provider] ?? "gpt-4o";
 * ```
 *
 * resolved to `""`, because `??` falls through on `undefined` and `null` and not on `""`. Every model call
 * on the deployed backend went to Google with an empty model name and came back **404 Not Found**, and the
 * only hint anywhere was one boot line: `no pricing for ""`.
 *
 * Nothing caught it. The value typechecks, the deployment looks configured, the health checks pass — the
 * failure arrives inside the first generation, as a provider error that names nothing. Found by calling a
 * tool on the live backend and reading the reply, which is the only place it was visible.
 *
 * `required()` in `main.ts` had this right (`value === undefined || value === ""`) one layer up. The
 * optional reads did not, so they all go through here now.
 */

/** The value, or `undefined` when it is absent **or blank**. Trimmed, since ` ` is not a configuration. */
export const optionalEnv = (
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/**
 * A number, or the fallback when the variable is absent, blank or not a number.
 *
 * `Number("")` is **0**, so `Number(process.env["PORT"] ?? 4000)` binds port 0 — a random free port — for a
 * deployment that passed `PORT=` through. The same defect as the model id, with a symptom that looks like a
 * networking problem rather than a configuration one.
 */
export const optionalNumberEnv = (
  name: string,
  fallback: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number => {
  const raw = optionalEnv(name, env);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};
