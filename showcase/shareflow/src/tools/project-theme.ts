import type { ExecutionContext } from "@retinue/agentkit";

import { projectTheme, type Theme } from "../design/theme.js";
import type { ProjectService } from "../services/index.js";

/**
 * The chat's project theme for a renderer — #595. Undefined outside a project, or when its kit sets
 * nothing a render could follow, and then every renderer draws exactly what it drew before.
 *
 * A render tool built without a project service (a partial wiring, a test stub) reads as outside one:
 * the theme dresses a render, it is never a reason for one to fail.
 */
export const themeForChat = async (projects: Pick<ProjectService, "current"> | undefined, context: ExecutionContext): Promise<Theme | undefined> => {
  if (projects === undefined) return undefined;
  const project = await projects.current(context);
  return projectTheme(project?.design);
};

/**
 * #615: the project's logo for a renderer, as a `data:` URL, with the corner it goes in — undefined outside a
 * project, without a logo, with the corner `none`, or when the file cannot be read. A logo dresses a render;
 * failing to read one is never a reason for the render to fail.
 */
export const logoForChat = async (
  projects: Pick<ProjectService, "logoReference"> | undefined,
  readImage: (reference: string) => Promise<{ readonly bytes: Uint8Array; readonly mime: string }>,
  context: ExecutionContext,
): Promise<string | undefined> => {
  if (projects?.logoReference === undefined) return undefined;
  try {
    const reference = await projects.logoReference(context);
    if (reference === undefined) return undefined;
    const image = await readImage(reference);
    // Only an image is a logo: a PDF or anything else named as one prints no logo, not a broken picture.
    if (!/^image\/(png|jpeg|webp|gif|svg\+xml)$/i.test(image.mime)) return undefined;
    return `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
  } catch {
    return undefined;
  }
};
