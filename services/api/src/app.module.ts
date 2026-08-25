/**
 * The application — REQ-044 (#201).
 *
 * Three modules and one controller. Everything the platform does arrives through `RetinueModule`; everything
 * this service does is deciding *which* authenticator and *which* roles, which is the whole of what an
 * application is supposed to decide.
 */

import { Module } from "@nestjs/common";
import { RetinueModule } from "./retinue/retinue.module.js";
import { RetinueGraphQLModule } from "./graphql/graphql.module.js";
import { HealthController } from "./health/health.controller.js";
import { MessagesController } from "./messages/messages.controller.js";
import { createDevAuthenticate } from "./auth/dev-auth.js";
import { STANDARD_TOOL_NAMES } from "@retinue/agentkit/tools";
import type { Authenticate } from "@retinue/agentkit/server";

/**
 * Two roles, because one cannot demonstrate authorization at all.
 *
 * Tool grants are listed explicitly rather than spread from `STANDARD_TOOL_NAMES` wholesale for the writes: a
 * derived grant means upgrading the package widens what a model may do without anyone deciding to. The reads are
 * derived, and that is the deliberate asymmetry — a new *read* tool arriving is a smaller decision than a new
 * write, and the alternative is a list nobody maintains.
 */
const READ_TOOLS = STANDARD_TOOL_NAMES.filter((name) => name !== "http_write");
const WRITE_TOOLS = ["http_write"] as const;

export type AppModuleOptions = {
  readonly authenticate?: Authenticate;
};

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions = {}) {
    return {
      module: AppModule,
      imports: [
        RetinueModule.forRoot({
          // The service's own authenticator when it has one, and the dev one otherwise — which throws unless
          // somebody set the acknowledgement. There is no third branch where it starts and trusts everyone.
          authenticate: options.authenticate ?? createDevAuthenticate(),
          roles: [
            {
              roleId: "operator",
              permissions: [
                { action: "read", resourceType: "*" },
                { action: "write", resourceType: "*" },
                { action: "execute", resourceType: "tool" },
              ],
              tools: [...READ_TOOLS, ...WRITE_TOOLS],
            },
            {
              roleId: "viewer",
              permissions: [
                { action: "read", resourceType: "*" },
                { action: "execute", resourceType: "tool" },
              ],
              // No `http_write`: a viewer cannot *see* it in the catalogue, so the model never offers something
              // the person cannot do — better than a refusal after asking.
              tools: [...READ_TOOLS],
            },
          ],
        }),
        RetinueGraphQLModule,
      ],
      controllers: [HealthController, MessagesController],
    };
  }
}
