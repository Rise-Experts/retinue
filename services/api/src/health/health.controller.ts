/**
 * Probes — REQ-044 (#201).
 *
 * The platform's probes, not new ones. A service that wrote its own readiness check would eventually disagree
 * with the host about what "ready" means, and the disagreement would surface as traffic being routed to a
 * process that cannot serve it.
 *
 * The distinction the two paths encode is worth restating because it is easy to collapse:
 *
 * - `/healthz` — *is the process alive?* 200 **even while the database is down**. Restarting a process because a
 *   dependency is unavailable turns a blip into a restart storm, and a restarted process still cannot reach the
 *   database.
 * - `/readyz` — *should traffic come here?* 503 naming every failing probe, so the answer is actionable without
 *   opening a log.
 *
 * Both are served before authentication, because a load balancer carries no credentials.
 */

import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { RETINUE_PROBES } from "../retinue/tokens.js";

type Probe = { readonly name: string; check(): Promise<void> };

@Controller()
export class HealthController {
  constructor(@Inject(RETINUE_PROBES) private readonly probes: readonly Probe[]) {}

  @Get("healthz")
  liveness(): { status: string } {
    return { status: "ok" };
  }

  @Get("readyz")
  async readiness(@Res() response: Response): Promise<void> {
    // Every probe runs, even after one fails: an operator wants the whole picture, and "postgres is down" plus
    // "redis is down" is a different incident from either alone.
    const results = await Promise.all(
      this.probes.map(async (probe) => {
        try {
          await probe.check();
          return { name: probe.name, ok: true };
        } catch (error) {
          return { name: probe.name, ok: false, error: (error as Error).message };
        }
      }),
    );
    const ready = results.every((result) => result.ok);
    response.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not-ready", probes: results });
  }
}
