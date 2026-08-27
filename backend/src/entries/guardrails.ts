/**
 * `@retinue/agentkit/guardrails` — checks a deployment adds, and the contract they satisfy.
 *
 * Its own subpath rather than part of `./hitl`, though both stop a run. The distinction is who decides: a
 * guardrail is an automated inspection whose verdict is final, and HITL is a person being asked. Putting them
 * together would invite a host to treat a refusal as something a human could override, which is precisely what a
 * guardrail must not be.
 *
 * Nothing here imports a provider or a store, so declaring the capability costs a consumer no dependency.
 */
export * from "../guardrails/index.js";
