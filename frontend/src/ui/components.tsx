/**
 * Optional UI components — `docs/06` → Optional UI package.
 *
 * A minimal, unopinionated component set over the headless hooks + reducers + localization. There is
 * no product styling: every element takes a `className` so the consuming app owns the look. Text
 * shown to the user goes through an injected translator `t` (defaulting to the raw id), so the whole
 * UI localizes per `docs/14`. React is a peer dependency, provided by the host.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import type { ConversationSummary, Message, MessagePart } from "../types/index.js";
import type { RunView } from "../reducers.js";
import type { RetryState } from "../hooks/index.js";
import type { ApprovalDecision } from "../client.js";
import { partKey, partSummary } from "./part-summary.js";
import { errorId, statusId } from "../localization.js";

/** Injected translator; defaults to returning the id so the components work with no catalog wired. */
export type T = (id: string, params?: Record<string, unknown>) => string;
const identity: T = (id) => id;

export const StatusBadge = (props: { status: string; t?: T; className?: string }): ReactNode => {
  const t = props.t ?? identity;
  return <span className={props.className} data-status={props.status}>{t(statusId(props.status))}</span>;
};

export const RetryIndicator = (props: { retry: RetryState; t?: T; className?: string }): ReactNode => {
  const t = props.t ?? identity;
  return (
    <div className={props.className} role="status">
      {t("retry.pending", { attempt: props.retry.attempt, maxAttempts: props.retry.maxAttempts, nextAttemptAt: props.retry.nextAttemptAt })}
    </div>
  );
};

export const PartView = (props: { part: MessagePart; t?: T; className?: string }): ReactNode => {
  const { part } = props;
  const t = props.t ?? identity;
  const { kind, preview } = partSummary(part);
  if (part.type === "error") {
    return <div className={props.className} data-part="error" role="alert">{t(errorId(part.error.code))}</div>;
  }
  return (
    <div className={props.className} data-part={part.type} data-kind={kind}>
      {preview}
    </div>
  );
};

export const MessageView = (props: { message: Message; t?: T; className?: string }): ReactNode => (
  <div className={props.className} data-role={props.message.role}>
    {props.message.parts.map((p) => (
      <PartView key={partKey(p)} part={p} t={props.t} />
    ))}
  </div>
);

export const MessageList = (props: { messages: readonly Message[]; t?: T; className?: string }): ReactNode => (
  <div className={props.className}>
    {props.messages.map((m) => (
      <MessageView key={m.id} message={m} t={props.t} />
    ))}
  </div>
);

export const Composer = (props: { onSend: (text: string) => void | Promise<void>; disabled?: boolean; placeholder?: string; className?: string }): ReactNode => {
  const [text, setText] = useState("");
  const submit = async () => {
    const value = text.trim();
    if (!value || props.disabled) return;
    setText("");
    await props.onSend(value);
  };
  return (
    <form
      className={props.className}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea value={text} placeholder={props.placeholder} disabled={props.disabled} onChange={(e) => setText(e.target.value)} />
      <button type="submit" disabled={props.disabled || text.trim().length === 0}>
        Send
      </button>
    </form>
  );
};

export const ThreadList = (props: { conversations: readonly ConversationSummary[]; activeId?: string; onSelect: (id: string) => void; className?: string }): ReactNode => (
  <ul className={props.className}>
    {props.conversations.map((c) => (
      <li key={c.id}>
        <button type="button" aria-current={c.id === props.activeId} onClick={() => props.onSelect(c.id)}>
          {c.title}
        </button>
      </li>
    ))}
  </ul>
);

export const QuestionCard = (props: {
  part: Extract<MessagePart, { type: "question" }>;
  onAnswer: (answers: Record<string, string>) => void | Promise<void>;
  className?: string;
}): ReactNode => {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <div className={props.className} data-interaction="question">
      {props.part.questions.map((q) => (
        <label key={q.key}>
          {q.prompt}
          <input value={answers[q.key] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))} />
        </label>
      ))}
      <button type="button" onClick={() => void props.onAnswer(answers)}>
        Answer
      </button>
    </div>
  );
};

const DECISIONS: readonly ApprovalDecision[] = ["allow-once", "allow-conversation", "allow-always", "deny"];

export const ApprovalCard = (props: {
  part: Extract<MessagePart, { type: "approval" }>;
  onDecide: (decision: ApprovalDecision) => void | Promise<void>;
  t?: T;
  className?: string;
}): ReactNode => (
  <div className={props.className} data-interaction="approval">
    <p>{props.part.summary}</p>
    <span data-risk={props.part.riskCategory}>{props.part.toolName}</span>
    <div>
      {DECISIONS.map((d) => (
        <button key={d} type="button" onClick={() => void props.onDecide(d)}>
          {(props.t ?? identity)(`approval.decision.${d}`)}
        </button>
      ))}
    </div>
  </div>
);

/** Composed chat surface: thread list, transcript, live run state (status/retry), and composer. */
export const ChatShell = (props: {
  conversations: readonly ConversationSummary[];
  activeConversationId?: string;
  onSelectConversation: (id: string) => void;
  messages: readonly Message[];
  run?: RunView;
  onSend: (text: string) => void | Promise<void>;
  t?: T;
  className?: string;
}): ReactNode => (
  <div className={props.className} data-component="chat-shell">
    <ThreadList conversations={props.conversations} activeId={props.activeConversationId} onSelect={props.onSelectConversation} />
    <div>
      <MessageList messages={props.messages} t={props.t} />
      {props.run?.status ? <StatusBadge status={props.run.status} t={props.t} /> : null}
      {props.run?.retry ? <RetryIndicator retry={props.run.retry} t={props.t} /> : null}
      <Composer onSend={props.onSend} disabled={props.run?.status === "running"} />
    </div>
  </div>
);
