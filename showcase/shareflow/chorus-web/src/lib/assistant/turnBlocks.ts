/**
 * What a message points at and carries — #548 (`@` references) and #549 (attachments).
 *
 * Both travel **inside the message text**, as blocks the agent reads and the user's bubble hides:
 *
 *   [referenced]
 *   chorus:post/<uuid> Team post
 *   chorus:project-asset/<uuid> Logo
 *   [/referenced]
 *
 *   [attached-media]
 *   <workspace-id>/<uuid>.png
 *   [/attached-media]
 *
 * In the text rather than beside it because the conversation's history is text: a reference that lived
 * only on the request would be gone by the next turn, and "that post" two messages later would mean
 * nothing. The blocks are appended **server-side** (`/api/assistant/agentkit/turns`) after every id and
 * path is checked against the caller's workspace, so a client cannot smuggle another workspace's file in.
 *
 * shareflow's `turn-settings.ts` is the only reader; the formats are asserted to agree in both repos'
 * tests (`turnBlocks.test.ts`, `turn-settings.test.ts`).
 */

export type TurnReference = { readonly kind: 'post' | 'project_asset'; readonly id: string; readonly label: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_REFERENCES = 6;

/** A label on one line, bounded — it is shown to the agent and to the person. */
const oneLine = (label: string): string => label.replace(/\s+/g, ' ').trim().slice(0, 120);

export const referencedBlock = (references: readonly TurnReference[]): string => {
  const lines = references
    .filter((r) => UUID.test(r.id))
    .slice(0, MAX_REFERENCES)
    .map((r) => `chorus:${r.kind === 'post' ? 'post' : 'project-asset'}/${r.id.toLowerCase()} ${oneLine(r.label)}`.trimEnd());
  return lines.length === 0 ? '' : ['[referenced]', ...lines, '[/referenced]'].join('\n');
};

export const attachedBlock = (paths: readonly string[]): string =>
  paths.length === 0 ? '' : ['[attached-media]', ...paths, '[/attached-media]'].join('\n');

/** The message with its blocks appended — the order the agent reads them in. */
export const withBlocks = (text: string, references: readonly TurnReference[], paths: readonly string[]): string =>
  [text.trim(), referencedBlock(references), attachedBlock(paths)].filter((part) => part !== '').join('\n\n');

const block = (name: string) => new RegExp(`\\n*\\[${name}\\]\\n([\\s\\S]*?)\\n\\[/${name}\\]`, 'g');

/**
 * The message as the person wrote it, and what its blocks held — for the user's bubble, which shows the
 * references as chips and the attachments as thumbnails rather than as raw lines.
 */
export const splitBlocks = (message: string): { text: string; references: TurnReference[]; attachments: string[] } => {
  const references: TurnReference[] = [];
  const attachments: string[] = [];
  let text = message.replace(block('referenced'), (_all, body: string) => {
    for (const line of body.split('\n')) {
      const m = /^chorus:(post|project-asset)\/(\S+)\s*(.*)$/.exec(line.trim());
      if (m !== null && UUID.test(m[2]!)) references.push({ kind: m[1] === 'post' ? 'post' : 'project_asset', id: m[2]!.toLowerCase(), label: (m[3] ?? '').trim() });
    }
    return '';
  });
  text = text.replace(block('attached-media'), (_all, body: string) => {
    for (const line of body.split('\n')) if (line.trim() !== '') attachments.push(line.trim());
    return '';
  });
  return { text: text.trim(), references, attachments };
};

/** A reference as the client sends it, checked for shape only; ownership is the route's job. */
export const parseReferences = (raw: unknown): TurnReference[] => {
  if (!Array.isArray(raw)) return [];
  const out: TurnReference[] = [];
  for (const item of raw) {
    const r = item as { kind?: unknown; id?: unknown; label?: unknown } | null;
    if (r === null || typeof r !== 'object') continue;
    if ((r.kind !== 'post' && r.kind !== 'project_asset') || typeof r.id !== 'string' || !UUID.test(r.id)) continue;
    if (out.some((existing) => existing.id === r.id)) continue;
    out.push({ kind: r.kind, id: r.id.toLowerCase(), label: typeof r.label === 'string' ? oneLine(r.label) : '' });
    if (out.length === MAX_REFERENCES) break;
  }
  return out;
};
