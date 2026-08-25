/**
 * Health and readiness probes (#110).
 *
 * `/healthz` and `/readyz` answer different questions, and conflating them is the mistake this file
 * exists to avoid.
 *
 * **`/healthz` — is this process alive?** It must succeed while the database is down. An orchestrator
 * that restarts a process because a *dependency* is unavailable turns a brief database blip into a
 * restart storm, and the restarted process is no more able to reach the database than the one it
 * replaced.
 *
 * **`/readyz` — should traffic come here?** Dependencies reachable, schema at the expected version.
 * Not-ready is a **503**, because a load balancer keys off the status code, not the body — a 200 with
 * `{"ready": false}` is a page nobody gets.
 */

/** One dependency check. Failing is expected and normal; throwing is treated as failing. */
export type Probe = {
  readonly name: string;
  readonly check: () => Promise<void> | void;
};

export type ProbeResult = {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string;
};

export type HealthRoutesOptions = {
  readonly probes: readonly Probe[];
  /** Reported in the payload so an operator can tell which build answered. */
  readonly version?: string;
  readonly healthPath?: string;
  readonly readyPath?: string;
};

export const createHealthRoutes = (options: HealthRoutesOptions) => {
  const healthPath = options.healthPath ?? "/healthz";
  const readyPath = options.readyPath ?? "/readyz";

  const runProbes = async (): Promise<readonly ProbeResult[]> =>
    // All probes run, always — a 503 that names only the first failure sends an operator round the
    // loop once per broken dependency.
    Promise.all(
      options.probes.map(async (probe): Promise<ProbeResult> => {
        try {
          await probe.check();
          return { name: probe.name, ok: true };
        } catch (error) {
          return { name: probe.name, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );

  return {
    healthPath,
    readyPath,

    /** Liveness. Deliberately touches nothing external. */
    health(): Response {
      return Response.json(
        { status: "ok", ...(options.version === undefined ? {} : { version: options.version }) },
        { status: 200 },
      );
    },

    async ready(): Promise<Response> {
      const results = await runProbes();
      const ok = results.every((r) => r.ok);
      return Response.json(
        {
          status: ok ? "ready" : "not-ready",
          ...(options.version === undefined ? {} : { version: options.version }),
          probes: results,
        },
        // 503, not 200-with-a-flag: the load balancer reads the status.
        { status: ok ? 200 : 503 },
      );
    },

    /** Returns null when the path is not one of ours, so a host can compose this into its handler. */
    async handle(request: Request): Promise<Response | null> {
      const { pathname } = new URL(request.url);
      if (pathname === healthPath) return this.health();
      if (pathname === readyPath) return this.ready();
      return null;
    },
  };
};

export type HealthRoutes = ReturnType<typeof createHealthRoutes>;

/** `SELECT 1`. The cheapest question that distinguishes "reachable" from "resolves in DNS". */
export const postgresProbe = (sql: { query(text: string): Promise<unknown> }): Probe => ({
  name: "postgres",
  check: async () => {
    await sql.query("SELECT 1");
  },
});

export const redisProbe = (redis: { ping(): Promise<string> }): Probe => ({
  name: "redis",
  check: async () => {
    const reply = await redis.ping();
    if (reply !== "PONG") throw new Error(`unexpected PING reply: ${reply}`);
  },
});

/**
 * Schema version. Separate from the Postgres probe on purpose: "the database is unreachable" and "the
 * database is reachable but the schema is behind" need different operator responses, and a single
 * probe would report them identically.
 */
export const schemaProbe = (manager: {
  currentVersion(): Promise<number>;
  targetVersion(): number;
}): Probe => ({
  name: "schema",
  check: async () => {
    const current = await manager.currentVersion();
    const target = manager.targetVersion();
    if (current !== target) {
      throw new Error(`schema at version ${current}, expected ${target}`);
    }
  },
});
