import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@retinue/agentkit";
import { createProjectContextProvider, projectSectionBody, shareFlowBaseContextProviders } from "../providers.js";
import { createPostgresProjectService } from "../../adapters/postgres/projects.js";
import { withProjectBrief } from "../../tools/project-brief.js";

/** #522 — the Assistant follows the conversation's project. */
const context = { tenantId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", principalId: "9b2d1a4e-1111-4222-8333-944455556666", conversationId: "CONV-1" } as unknown as ExecutionContext;
const PROJECT = {
  id: "p1",
  name: "Posting about AI",
  instructions: "Audience: founders. Tone: plain, no hype. Always end with one question.",
  defaults: { channels: ["linkedin"], hashtags: "#AI #Startups", cta: "Follow for more" },
};

describe("the project section", () => {
  it("carries the instructions and the defaults, and says to follow them", async () => {
    const provider = createProjectContextProvider({ projects: { current: async () => PROJECT } } as never);
    const [section] = (await provider.provide(context)) as unknown as { title: string; body: string }[];
    expect(section!.title).toBe("Project: Posting about AI");
    expect(section!.body).toContain('This conversation is in the project "Posting about AI". Its instructions below are the person\'s own and take precedence over the workspace defaults');
    expect(section!.body).toContain("Always end with one question.");
    expect(section!.body).toContain("Default channels: linkedin.");
    expect(section!.body).toContain("Hashtags to use: #AI #Startups");
    expect(section!.body).toContain("Call to action: Follow for more");
  });

  it("adds nothing outside a project", async () => {
    const provider = createProjectContextProvider({ projects: { current: async () => null } } as never);
    expect(await provider.provide(context)).toEqual([]);
  });

  it("is assembled on every turn, after the claim policy and before the brand", () => {
    const ids = shareFlowBaseContextProviders({} as never).map((p) => p.id);
    expect(ids.indexOf("shareflow.project")).toBeGreaterThan(ids.indexOf("shareflow.claims"));
    expect(ids.indexOf("shareflow.project")).toBeLessThan(ids.indexOf("shareflow.brand"));
  });
});

describe("the caption brief", () => {
  it("carries the project to the caption writer, which sees only its brief", () => {
    const brief = withProjectBrief("Why small AI features beat big launches", PROJECT);
    expect(brief.startsWith("Why small AI features beat big launches\n\n")).toBe(true);
    expect(brief).toContain("Always end with one question.");
  });

  it("is unchanged outside a project, or for an empty one", () => {
    expect(withProjectBrief("Hello", null)).toBe("Hello");
    expect(withProjectBrief("Hello", { ...PROJECT, instructions: " ", defaults: {} })).toBe("Hello");
  });

  it("stays readable with no instructions but some defaults", () => {
    expect(projectSectionBody({ ...PROJECT, instructions: "" })).toContain("Hashtags to use: #AI #Startups");
  });
});

describe("which project a conversation is in", () => {
  it("is read by workspace, conversation and — for a personal project — owner", async () => {
    const seen: { text: string; params: readonly unknown[] }[] = [];
    const service = createPostgresProjectService({
      sql: {
        async query<Row>(text: string, params: readonly unknown[] = []): Promise<Row[]> {
          seen.push({ text, params });
          // #554: the project's memories are a second read; none here.
          if (text.includes("project_memories")) return [] as Row[];
          return [{ id: "p1", name: "Posting about AI", instructions: "x", defaults: { channels: ["linkedin", 7], hashtags: " " } }] as Row[];
        },
      } as never,
    });
    const project = await service.current(context);
    expect(seen[0]!.params).toEqual([String(context.tenantId), "conv-1", String(context.principalId)]);
    expect(seen[0]!.text).toContain("(p.owner_id is null or p.owner_id::text = $3)");
    expect(project).toEqual({ id: "p1", name: "Posting about AI", instructions: "x", defaults: { channels: ["linkedin"] } });
  });

  it("is none for a turn outside a conversation", async () => {
    const service = createPostgresProjectService({ sql: { async query() { throw new Error("should not query"); } } as never });
    expect(await service.current({ tenantId: "t", principalId: "u" } as unknown as ExecutionContext)).toBeNull();
  });
});
