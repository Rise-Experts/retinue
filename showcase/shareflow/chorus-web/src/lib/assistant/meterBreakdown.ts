/**
 * The chat box meter's numbers — #552: what the context was made of, by source, with the conversation
 * (history and tools) as whatever the recorded sections do not account for. Pure, for testing.
 */
export type MeterData = {
  readonly used: number;
  readonly limit: number;
  readonly measured: boolean;
  readonly turnTokens: number;
  readonly steps: number;
  readonly credits: number;
  readonly creditsScope: "turn" | "conversation";
  /** #630: the model that answered, its full window, where older turns get condensed, and whether they are. */
  readonly modelId?: string;
  readonly window?: number;
  readonly compactAt?: number;
  readonly condensed?: boolean;
  /** Input tokens the provider served from its prompt cache this turn. */
  readonly cached?: number;
  /** #552: what the prompt was made of — from the agent service, when the turn recorded it. */
  readonly sections?: { readonly instructionsTokens: number; readonly sections: readonly { readonly providerId: string; readonly tokens: number }[] };
};

/** Which part of the meter's bar a context section belongs to. Anything unlisted is the brand's. */
const SOURCE_OF: Readonly<Record<string, "project" | "posts" | "brand" | "skills">> = {
  "shareflow.project": "project",
  "shareflow.turn": "posts",
  "skill-catalogue": "skills",
};
const sourceOf = (providerId: string) => SOURCE_OF[providerId] ?? (providerId.includes("skill") ? "skills" : "brand");

export function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}k`;
  return `${Math.round(tokens / 100_000) / 10}M`;
}

/** The context make-up in bar order, with the conversation (history and tools) as what is left. */
export const meterBreakdown = (meter: MeterData): { key: string; tokens: number }[] => {
  const groups = new Map<string, number>();
  for (const s of meter.sections?.sections ?? []) groups.set(sourceOf(s.providerId), (groups.get(sourceOf(s.providerId)) ?? 0) + s.tokens);
  const instructions = meter.sections?.instructionsTokens ?? 0;
  const known = instructions + [...groups.values()].reduce((a, b) => a + b, 0);
  const rest = Math.max(0, meter.used - known);
  return [
    { key: "chat", tokens: rest },
    { key: "instructions", tokens: instructions },
    { key: "project", tokens: groups.get("project") ?? 0 },
    { key: "posts", tokens: groups.get("posts") ?? 0 },
    { key: "brand", tokens: groups.get("brand") ?? 0 },
    { key: "skills", tokens: groups.get("skills") ?? 0 },
  ].filter((part) => part.tokens > 0);
};


/**
 * #657: the chat is close to the point where older turns are condensed — said before it happens, so a summary does
 * not come as a surprise. Three quarters of the way there, unless it already happened.
 */
export const nearCondense = (meter: Pick<MeterData, "used" | "compactAt" | "condensed">): boolean =>
  meter.compactAt !== undefined && meter.compactAt > 0 && meter.condensed !== true && meter.used >= meter.compactAt * 0.75;
