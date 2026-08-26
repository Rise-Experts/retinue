/**
 * Injection tokens — REQ-044 (#201).
 *
 * Symbols rather than strings, so two modules cannot collide on a token by choosing the same name, and rather
 * than classes, because everything the platform provides is a structural type built by a factory. There is no
 * `PostgresRunStore` class to inject; there is a `RunStore` that some adapter returns.
 */

export const RETINUE_CONFIG = Symbol("RETINUE_CONFIG");
export const RETINUE_SQL = Symbol("RETINUE_SQL");
export const RETINUE_POOL = Symbol("RETINUE_POOL");
export const RETINUE_REDIS = Symbol("RETINUE_REDIS");
export const RETINUE_STORES = Symbol("RETINUE_STORES");
export const RETINUE_ENGINE = Symbol("RETINUE_ENGINE");
export const RETINUE_REGISTRY = Symbol("RETINUE_REGISTRY");
export const RETINUE_RESOLVER_DEPS = Symbol("RETINUE_RESOLVER_DEPS");
export const RETINUE_PROBES = Symbol("RETINUE_PROBES");
export const RETINUE_MESSAGES = Symbol("RETINUE_MESSAGES");
export const RETINUE_AGENT = Symbol("RETINUE_AGENT");

/**
 * How a request becomes an `ExecutionContext`.
 *
 * **No default, deliberately** — the same rule as `RetinueApp.authenticate`. A permissive fallback would serve
 * an open API to anyone who forgot to provide one, and a service that refuses to start is a much better failure
 * than one that starts and trusts everybody. `RetinueModule.forRoot` requires it, so "forgot to provide one" is
 * a type error rather than a security incident.
 */
export const RETINUE_AUTHENTICATE = Symbol("RETINUE_AUTHENTICATE");
