/**
 * A chat's agent mode, model and effort — #550, #551.
 *
 * Remembered per conversation (`assistant_conversation_settings`) and sent with every turn, where the
 * agent service reads them from the run (`shareflow/src/app/turn-settings.ts`). The same three values and
 * the same leniency on both sides: anything unknown is the default, never a refusal.
 */
export const AGENT_MODES = ['auto', 'ask_first', 'plan', 'chat_only'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * #575: the image/video settings, like Google Flow's. Per person rather than per chat (kept in this
 * browser), because a preferred shape and generator follow the person from chat to chat.
 */
export type MediaKind = 'image' | 'video';
export type MediaSettings = { readonly kind?: MediaKind; readonly aspectRatio?: string; readonly model?: string };
export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5'] as const;

export type ConversationSettings = { readonly mode: AgentMode; readonly effort: Effort; readonly model?: string; readonly media?: MediaSettings };

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = { mode: 'auto', effort: 'medium' };

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;

export const parseConversationSettings = (raw: unknown): ConversationSettings => {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const mode = (AGENT_MODES as readonly string[]).includes(String(o['mode'])) ? (o['mode'] as AgentMode) : DEFAULT_CONVERSATION_SETTINGS.mode;
  const effort = (EFFORTS as readonly string[]).includes(String(o['effort'])) ? (o['effort'] as Effort) : DEFAULT_CONVERSATION_SETTINGS.effort;
  const model = typeof o['model'] === 'string' && MODEL_ID.test(o['model']) ? o['model'] : undefined;
  const media = parseMediaSettings(o['media']);
  return { mode, effort, ...(model === undefined ? {} : { model }), ...(media === undefined ? {} : { media }) };
};

const MEDIA_MODEL = /^[A-Za-z0-9_.-]{1,80}$/;

/** The same leniency as the agent service's `parseMediaSettings`: anything unknown is dropped. */
export const parseMediaSettings = (raw: unknown): MediaSettings | undefined => {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const kind: MediaKind | undefined = o['kind'] === 'image' || o['kind'] === 'video' ? o['kind'] : undefined;
  const aspectRatio = typeof o['aspectRatio'] === 'string' && /^(auto|\d{1,2}:\d{1,2})$/.test(o['aspectRatio']) ? o['aspectRatio'] : undefined;
  const model = typeof o['model'] === 'string' && MEDIA_MODEL.test(o['model']) ? o['model'] : undefined;
  if (kind === undefined && aspectRatio === undefined && model === undefined) return undefined;
  return { ...(kind === undefined ? {} : { kind }), ...(aspectRatio === undefined ? {} : { aspectRatio }), ...(model === undefined ? {} : { model }) };
};

const MEDIA_KEY = 'chorus.compose.media';

/** Read and write the person's media settings in this browser. A blocked store just means not remembered. */
export const readMediaSettings = (): MediaSettings | undefined => {
  try {
    return parseMediaSettings(JSON.parse(window.localStorage.getItem(MEDIA_KEY) ?? 'null'));
  } catch {
    return undefined;
  }
};
export const writeMediaSettings = (media: MediaSettings | undefined): void => {
  try {
    if (media === undefined) window.localStorage.removeItem(MEDIA_KEY);
    else window.localStorage.setItem(MEDIA_KEY, JSON.stringify(media));
  } catch {
    // A private window: the setting holds for this page, and is not remembered.
  }
};

/* ---- the browser's calls ---- */

const url = (conversationId: string) => `/api/assistant/conversation-settings/${encodeURIComponent(conversationId)}`;

export const readConversationSettings = async (conversationId: string): Promise<ConversationSettings> => {
  const response = await fetch(url(conversationId), { cache: 'no-store' }).catch(() => null);
  if (response === null || !response.ok) return DEFAULT_CONVERSATION_SETTINGS;
  const body = (await response.json().catch(() => null)) as { settings?: unknown } | null;
  const media = readMediaSettings();
  return { ...parseConversationSettings(body?.settings), ...(media === undefined ? {} : { media }) };
};

export const saveConversationSettings = async (conversationId: string, settings: ConversationSettings): Promise<void> => {
  writeMediaSettings(settings.media);
  await fetch(url(conversationId), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  }).catch(() => undefined);
};
