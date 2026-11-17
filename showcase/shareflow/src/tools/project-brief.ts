import type { ActiveProject } from "../services/index.js";
import { projectSectionBody } from "../context/providers.js";

/**
 * A caption brief with the conversation's project added — #522.
 *
 * The chat model reads the project from its context section, but the caption writer is a separate
 * model call with only the brief it is handed, so the tools that write captions add the project here.
 * Outside a project, or for a project with nothing in it, the brief is unchanged.
 */
export const withProjectBrief = (brief: string, project: ActiveProject | null): string => {
  if (project === null) return brief;
  const empty =
    project.instructions.trim() === "" &&
    (project.defaults.channels ?? []).length === 0 &&
    project.defaults.hashtags === undefined &&
    project.defaults.cta === undefined &&
    project.avatar === undefined;
  return empty ? brief : `${brief}\n\n${projectSectionBody(project)}`;
};
