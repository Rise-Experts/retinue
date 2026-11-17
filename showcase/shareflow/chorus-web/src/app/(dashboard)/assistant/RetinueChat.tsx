'use client';

/**
 * The assistant, on `@retinue/react`, with the product's own chat UI.
 *
 * ## What this is and is not
 *
 * The first version of this file rendered `MessagePart`s as bare `<p>` tags. It worked — turns ran,
 * conversations listed — and it looked nothing like the product: no markdown, no avatars, no tool
 * chips, no reasoning steps, no attachments, a plain white input. Being mechanically correct and
 * visibly wrong is still wrong, so this version keeps the entire presentation layer the product
 * already had — `MessageList`, `AssistantMessage`, `Markdown`, `ToolChips`, `ReasoningSteps`,
 * `Composer`, `ArtifactPanel`, `PermissionCard` — and changes only where the data comes from.
 *
 * The bridge is `partsToChatMessage`: `MessagePart[]` in, `AssistantChatMessage` out. That is a pure
 * function over an array the package has already ordered and deduplicated, which is what adopting the
 * package bought — `parseEvent.ts`, `messageReducer.ts` and `sse.ts` (about 480 lines of stream
 * folding) are gone, and the reconnect-from-a-cursor guarantee they never had comes with it.
 *
 * ## Where history comes from, and why the live turn is separate
 *
 * The backend persists each turn's messages, so the transcript is `useConversation` — the stored
 * record — and the **one** in-flight run is subscribed separately and appended as a trailing bubble.
 * That is how the old chat behaved too, and it is forced here anyway: `useRunSubscription` takes a run
 * id and subscribes unconditionally, so it cannot be called for "no run".
 *
 * `<LiveTurn>` exists for exactly that reason. It subscribes, lifts its parts, and unmounts once the
 * run settles — but the parts it lifted are **kept**, because `useConversation` exposes no `refresh`.
 * There is no way to refetch the stored transcript mid-session, so dropping the bubble would erase
 * the answer from the screen until the next mount. That same absence is what makes keeping it safe:
 * with no refetch, the store cannot grow the same turn underneath and duplicate it.
 *
 * The one visible cost is the sidebar: a brand-new conversation's title appears there after a reload
 * rather than immediately, since the thread list cannot be refetched either.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { canEdit, isAdminRole } from '@/lib/roles';
import { runFailureText, type RunFailure } from '@/lib/assistant/runFailure';
import { getProject, projectOfChat, putChatInProject } from '@/lib/projects/client';
import { ProjectPage } from './projects/ProjectPage';
import {
  RetinueProvider,
  useConversations,
  useRetinueClient,
  useRunSubscription,
} from '@retinue/react';
import type { MessagePart, RunStatus } from '@retinue/react';

import {
  createRetinueClient,
  answerQuestionWithLists,
  readChatModels,
  readChatPosts,
  readPendingInteraction,
  readRunContext,
  type AppRetinueClient,
  type ChatModel,
  type ChatPost,
  type PendingInteraction,
  type RunContextUsage,
} from '@/lib/assistant/retinueClient';
import { pendingInteractionIn, transcriptFrom } from '@/lib/assistant/partsToMessage';
import { latestPanelAt, openPanelFor, revisionsOf } from '@/lib/assistant/postPanel';
import { withBlocks, type TurnReference } from '@/lib/assistant/turnBlocks';
import {
  DEFAULT_CONVERSATION_SETTINGS,
  readConversationSettings,
  writeMediaSettings,
  saveConversationSettings,
  type ConversationSettings,
} from '@/lib/assistant/conversationSettings';
import { claimTopbarSlot, useTopbarSlot } from '@/components/topbarSlot';
import { createProject, type ProjectAssetRow } from '@/lib/projects/client';
import { PaneHost } from './panes/PaneHost';
import { ChatBar, type PaneId } from './panes/ChatBar';
import { ChatPostsPane } from './panes/ChatPostsPane';
import { ProjectPane } from './panes/ProjectPane';
import { MediaPane } from './panes/MediaPane';
import { CalendarPane } from './panes/CalendarPane';
import { DocumentsPane } from './panes/DocumentsPane';
import { invalidatePanes, usePaneEpoch } from '@/lib/assistant/paneCache';
import { MEDIA_POLL_MAX_MS, MEDIA_POLL_MS, panesForResults, pendingMediaJobs } from '@/lib/assistant/paneRefresh';
import type { MentionSources } from './Composer';
import type { StoredMessage } from '@/lib/assistant/partsToMessage';
import { useStoredTranscript } from '@/lib/assistant/storedTranscript';
import { unansweredQuestion } from '@/lib/assistant/unanswered';
import { pathForConversation } from '@/lib/assistant/retinueUrlState';
import type { AssistantChatMessage } from '@/lib/assistant/chatMessage';
import type { PendingPermission } from '@/lib/assistant/permissionCard';
import { useApp } from '@/lib/store';
import { setChatHost } from '@/components/sidebarChats';
import ProjectsIndex from './projects/ProjectsIndex';
import { StartControls } from './ComposerControls';
import { refreshSidebar } from '@/lib/sidebar/sidebarData';
import { PLATFORMS, type PlatformId } from '@/lib/platforms';
import { startRequest } from '@/lib/assistant/startRequest';
import { ComposeStart } from '../compose/ComposeStart';
import AttachmentBar from './AttachmentBar';
import { newUuid } from '@/lib/uuid';

import ArtifactPanel from './ArtifactPanel';
import { PostPanel } from './PostPanel';
import { useWrittenChannels } from './useWrittenChannels';
import Composer from './Composer';
import MessageList from './MessageList';
import PermissionCard from './PermissionCard';
import { useAttachments } from './useAttachments';
import styles from './assistant.module.css';
import paneStyles from './panes/panes.module.css';

/** A run is finished when it can produce nothing further. */
const SETTLED: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** How long after a turn settles to re-read the credit meter, for the turn's own charge (#597). */
const CREDIT_REFRESH_DELAY_MS = 3_000;

/**
 * One in-flight run, lifted.
 *
 * It renders nothing. Its whole job is to hold the subscription — which must be unconditional — and
 * hand the parts and status to the chat, which owns the transcript. The alternative was rendering the
 * live bubble here, and that puts it outside `MessageList`'s `column-reverse` thread, where it would
 * sit above the history instead of below it.
 */
function LiveTurn({
  runId,
  conversationId,
  onUpdate,
  describeError,
}: {
  runId: string;
  conversationId: string;
  /** #628: the run's failure as the customer should read it — never a model provider's own sentence. */
  describeError: (error: RunFailure | undefined) => string | undefined;
  onUpdate: (update: {
    runId: string;
    parts: readonly MessagePart[];
    status: RunStatus | undefined;
    settled: boolean;
    /**
     * The run's own failure, when it has one.
     *
     * Lifted alongside the parts because a run can fail with **no parts at all** and the reason then
     * lives only here. Seen for real: three empty candidates in a row ends the run with a message
     * naming what happened, and the transcript showed the generic "finished without producing an
     * answer" instead — the useful sentence was in the worker's log and nowhere a user could see it.
     */
    error: string | undefined;
  }) => void;
}) {
  const { parts, status, error } = useRunSubscription({ runId, conversationId });

  useEffect(() => {
    onUpdate({
      runId,
      parts,
      status,
      settled: status !== undefined && SETTLED.has(status),
      error: describeError(error),
    });
  }, [runId, parts, status, error, onUpdate, describeError]);

  return null;
}

function Chat({
  initialConversationId,
  initialPostId,
  projectPageId,
  projectsIndex,
  initialChatProjectId,
  initialAsk,
  autoSetup,
  autoSendAsk,
}: {
  initialConversationId: string | null;
  initialPostId: string | null;
  projectPageId: string | null;
  projectsIndex: boolean;
  initialChatProjectId: string | null;
  /** #556: text put in the chat box by a project page's "Ask to change". */
  initialAsk: string | null;
  /** #555: a project just created — the chat starts its setup by itself. */
  autoSetup: boolean;
  /** #556: send `initialAsk` as the first message instead of leaving it in the box. */
  autoSendAsk: boolean;
}) {
  const router = useRouter();
  const t = useTranslations('assistant');
  // The app's client — `sendMessage` and `decideApproval` take the chat box's extras (#543).
  const client = useRetinueClient() as AppRetinueClient;
  const { context, connected, setMobileNavOpen, refreshContext } = useApp();
  /**
   * #628: a failed run's reason, in words — a provider's billing or quota refusal is never shown as the
   * provider's own sentence. An admin of a workspace on the platform's model is offered their own key.
   */
  const isAdmin = isAdminRole(context?.workspace.role);
  const describeRunError = useCallback(
    (error: RunFailure | undefined) => runFailureText(error, { isAdmin }, (key) => t(key)),
    [isAdmin, t],
  );
  const userName = context?.profile?.fullName ?? null;
  /** For /post's `{channels}` (#498): the connected channels, by name, in the platform list's order. */
  const connectedChannels = useMemo(() => PLATFORMS.filter((p) => connected[p.id]).map((p) => p.name), [connected]);
  const attach = useAttachments();
  const startFileRef = useRef<HTMLInputElement>(null);
  /**
   * The start screen's choices — #517. Channels are every connected one unless switched off, held as
   * the switched-off set so a channel connected later is on without an effect to sync it.
   */
  const [startOff, setStartOff] = useState<ReadonlySet<PlatformId>>(() => new Set());
  const startSel = useMemo(
    () => Object.fromEntries(PLATFORMS.map((p) => [p.id, connected[p.id] === true && !startOff.has(p.id)])) as Record<PlatformId, boolean>,
    [connected, startOff],
  );

  const conversations = useConversations();

  const [conversationId, setConversationId] = useState<string>(() => initialConversationId ?? newUuid());

  /**
   * The open conversation's title, for the header.
   *
   * `undefined` on a brand-new chat, which has no title until the first message names it — the header
   * then shows just "Assistant", which is the truthful thing to show for a conversation that has not
   * started.
   */
  const activeTitle = useMemo(() => {
    const found = conversations.data.find((thread) => thread.id === conversationId);
    return found?.title === undefined || found.title === '' ? undefined : found.title;
  }, [conversations.data, conversationId]);
  /**
   * The stored transcript — through `useStoredTranscript`, not the package's `useConversation`.
   *
   * That hook refetches on a conversation change without clearing `messages`, without putting
   * `loading` back to true, and with no `.catch`, so clicking a thread showed the **new** title over
   * the **old** messages until the fetch landed — and permanently if it rejected. See
   * `lib/assistant/storedTranscript.ts` for the three defects and the key-comparison idiom that fixes
   * them without a `setState` inside an effect.
   */
  const stored = useStoredTranscript<StoredMessage>(client, conversationId);

  /**
   * Every turn started in this session, oldest first — **a list, not a slot**.
   *
   * This was a single `live` turn, and that was a bug the moment somebody sent a second message: the
   * new turn replaced the old one, and because `useConversation` has no `refresh` the first answer
   * could not come back from the store either. So the transcript visibly lost everything above the
   * newest message until a reload. Reported from the app, which is where it was obvious and where my
   * own single-turn testing never went.
   *
   * Only the last entry can still be streaming; the rest are finished and kept for display.
   */
  const [turns, setTurns] = useState<
    readonly {
      readonly runId: string;
      readonly parts: readonly MessagePart[];
      readonly status: RunStatus | undefined;
      /** Echoed locally because the store cannot be refetched — see `send`. */
      readonly userText: string;
      /**
       * The run's own failure, when it has one.
       *
       * A run can fail with **no parts at all** — three empty candidates in a row does exactly that,
       * with a message naming the cause — and without this the transcript fell back to the generic
       * "finished without producing an answer" while the useful sentence sat in the worker's log.
       */
      readonly error?: string;
    }[]
  >([]);
  const live = turns.length === 0 ? null : turns[turns.length - 1]!;
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  /**
   * Which panel is open — an artifact, or since #497 a post — as a **choice** rather than synced state.
   *
   * `null` means "whatever the turn most recently produced", an id means the reader picked one, and
   * `'closed'` means they shut it. The first version synced this with an effect that called
   * `setOpenArtifactId` when a new artifact arrived, which the React Compiler rejects — setting state
   * inside an effect is a cascading render, and it is also unnecessary: the panel's contents are a
   * function of the parts and one small choice, so it can be derived.
   */
  /*
   * A post named by the link (#500) is a choice made before anything happened: `at: -1` holds until the
   * session produces a newer post or artifact, exactly as a chip click would.
   */
  /*
   * #546: which side pane is open, and what it shows — chosen by the person, never by the agent. A post the
   * agent writes lights a dot on the toggles instead of opening or replacing a pane. `?post=` (#500) opens
   * the post pane on that post, because a link to a post is a choice made before anything happened.
   */
  const [pane, setPane] = useState<PaneId | 'artifact' | null>(() => (initialPostId === null ? null : 'post'));
  const [selectedPostId, setSelectedPostId] = useState<string | null>(initialPostId);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  /** The newest post activity the person has seen — anything after it puts a dot on the toggles. */
  const [seenAt, setSeenAt] = useState(-1);
  /** #548: the posts and files the next message points at. Panes add to it; sending clears it. */
  const [references, setReferences] = useState<readonly TurnReference[]>([]);
  const addReference = useCallback(
    (reference: TurnReference) => setReferences((current) => (current.some((r) => r.id === reference.id) ? current : [...current, reference].slice(0, 6))),
    [],
  );
  const [deciding, setDeciding] = useState(false);

  /** #521, #569: a project's page, or the projects page, shown where the chat would be. Each has its own address. */
  const onPage = projectPageId !== null || projectsIndex;

  /** The URL follows the conversation — see `retinueUrlState.ts`. `replaceState`, so no remount. */
  useEffect(() => {
    // A page has its own address (#521); the chat's URL rules apply only to the chat.
    if (onPage) return;
    const target = pathForConversation(conversationId);
    if (window.location.pathname !== target) window.history.replaceState(null, '', target);
  }, [conversationId, onPage]);

  /**
   * The project this chat belongs to — #521. A new chat started from a project knows it from the link;
   * an existing one asks. Linked on the first message, so opening "New chat in this project" and
   * leaving does not file an empty chat under the project.
   */
  const [chatProject, setChatProject] = useState<{ id: string; name: string } | null>(null);
  const linkedChats = useRef<Set<string>>(new Set());
  /** `?project=` names the project of the chat the page opened with — not of every new chat after it. */
  const [firstConversationId] = useState(conversationId);
  useEffect(() => {
    let live = true;
    if (initialChatProjectId !== null && initialConversationId === null && conversationId === firstConversationId) {
      getProject(initialChatProjectId)
        .then((d) => live && setChatProject({ id: d.project.id, name: d.project.name }))
        .catch(() => live && setChatProject(null));
    } else {
      projectOfChat(conversationId)
        .then((p) => {
          if (!live) return;
          setChatProject(p === null ? null : { id: p.id, name: p.name });
          if (p !== null) linkedChats.current.add(conversationId);
        })
        .catch(() => live && setChatProject(null));
    }
    return () => {
      live = false;
    };
  }, [conversationId, initialChatProjectId, initialConversationId, firstConversationId]);

  /**
   * The chat's agent mode, model and effort — #550, #551. Read from the conversation's saved settings;
   * a new chat starts on the defaults. Changed from the chat box, saved at once for a chat that exists
   * and on the first message for a new one, and sent with every turn.
   */
  const [settingsFor, setSettingsFor] = useState<{ readonly id: string; readonly value: ConversationSettings } | null>(null);
  const settings = settingsFor !== null && settingsFor.id === conversationId ? settingsFor.value : DEFAULT_CONVERSATION_SETTINGS;
  const settingsTouched = useRef(false);
  useEffect(() => {
    let current = true;
    settingsTouched.current = false;
    void readConversationSettings(conversationId).then((value) => {
      if (current && !settingsTouched.current) setSettingsFor({ id: conversationId, value });
    });
    return () => {
      current = false;
    };
  }, [conversationId]);
  const knownConversation = useRef<Set<string>>(new Set());
  const changeSettings = useCallback(
    (next: ConversationSettings) => {
      settingsTouched.current = true;
      setSettingsFor({ id: conversationId, value: next });
      // #575: image/video settings belong to the person, so they are remembered at once, even in a new chat.
      writeMediaSettings(next.media);
      if (knownConversation.current.has(conversationId)) void saveConversationSettings(conversationId, next);
    },
    [conversationId],
  );

  /** #551: the models this workspace may pick, from the agent service's own catalogue. */
  const [models, setModels] = useState<{ models: ChatModel[]; defaultId: string | null }>({ models: [], defaultId: null });
  useEffect(() => {
    let current = true;
    void readChatModels().then((read) => current && setModels(read));
    return () => {
      current = false;
    };
  }, []);

  const onUpdate = useCallback(
    (update: {
      runId: string;
      parts: readonly MessagePart[];
      status: RunStatus | undefined;
      settled: boolean;
      error: string | undefined;
    }) => {
      /**
       * Matched by `runId` rather than by position.
       *
       * A late event from a turn that is no longer the last one must update *that* turn, not whichever
       * happens to be newest — otherwise a slow first answer would overwrite the second one's parts.
       */
      setTurns((current) =>
        current.map((turn) =>
          turn.runId === update.runId
            ? {
                ...turn,
                parts: update.parts,
                status: update.status,
                settled: update.settled,
                ...(update.error === undefined ? {} : { error: update.error }),
              }
            : turn,
        ),
      );
      /**
       * A settled turn is **kept**, not dropped, and that is forced by the package.
       *
       * `useConversation` exposes `{ data, loading, error }` and no `refresh`, so there is no way to
       * refetch the stored transcript once the backend has persisted this turn. Dropping the live
       * bubble would therefore delete the answer from the screen until the next mount. Keeping it is
       * safe for the same reason: with no refetch, `stored.data` cannot suddenly grow the same turn
       * and duplicate it. A reload reads it from the store as normal.
       */
    },
    [],
  );

  /**
   * How full the window was on the most recent settled turn — the composer's context meter.
   *
   * The newest turn whose run has stopped, because that is when the usage rows exist. `SETTLED` is the
   * same set the streaming flag uses, so "finished" means one thing in this file. Written only from
   * inside the promise, which keeps it clear of the cascading-render rule.
   */
  const settledRunId = useMemo(() => {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn !== undefined && turn.status !== undefined && SETTLED.has(turn.status)) return turn.runId;
    }
    return undefined;
  }, [turns]);

  /*
   * What the `@` picker offers (#548): this chat's posts, the workspace's recent ones, and the project's
   * files — re-read whenever a turn finishes, which is when a new post or file can appear.
   */
  const [chatPosts, setChatPosts] = useState<{ readonly key: string; readonly posts: ChatPost[] }>({ key: '', posts: [] });
  const [recentPosts, setRecentPosts] = useState<ChatPost[]>([]);
  const [projectFiles, setProjectFiles] = useState<{ readonly key: string; readonly files: readonly ProjectAssetRow[] }>({ key: '', files: [] });
  const refreshKey = settledRunId ?? 'none';
  useEffect(() => {
    let current = true;
    const key = `${conversationId}|${refreshKey}`;
    void readChatPosts(conversationId).then((posts) => current && setChatPosts({ key, posts }));
    void readChatPosts('recent').then((posts) => current && setRecentPosts(posts));
    return () => {
      current = false;
    };
  }, [conversationId, refreshKey]);
  const chatProjectId = chatProject?.id ?? null;
  useEffect(() => {
    let current = true;
    if (chatProjectId === null) return;
    const key = `${chatProjectId}|${refreshKey}`;
    void getProject(chatProjectId)
      .then((detail) => current && setProjectFiles({ key, files: detail.assets }))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [chatProjectId, refreshKey]);
  const mentionSources = useMemo(
    (): MentionSources => ({
      chatPosts: chatPosts.key.startsWith(`${conversationId}|`) ? chatPosts.posts : [],
      recentPosts,
      projectFiles: chatProjectId !== null && projectFiles.key.startsWith(`${chatProjectId}|`) ? projectFiles.files : [],
    }),
    [chatPosts, recentPosts, projectFiles, conversationId, chatProjectId],
  );

  const [runContext, setRunContext] = useState<{ readonly runId: string; readonly usage: RunContextUsage } | null>(null);

  /**
   * The credit meter moves when a turn finishes — #597.
   *
   * The count lives in the app context, which changes only on `refreshContext()`; compose and PostPanel
   * called it and this chat did not, so a charged turn showed only after a reload. Read twice: at once
   * for what the turn's tools charged while it ran, and again shortly after for the turn's own credit,
   * which the agent records just after the run completes.
   */
  useEffect(() => {
    if (settledRunId === undefined) return;
    void refreshContext();
    const later = setTimeout(() => void refreshContext(), CREDIT_REFRESH_DELAY_MS);
    return () => clearTimeout(later);
  }, [settledRunId, refreshContext]);

  useEffect(() => {
    /**
     * By run once a turn has settled, and by conversation otherwise.
     *
     * A conversation opened from the rail has no run in this session — its messages come from the store
     * and carry no run id — so without the second branch the meter appeared only after you sent
     * something, which is the moment you least need to be told the conversation is getting long.
     */
    const key = settledRunId !== undefined ? { runId: settledRunId } : { conversationId };
    let current = true;
    void readRunContext(key).then((usage) => {
      if (current && usage !== null) setRunContext({ runId: settledRunId ?? conversationId, usage });
    });
    return () => {
      current = false;
    };
  }, [settledRunId, conversationId]);

  /**
   * The meter's numbers — for **this** run or conversation, or nothing.
   *
   * The key was stored and never compared, so the meter kept the previous conversation's numbers.
   * Finish a turn in one thread (12k of context), click "New chat", and the new conversation has no runs at
   * all: `readRunContext` returns null, the effect above skips `setRunContext`, and the old state
   * stayed — an empty thread reporting 12k of context used, indefinitely. `fetchedPending` two hundred
   * lines down compares its key for exactly this reason; this one built the same guard and then did
   * not use it, which is why the field looked like it was doing something.
   */
  const contextKey = settledRunId ?? conversationId;
  const contextMeter = useMemo(
    () =>
      runContext === null || runContext.runId !== contextKey
        ? undefined
        : {
            used: runContext.usage.inputTokens,
            limit: runContext.usage.contextLimit,
            // #499 AC-3: shown beside the tokens only when the turn (or chat) actually spent credits.
            credits: runContext.usage.credits ?? 0,
            creditsScope: runContext.usage.creditsScope ?? ('turn' as const),
            // #518: a real context only when measured per call; otherwise the figure is a turn total.
            measured: runContext.usage.contextMeasured === true,
            turnTokens: runContext.usage.turnInputTokens ?? runContext.usage.inputTokens,
            steps: runContext.usage.steps,
            // #630: the model's own window and the condensing behind the bar.
            ...(runContext.usage.modelId === undefined ? {} : { modelId: runContext.usage.modelId }),
            ...(runContext.usage.contextWindow === undefined ? {} : { window: runContext.usage.contextWindow }),
            ...(runContext.usage.compactAt === undefined ? {} : { compactAt: runContext.usage.compactAt }),
            ...(runContext.usage.historyCondensed === undefined ? {} : { condensed: runContext.usage.historyCondensed }),
            ...(runContext.usage.cachedInputTokens === undefined ? {} : { cached: runContext.usage.cachedInputTokens }),
            // #552: what the prompt was made of, when the agent service recorded it.
            ...(runContext.usage.contextSections === undefined ? {} : { sections: runContext.usage.contextSections }),
          },
    [runContext, contextKey],
  );

  const streaming = live !== null && (live.status === undefined || !SETTLED.has(live.status));
  /** The subscription is only held while the run can still produce something. */
  const subscribing = streaming;

  /** The transcript, assembled by a pure function so it can be tested without a DOM. */
  const messages = useMemo(
    (): AssistantChatMessage[] => transcriptFrom({ stored: stored.data, turns }),
    [stored.data, turns],
  );
  /*
   * A question whose run failed before this page loaded: said, with a way to ask again, instead of a question with
   * nothing under it. Only on a fresh load — a turn sent in this session reports its own failure.
   */
  const [loadedAt] = useState(() => Math.floor(Date.now() / 1000));
  const unanswered = unansweredQuestion({ messages, liveTurns: turns.length, loading: stored.loading, nowSeconds: loadedAt });

  /**
   * What the run is waiting for, **fetched** — because the pause is an event and not a part.
   *
   * A gated tool call parks the run at `waiting-for-approval`, and the engine announces that as
   * `approval.requested` carrying an interaction id. There is no `approval` part on the message, so the
   * card this used to derive from `live.parts` never appeared: a greyed tool chip, a disabled composer,
   * and no way to answer. Reported as "reply to comment gets stuck" — and it was every gated tool,
   * publishing included.
   *
   * Keyed on the *status*, so the read happens exactly when the run says it is waiting and once more
   * when it stops. `parts` still wins when it does carry an interaction: a question raised through the
   * part path needs no round trip, and preferring the local one keeps that instant.
   */
  const liveStatus = live?.status;
  const liveRunId = live?.runId;
  /**
   * `<runId>|<status>|<parts so far>` — the identity of the thing being waited on.
   *
   * The fetched value is stored **with** this key and read back only when the key still matches, rather
   * than being cleared when the run moves on. Clearing meant a synchronous `setState` inside the effect,
   * which the React Compiler rejects — correctly: it is a cascading render, and the same rule caught the
   * artifact panel earlier in this rewrite. Deriving staleness from a key needs no write at all.
   *
   * **The part count is what makes the key unique per approval, and it was missing.** One run can raise
   * two gated calls, and its status then walks `waiting-for-approval → running → waiting-for-approval`
   * — which produced the *same* `<runId>|<status>` string both times. So while the second approval's
   * request was in flight, `fetched.key === pendingKey` still held with the **first** approval's data:
   * the card came back after it had been answered, showing the wrong tool, and `decide` would have
   * posted a decision for the first interaction's id. Exactly the failure the comment above says the
   * key exists to prevent, one approval short of preventing it.
   *
   * `live.parts` has grown by then — the first call's approval and result are in it — so the count
   * separates the two episodes without another piece of state. It is a discriminator, not a
   * measurement: if two waits ever shared a count the behaviour would be no worse than it was.
   */
  const pendingKey =
    liveRunId === undefined ? null : `${liveRunId}|${liveStatus ?? ''}|${live?.parts.length ?? 0}`;
  const [fetched, setFetched] = useState<{ readonly key: string; readonly pending: PendingInteraction } | null>(null);

  useEffect(() => {
    if (pendingKey === null || liveRunId === undefined) return;
    if (liveStatus !== 'waiting-for-approval' && liveStatus !== 'waiting-for-question') return;
    let current = true;
    void readPendingInteraction({ runId: liveRunId }).then((pending) => {
      // Guarded twice: this flag for an unmount mid-flight, and the key for a run that resumed while
      // the request was open — applying a stale approval would put the card back after it was answered.
      if (current) setFetched({ key: pendingKey, pending });
    });
    return () => {
      current = false;
    };
  }, [pendingKey, liveRunId, liveStatus]);

  /**
   * Memoised because the fallback is a fresh `{}` on every render, and two `useMemo`s below take this
   * as a dependency — an unstable object there would rebuild the permission card every render.
   */
  const fetchedPending: PendingInteraction = useMemo(
    () => (fetched !== null && fetched.key === pendingKey ? fetched.pending : {}),
    [fetched, pendingKey],
  );

  /** An approval the run is waiting on, in the shape the product's card already renders. */
  const pendingPermission = useMemo((): PendingPermission | null => {
    if (live === null) return null;
    const inParts = pendingInteractionIn(live.parts);
    const fromParts =
      inParts !== undefined && inParts.kind === 'approval'
        ? {
            interactionId: String(inParts.part.interactionId),
            toolName: inParts.part.toolName,
            toolArgs: {} as unknown,
            riskCategory: inParts.part.riskCategory,
            summary: inParts.part.summary,
          }
        : undefined;
    const approval = fromParts ?? fetchedPending.approval;
    if (approval === undefined) return null;

    const args =
      approval.toolArgs !== null && typeof approval.toolArgs === 'object'
        ? (approval.toolArgs as Record<string, unknown>)
        : {};
    return {
      runId: live.runId,
      toolCallId: approval.interactionId,
      toolName: approval.toolName,
      toolArgs: args,
      category: approval.riskCategory,
      summary: approval.summary,
      /**
       * Snake_case, because `ToolCall` here mirrors what the old runtime put on the wire. Kept rather
       * than renamed: `PermissionCard` reads these field names and the card is what has to work.
       *
       * The arguments are real now. They were `{}` — the card renders them so a person can see *what*
       * they are approving, and "publish this post" with no post in it is not a decision anyone can
       * make.
       */
      tools: [{ tool_call_id: approval.interactionId, tool_name: approval.toolName, tool_args: args }],
    } as unknown as PendingPermission;
  }, [live, fetchedPending]);

  /** A question the run is waiting on. Answered inline, since it blocks the turn. */
  const pendingQuestion = useMemo(() => {
    if (live === null) return null;
    const pending = pendingInteractionIn(live.parts);
    if (pending !== undefined && pending.kind === 'question') return { runId: live.runId, part: pending.part };
    const fetched = fetchedPending.question;
    return fetched === undefined
      ? null
      : {
          runId: live.runId,
          part: {
            interactionId: fetched.interactionId,
            questions: fetched.questions,
          } as unknown as Extract<MessagePart, { type: 'question' }>,
        };
  }, [live, fetchedPending]);

  /** Every part this session produced, oldest first, and where the running turn starts. */
  const sessionParts = useMemo(() => turns.flatMap((turn) => turn.parts), [turns]);
  const liveFrom = sessionParts.length - (live === null ? 0 : live.parts.length);
  /** The newest post the session wrote or is writing — what the post pane shows when nothing was picked. */
  const latest = useMemo(() => openPanelFor(null, sessionParts, liveFrom), [sessionParts, liveFrom]);
  const latestPost = latest !== null && latest.kind === 'post' ? latest : null;
  const newestAt = useMemo(() => latestPanelAt(sessionParts), [sessionParts]);
  const shownPostId = selectedPostId ?? latestPost?.postId ?? null;
  const openPost =
    pane !== 'post'
      ? null
      : {
          postId: shownPostId,
          writing: latestPost !== null && latestPost.postId === shownPostId ? latestPost.writing : ([] as readonly string[]),
        };
  // #497 AC-1: while the pane shows a post still being written, each channel fills as the tool finishes it.
  const writtenChannels = useWrittenChannels(liveRunId, openPost !== null && openPost.postId === null && openPost.writing.length > 0);
  const openArtifactId = pane === 'artifact' ? artifactId : null;
  /** Reload key for the post pane: every result in this session that changed the post it shows. */
  const postRevision = useMemo(
    () => (shownPostId === null ? 0 : revisionsOf(shownPostId, turns.map((turn) => turn.parts))),
    [shownPostId, turns],
  );
  /*
   * #628 part 5: the open panes follow what the assistant makes, as it makes it. Each new successful tool
   * result invalidates the panes whose data it changed (`paneRefresh.ts`), so a post, an image, a PDF or a
   * document appears in its pane without reopening it — and without waiting for the turn to end. Only this
   * session's turns: history loaded from the store changed nothing just now.
   */
  const seenResults = useRef(new Set<string>());
  useEffect(() => {
    const { panes, seen } = panesForResults(sessionParts, seenResults.current);
    for (const id of seen) seenResults.current.add(id);
    invalidatePanes(panes);
  }, [sessionParts]);
  // And once more when a turn settles, for whatever a tool changed that the map does not name.
  useEffect(() => {
    if (settledRunId !== undefined) invalidatePanes(['posts', 'media', 'documents']);
  }, [settledRunId]);

  /*
   * A media job runs for seconds (an image) to minutes (a video), long after the turn that started it. While
   * one is pending, its status is polled lightly; when it finishes, the media and post panes re-read.
   */
  const [finishedJobs, setFinishedJobs] = useState<ReadonlySet<string>>(() => new Set());
  const pendingJobs = useMemo(() => pendingMediaJobs(sessionParts, finishedJobs), [sessionParts, finishedJobs]);
  const pendingJobsKey = pendingJobs.join(',');
  useEffect(() => {
    if (pendingJobsKey === '') return;
    const jobs = pendingJobsKey.split(',');
    const started = Date.now();
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      if (Date.now() - started > MEDIA_POLL_MAX_MS) {
        clearInterval(timer);
        return;
      }
      void Promise.all(
        jobs.map(async (jobId) => {
          const response = await fetch(`/api/ai/generate-media/${encodeURIComponent(jobId)}`, { cache: 'no-store' }).catch(() => null);
          if (response === null) return null;
          // A job this workspace cannot see will never finish from here: stop watching it.
          if (response.status === 404) return jobId;
          if (!response.ok) return null;
          const body = (await response.json().catch(() => null)) as { status?: string } | null;
          return body?.status === 'succeeded' || body?.status === 'failed' ? jobId : null;
        }),
      ).then((outcomes) => {
        const done = outcomes.filter((id): id is string => id !== null);
        if (stopped || done.length === 0) return;
        setFinishedJobs((current) => new Set([...current, ...done]));
        invalidatePanes(['media', 'post', 'posts']);
      });
    }, MEDIA_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingJobsKey]);
  /** The post pane reloads for its own tool results (`postRevision`) and for any other invalidation — focus, a finished job. */
  const postEpoch = usePaneEpoch('post');

  /** #546 AC-2: news is a dot, never a pane opening by itself. */
  const news = useMemo((): ReadonlySet<PaneId> => {
    if (newestAt <= seenAt || latestPost === null) return new Set();
    if (pane === 'posts' || (pane === 'post' && shownPostId === latestPost.postId)) return new Set();
    return new Set<PaneId>(['post', 'posts']);
  }, [newestAt, seenAt, latestPost, pane, shownPostId]);

  const togglePane = useCallback(
    (next: PaneId) => {
      setSeenAt(newestAt);
      // Opening the post pane pins what it shows, so a later post cannot replace it underneath the reader.
      if (next === 'post' && selectedPostId === null && latestPost?.postId) setSelectedPostId(latestPost.postId);
      setPane((current) => (current === next ? null : next));
    },
    [newestAt, selectedPostId, latestPost],
  );
  const openPostPane = useCallback(
    (id: string) => {
      setSelectedPostId(id);
      setPane('post');
      setSeenAt(newestAt);
    },
    [newestAt],
  );
  const openArtifact = useCallback((id: string) => {
    setArtifactId(id);
    setPane('artifact');
  }, []);
  const closePane = useCallback(() => {
    setPane(null);
    setSeenAt(newestAt);
  }, [newestAt]);

  /**
   * A send is in flight — true from the click, not from the first streamed part.
   *
   * `send` returns `true` synchronously and appends the turn only *after* `await client.sendMessage`.
   * In that window `turns` is unchanged, so `streaming` is false and the `if (streaming) return`
   * guards in `startNewChat` and `openThread` did not fire. Click Send, then "New chat" before the
   * POST returns: `setTurns([])` runs, the awaited callback then appends conversation A's run to the
   * now-empty list, and `LiveTurn` mounts with A's `runId` under B's `conversationId` — A's answer
   * streams into the new thread. The same window let a second Enter start a second turn whose
   * predecessor was never subscribed, losing the first answer with no `refresh` to recover it.
   *
   * A ref rather than state because the guards must see it on the very next event, with no render in
   * between — which is exactly what state cannot promise.
   */
  const sendInFlight = useRef(false);

  const send = useCallback(
    (text: string): boolean => {
      const message = text.trim();
      if (message === '' || streaming || sendInFlight.current) return false;
      sendInFlight.current = true;
      setSendError(undefined);
      /*
       * The chat is filed under its project **before** the turn starts. It was fire-and-forget, so the
       * agent's first turn could run before the link existed and not see the project at all — which is
       * exactly the turn a new project's setup (#555) is.
       */
      const linkFirst =
        chatProject !== null && !linkedChats.current.has(conversationId)
          ? (linkedChats.current.add(conversationId),
            putChatInProject(chatProject.id, conversationId).catch(() => {
              linkedChats.current.delete(conversationId);
            }))
          : Promise.resolve();
      /*
       * #543: the turn carries what the chat box holds — the files (#549, which were uploaded and then
       * dropped before), the `@` references (#548), and the chat's mode, model and effort (#550, #551).
       * Taken now and cleared at once, so a second message does not resend them.
       */
      const attachments = [...attach.readyPaths];
      const sentReferences = [...references];
      const sentSettings = settings;
      attach.clear();
      setReferences([]);
      // A chat's settings are saved with it once it exists — which is from this message on.
      if (!knownConversation.current.has(conversationId)) {
        knownConversation.current.add(conversationId);
        if (settingsTouched.current) void saveConversationSettings(conversationId, sentSettings);
      }
      void (async () => {
        try {
          await linkFirst;
          const { runId } = await client.sendMessage({
            conversationId,
            text: message,
            attachments,
            references: sentReferences,
            settings: sentSettings,
          });
          /**
           * The user's own turn is added locally as well as being persisted server-side.
           *
           * With no `refresh` on `useConversation`, the stored transcript will not show it until the
           * next mount. Echoed with the same blocks the server appends, so the bubble shows its chips
           * and images now exactly as it will after a reload.
           */
          setTurns((current) => [
            ...current,
            { runId, parts: [], status: 'queued', userText: withBlocks(message, sentReferences, attachments) },
          ]);
        } catch (error) {
          setSendError(error instanceof Error ? error.message : t('sendFailed'));
        } finally {
          // Released either way, so a failed send does not leave the box permanently refusing.
          sendInFlight.current = false;
        }
      })();
      // True so the box clears: the message is accepted, and a failure surfaces below the thread.
      return true;
    },
    [client, conversationId, streaming, t, chatProject, attach, references, settings],
  );

  /**
   * #747: stop the running turn. Cancellation is cooperative (see the cancel route): this records the
   * request, and the run's own status — read through the subscription — is what ends the turn, so the
   * button says "Stopping…" until it does rather than claiming a stop that has not happened.
   */
  const [stoppingRun, setStoppingRun] = useState<string | null>(null);
  const stop = useCallback(async () => {
    if (liveRunId === undefined || stoppingRun === liveRunId) return;
    setStoppingRun(liveRunId);
    try {
      await client.cancelRun({ runId: liveRunId });
    } catch (error) {
      setStoppingRun(null);
      setSendError(error instanceof Error ? error.message : t('stopFailed'));
    }
  }, [client, liveRunId, stoppingRun, t]);

  const decide = useCallback(
    async (decision: 'once' | 'session' | 'always' | 'deny') => {
      if (pendingPermission === null || deciding) return;
      setDeciding(true);
      try {
        /**
         * The product's four buttons map onto the platform's four decisions.
         *
         * `session` is `allow-conversation`, which is why the conversation id goes with it — the grant
         * it issues is scoped to that conversation, and the backend refuses the decision without one.
         */
        const map = {
          once: 'allow-once',
          session: 'allow-conversation',
          always: 'allow-always',
          deny: 'deny',
        } as const;
        await client.decideApproval({
          interactionId: pendingPermission.toolCallId,
          runId: pendingPermission.runId,
          decision: map[decision],
          // "Allow for this chat" is a grant scoped to it; without the id the agent service refused it.
          conversationId,
        });
      } catch (error) {
        setSendError(error instanceof Error ? error.message : t('sendFailed'));
      } finally {
        setDeciding(false);
      }
    },
    [client, pendingPermission, deciding, t, conversationId],
  );

  /** A new conversation with nothing in it yet: the start screen instead of an empty thread (#517). */
  const isStart = messages.length === 0 && turns.length === 0 && !stored.loading && pendingPermission === null;
  const creditsExhausted =
    context != null && (context.workspace.aiCreditsUsed ?? 0) >= (context.workspace.aiCreditsLimit ?? 0);

  /** The start screen's "Create post": the idea plus its choices, said in words, as the first turn. */
  const startFromScreen = (prompt: string) => {
    if (attach.uploading) return;
    const photos = attach.attachments.filter((a) => !a.uploading && a.kind !== 'document');
    const channels = PLATFORMS.filter((p) => startSel[p.id]).map((p) => p.name);
    const message = startRequest(
      { prompt, channels, image: false, photos: photos.length },
      {
        forChannels: (list) => t('start.forChannels', { channels: list }),
        image: t('start.image'),
        photos: (count) => t('start.photos', { count }),
      },
    );
    /*
     * The photos go with this first message now (#549): `send` passes the ready paths and the agent attaches
     * them to the draft it writes (`attach_uploaded_media`). They used to wait for the post panel to open by
     * itself and apply them — and since #546 no pane opens by itself.
     */
    send(message);
  };

  /** A different conversation starts with nothing chosen and nothing pointed at. */
  const resetPanes = useCallback(() => {
    setPane(null);
    setSelectedPostId(null);
    setArtifactId(null);
    setSeenAt(-1);
    setReferences([]);
  }, []);

  const startNewChat = useCallback(() => {
    // See the note on `sendInFlight`: this is the guard that let A's run stream into B's thread.
    if (streaming || sendInFlight.current) return;
    // On a page the view comes from the address, so leaving it is a navigation (#521).
    if (onPage) {
      router.push('/compose?new=post');
      return;
    }
    setConversationId(newUuid());
    setTurns([]);
    resetPanes();
  }, [streaming, onPage, router, resetPanes]);

  const openThread = useCallback(
    (id: string) => {
      // `sendInFlight` as well as `streaming`: see the note on the ref. Between the click and the POST
      // returning, `streaming` is still false and this guard used to let the switch through.
      if (streaming || sendInFlight.current) return;
      if (onPage) {
        router.push(pathForConversation(id));
        return;
      }
      setConversationId(id);
      // On a phone the threads are in the slide-out menu, which should get out of the way once one is picked.
      setMobileNavOpen(false);
      // A run belongs to the conversation it ran in; carrying it over would stream one thread's turn
      // into another's transcript.
      setTurns([]);
      resetPanes();
    },
    [streaming, onPage, router, setMobileNavOpen, resetPanes],
  );

  /** #544: the top bar's page slot, which this chat fills with its title, project and pane toggles. */
  const topbarSlot = useTopbarSlot();
  useEffect(() => {
    claimTopbarSlot(true);
    return () => claimTopbarSlot(false);
  }, []);

  /**
   * #556, #555: text put in the chat box for the person to finish ("Ask to change…"), as a seed the box
   * takes each time the count moves — so the same sentence twice still lands.
   */
  const [seed, setSeed] = useState<{ readonly text: string; readonly n: number } | null>(() =>
    initialAsk === null || initialAsk === '' || autoSendAsk ? null : { text: initialAsk, n: 1 },
  );
  const askInBox = useCallback((text: string) => setSeed((current) => ({ text, n: (current?.n ?? 0) + 1 })), []);

  /** #555: a new project is set up by the agent in a chat, not in a form. */
  const role = context?.workspace.role;
  const startNewProject = useCallback(async () => {
    try {
      const created = await createProject({ name: t('projects.newProjectName'), personal: !canEdit(role) });
      // A full load, not router.push: Compose stays mounted across a client navigation and its chat reads
      // `?project`/`?setup` only on mount, so a push from inside a chat kept the old thread on screen and
      // never started the setup (production, #557).
      window.location.assign(`/compose?project=${encodeURIComponent(created.id)}&setup=1`);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : t('sendFailed'));
    }
  }, [t, role]);

  /**
   * #555: a project just created starts its setup by itself, once, in its first chat; #556: the project
   * page's ask box sends its sentence the same way. Only into an empty chat that already knows its project,
   * so the first message is filed under the project.
   */
  const firstSent = useRef(false);
  useEffect(() => {
    if (firstSent.current || chatProject === null || turns.length > 0 || stored.loading || stored.data.length > 0) return;
    const first = autoSetup ? t('projects.setupStarter') : autoSendAsk && initialAsk !== null && initialAsk.trim() !== '' ? initialAsk.trim() : null;
    if (first === null) return;
    firstSent.current = true;
    send(first);
  }, [autoSetup, autoSendAsk, initialAsk, chatProject, turns.length, stored.loading, stored.data.length, send, t]);

  /**
   * The sidebar's "New chat" and its chat rows are this chat's own guarded switches while Compose is
   * mounted (#565): switching in place, refused while a turn streams.
   */
  useEffect(() => {
    setChatHost({ newChat: startNewChat, openThread, activeId: onPage ? null : conversationId, busy: streaming });
  }, [startNewChat, openThread, conversationId, onPage, streaming]);
  useEffect(() => () => setChatHost(null), []);

  /**
   * The sidebar lists chats itself now, so it has to hear about a new one, or a new title: when a turn
   * ends, it reloads. A turn is when both change — the first message creates the chat and names it.
   */
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) void refreshSidebar();
    wasStreaming.current = streaming;
  }, [streaming]);

  return (
    <div className={styles.page}>

      {/*
        #544: the chat's title, its project and the pane toggles live in the top bar — no second header
        row over the conversation.
      */}
      {topbarSlot === null
        ? null
        : createPortal(
            <ChatBar
              title={onPage ? undefined : activeTitle}
              project={onPage ? null : chatProject}
              streaming={streaming}
              open={pane === 'artifact' ? null : pane}
              onToggle={togglePane}
              news={news}
            />,
            topbarSlot,
          )}

      <div className={styles.wrap}>
        {live !== null && subscribing ? (
          <LiveTurn runId={live.runId} conversationId={conversationId} onUpdate={onUpdate} describeError={describeRunError} />
        ) : null}

        {projectsIndex ? (
          <ProjectsIndex canCreateShared={canEdit(context?.workspace.role)} onNewProject={() => void startNewProject()} />
        ) : projectPageId !== null ? (
          <ProjectPage
            projectId={projectPageId}
            canEditShared={canEdit(context?.workspace.role)}
            threads={conversations.data}
            onOpenThread={openThread}
          />
        ) : isStart ? (
          <>
            {/*
              Compose's start screen (#517): the idea, the channels, an image, photos. The first send
              turns it into the chat; an existing conversation never shows it.
            */}
            <ComposeStart
              connected={connected}
              sel={startSel}
              onToggle={(id) =>
                setStartOff((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              hasProject={chatProject !== null}
              creditsExhausted={creditsExhausted}
              creditsUsed={context?.workspace.aiCreditsUsed ?? 0}
              creditsLimit={context?.workspace.aiCreditsLimit ?? 0}
              onStart={startFromScreen}
              onUpload={() => startFileRef.current?.click()}
              controls={(append) => (
                <StartControls
                  append={append}
                  disabled={streaming}
                  canAttach={!streaming && attach.canAddMore}
                  onAddFiles={() => startFileRef.current?.click()}
                  settings={settings}
                  onSettingsChange={changeSettings}
                  models={models.models}
                  defaultModelId={models.defaultId}
                  meter={contextMeter}
                  month={{
                    used: context?.workspace.aiCreditsUsed ?? 0,
                    limit: context?.workspace.aiCreditsLimit ?? 0,
                    ...(context?.workspace.planName === undefined ? {} : { plan: context.workspace.planName }),
                  }}
                />
              )}
            />
            <AttachmentBar attachments={attach.attachments} onRemove={attach.remove} />
            <input
              ref={startFileRef}
              type="file"
              accept="image/*,video/*"
              multiple
              hidden
              onChange={(e) => {
                void attach.addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        ) : (
        <>
        <MessageList
          messages={messages}
          isStreaming={streaming}
          retrying={live?.status === 'retry-pending'}
          userName={userName}
          onAttach={(item) => void attach.addRemote(item)}
          onOpenArtifact={openArtifact}
          onOpenPost={openPostPane}
          onSay={send}
          /**
           * `undefined` when there is nothing in it — **not an empty fragment.**
           *
           * `MessageList` renders its blank state on `messages.length === 0 && !footer`, and a fragment
           * is truthy however empty it is. So a footer was always passed, `!footer` was always false,
           * and the empty-chat state never appeared once: a new conversation was a blank void with a
           * heading over it, while `ChatBlankState`, its two strings and its styles all existed and were
           * unreachable.
           */
          footer={
            pendingPermission !== null || pendingQuestion !== null || sendError !== undefined || unanswered !== null ? (
              <>
                {unanswered !== null && (
                  <div className={styles.errorText} role="status">
                    {t('unanswered')}{' '}
                    <button type="button" className={styles.retryLink} onClick={() => void send(unanswered)} disabled={streaming}>
                      {t('askAgain')}
                    </button>
                  </div>
                )}
                {pendingPermission !== null && (
                  <PermissionCard pending={pendingPermission} busy={deciding} onDecide={decide} />
                )}
                {pendingQuestion !== null && (
                  <QuestionCard
                    runId={pendingQuestion.runId}
                    part={pendingQuestion.part}
                    onFailed={(message) => setSendError(message)}
                  />
                )}
                {sendError !== undefined && <div className={styles.errorText}>{sendError}</div>}
              </>
            ) : undefined
          }
        />

        <Composer
          attach={attach}
          disabled={streaming || pendingPermission !== null}
          onSend={send}
          meter={contextMeter}
          month={{
            used: context?.workspace.aiCreditsUsed ?? 0,
            limit: context?.workspace.aiCreditsLimit ?? 0,
            ...(context?.workspace.planName === undefined ? {} : { plan: context.workspace.planName }),
          }}
          postId={shownPostId}
          channels={connectedChannels}
          references={references}
          onReferencesChange={setReferences}
          settings={settings}
          onSettingsChange={changeSettings}
          models={models.models}
          defaultModelId={models.defaultId}
          mentionSources={mentionSources}
          hasProject={chatProject !== null}
          seed={seed}
          onStop={streaming && liveRunId !== undefined ? () => void stop() : undefined}
          stopping={liveRunId !== undefined && stoppingRun === liveRunId}
        />
        </>
        )}
      </div>

      {/* #546: one pane beside the chat, never over it on a desktop. */}
      {pane !== null && !onPage && (
        <PaneHost onClose={closePane}>
          {pane === 'artifact' && openArtifactId !== null ? (
            <ArtifactPanel
              key={openArtifactId}
              artifactId={openArtifactId}
              onClose={closePane}
              conversationId={conversationId}
              // #589: the agent does it — attach_artifact_to_post renders the PDF or image and checks the channels.
              onAttachToPost={(post, as, title) =>
                send(t('attachAsk', { title, artifactId: openArtifactId, post: post.label, postId: post.id, format: as === 'pdf' ? 'a PDF' : as === 'carousel' ? "a carousel (as='carousel', one image per slide)" : as === 'video' ? "a video (as='video', an MP4 of the deck playing)" : 'an image' }))
              }
              // #607: "Edit with Chorus" — a change to the selected part, asked through the same send path.
              onEditRequest={(message) => {
                send(message);
              }}
            />
          ) : pane === 'post' && openPost !== null ? (
            openPost.postId === null && openPost.writing.length === 0 ? (
              <EmptyPostPane onClose={closePane} onOpenPosts={() => togglePane('posts')} />
            ) : (
              <PostPanel
                key={openPost.postId ?? 'writing'}
                postId={openPost.postId}
                revision={postRevision + postEpoch}
                writing={openPost.writing}
                written={writtenChannels}
                canSend={!streaming && pendingPermission === null}
                onSend={send}
                onClose={closePane}
                onAddToChat={
                  openPost.postId === null
                    ? undefined
                    : (label: string) => addReference({ kind: 'post', id: openPost.postId!, label })
                }
              />
            )
          ) : pane === 'posts' ? (
            <ChatPostsPane
              conversationId={conversationId}
              selectedPostId={shownPostId}
              references={references}
              onOpen={openPostPane}
              onAddToChat={addReference}
              onClose={closePane}
            />
          ) : pane === 'media' ? (
            <MediaPane project={chatProject} references={references} onAddToChat={addReference} onClose={closePane} />
          ) : pane === 'documents' ? (
            <DocumentsPane conversationId={conversationId} openArtifactId={artifactId} onOpen={openArtifact} onClose={closePane} />
          ) : pane === 'project' ? (
            <ProjectPane
              conversationId={conversationId}
              project={chatProject}
              refreshKey={refreshKey}
              onProjectChange={(next) => {
                linkedChats.current.add(conversationId);
                setChatProject(next);
              }}
              onAsk={askInBox}
              onNewProject={() => void startNewProject()}
              onClose={closePane}
            />
          ) : pane === 'calendar' ? (
            <CalendarPane onOpen={openPostPane} onClose={closePane} />
          ) : null}
        </PaneHost>
      )}
    </div>
  );
}

/** The post pane before this chat has a post: what it is for, and the way to the chat's other posts. */
function EmptyPostPane({ onClose, onOpenPosts }: { onClose: () => void; onOpenPosts: () => void }) {
  const t = useTranslations('assistant.panes');
  // On the panes' own frame, like every other pane: its own classes put the title, the text and the link
  // at three different indents (production, #557).
  return (
    <section className={paneStyles.pane} aria-label={t('post')}>
      <header className={paneStyles.head}>
        <span className={paneStyles.headTitle}>{t('post')}</span>
        <span className={paneStyles.grow} />
        <button type="button" className={paneStyles.iconBtn} onClick={onClose} aria-label={t('close')}>
          <svg className={paneStyles.ic} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className={paneStyles.body}>
        <div className={paneStyles.empty}>
          <p className={paneStyles.emptyText}>{t('postEmpty')}</p>
          <button type="button" className={paneStyles.pill} onClick={onOpenPosts}>
            {t('posts')}
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * A question the assistant is waiting on.
 *
 * Every shape `QuestionSpec` allows: a checkbox list for `multiple`, a radio group for a closed list,
 * a text box when there are no options, and a text box beside a list when `allowOther`. It reads the
 * flags rather than the prompt because that is what they are for — the platform's own note is that
 * "pick a model" and "pick the features you want" are identical on the wire and completely different
 * in a UI.
 *
 * Answers go through `answerQuestionWithLists`, not the package's `useAnswerQuestion`: that hook's
 * `answers` is `Record<string, string>` while the platform accepts `string | readonly string[]`, so a
 * `multiple` question cannot be answered through it at all.
 */
function QuestionCard({
  runId,
  part,
  onFailed,
}: {
  runId: string;
  part: Extract<MessagePart, { type: 'question' }>;
  onFailed: (message: string) => void;
}) {
  const t = useTranslations('assistant');
  const [chosen, setChosen] = useState<Record<string, string | string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const answerFor = (key: string): string | readonly string[] | undefined => {
    const typed = other[key]?.trim();
    if (typed !== undefined && typed !== '') return typed;
    const picked = chosen[key];
    if (Array.isArray(picked)) return picked.length === 0 ? undefined : picked;
    return picked === undefined || picked === '' ? undefined : picked;
  };

  // Every question needs an answer: a partial reply resumes the run knowing less than it asked.
  const complete = part.questions.every((question) => answerFor(question.key) !== undefined);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!complete || submitting) return;
    setSubmitting(true);
    try {
      const answers: Record<string, string | readonly string[]> = {};
      for (const question of part.questions) {
        const value = answerFor(question.key);
        if (value !== undefined) answers[question.key] = value;
      }
      await answerQuestionWithLists({ interactionId: String(part.interactionId), runId, answers });
    } catch (error) {
      // The choices are kept: the answer never reached the backend, so there is input to preserve.
      onFailed(error instanceof Error ? error.message : t('sendFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className={styles.interactionCard} onSubmit={submit}>
      {part.questions.map((question) => {
        const options = question.options ?? [];
        // The platform's stated default: free text when there are no options, closed when there are.
        const allowOther = question.allowOther ?? options.length === 0;
        return (
          <fieldset key={question.key} className={styles.interactionField}>
            <legend className={styles.interactionPrompt}>{question.prompt}</legend>
            {options.map((option) =>
              question.multiple === true ? (
                <label key={option} className={styles.interactionOption}>
                  <input
                    type="checkbox"
                    checked={Array.isArray(chosen[question.key]) && (chosen[question.key] as string[]).includes(option)}
                    onChange={(event) =>
                      setChosen((previous) => {
                        const current = Array.isArray(previous[question.key]) ? (previous[question.key] as string[]) : [];
                        return {
                          ...previous,
                          [question.key]: event.target.checked ? [...current, option] : current.filter((i) => i !== option),
                        };
                      })
                    }
                  />
                  {option}
                </label>
              ) : (
                <label key={option} className={styles.interactionOption}>
                  <input
                    type="radio"
                    name={`${String(part.interactionId)}:${question.key}`}
                    checked={chosen[question.key] === option}
                    onChange={() => setChosen((previous) => ({ ...previous, [question.key]: option }))}
                  />
                  {option}
                </label>
              ),
            )}
            {allowOther ? (
              <input
                className={styles.composerInput}
                value={other[question.key] ?? ''}
                onChange={(event) => setOther((previous) => ({ ...previous, [question.key]: event.target.value }))}
              />
            ) : null}
          </fieldset>
        );
      })}
      <button type="submit" className={styles.sendButton} disabled={!complete || submitting}>
        {submitting ? '…' : t('send')}
      </button>
    </form>
  );
}


export default function RetinueChat({
  initialConversationId = null,
  initialPostId = null,
  projectPageId = null,
  projectsIndex = false,
  initialChatProjectId = null,
  initialAsk = null,
  autoSetup = false,
  autoSendAsk = false,
}: {
  initialConversationId?: string | null;
  /** #500: `?post=` — open with this post in the side panel (every "edit this post" link lands here). */
  initialPostId?: string | null;
  /** #521: `/compose/p/<id>` — show that project's page where the chat would be. */
  projectPageId?: string | null;
  /** #569: `/compose/projects` — every project, as a table. */
  projectsIndex?: boolean;
  /** #521: `?project=<id>` — a new chat inside that project. */
  initialChatProjectId?: string | null;
  /** #556: `?ask=` — text a project page put in the chat box. */
  initialAsk?: string | null;
  /** #555: `?setup=1` — the project was just created; the chat starts setting it up. */
  autoSetup?: boolean;
  /** #556: `?send=1` — send `initialAsk` at once. */
  autoSendAsk?: boolean;
}) {
  /**
   * One client per mount, in a state initializer.
   *
   * `useMemo` with a ref assignment was the first version — a side effect during render, which the
   * React Compiler refused to memoize and was right to. The signal closes every stream on unmount;
   * without it, navigating away leaves one open SSE connection per turn started.
   */
  const [transport] = useState(() => {
    const controller = new AbortController();
    return { controller, client: createRetinueClient({ signal: controller.signal }) };
  });
  useEffect(() => () => transport.controller.abort(), [transport]);

  return (
    <RetinueProvider client={transport.client}>
      <Chat
        initialConversationId={initialConversationId}
        initialPostId={initialPostId}
        projectPageId={projectPageId}
        projectsIndex={projectsIndex}
        initialChatProjectId={initialChatProjectId}
        initialAsk={initialAsk}
        autoSetup={autoSetup}
        autoSendAsk={autoSendAsk}
      />
    </RetinueProvider>
  );
}
