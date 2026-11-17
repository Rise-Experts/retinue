/**
 * Icons for the assistant chat pane.
 *
 * The immo_finanz chat uses `lucide-react` plus a custom `Icon` component;
 * this app ships neither, so the handful actually needed are inlined here in
 * the same style as `src/components/icons.tsx` (24-unit viewBox, currentColor
 * stroke, round caps).
 */

type IconProps = { size?: number };

const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** Marks the tool-call group — immo's `Icon type="hammer"`. */
export function HammerIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <path d="M14.5 5.5 18 2l4 4-3.5 3.5" />
      <path d="M16.5 7.5 13 11" />
      <path d="m11.5 9.5-8 8a2.1 2.1 0 0 0 3 3l8-8Z" />
    </svg>
  );
}

/** Marks the reasoning group — immo's `Icon type="reasoning"`. */
export function ReasoningIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <path d="M12 4a4 4 0 0 0-4 4c-1.7.7-2.5 2.2-2.5 3.7 0 1.4.7 2.6 1.8 3.3-.2 1.9 1.3 3.5 3.2 3.5.6 0 1.1-.2 1.5-.4" />
      <path d="M12 4a4 4 0 0 1 4 4c1.7.7 2.5 2.2 2.5 3.7 0 1.4-.7 2.6-1.8 3.3.2 1.9-1.3 3.5-3.2 3.5-.6 0-1.1-.2-1.5-.4" />
      <path d="M12 4v14.1" />
    </svg>
  );
}

/** Marks the references group — immo's `Icon type="references"`. */
export function ReferencesIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

export function CopyIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S} strokeWidth={1.9}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

/** Shown on a tool chip whose call finished successfully. */
export function CheckIcon({ size = 10 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S} strokeWidth={3.2}>
      <path d="m4 12.5 5.5 5.5L20 6.5" />
    </svg>
  );
}

/** Shown on a tool chip whose call failed. */
export function CrossIcon({ size = 10 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S} strokeWidth={3.2}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/** Attach-file affordance in the composer. */
export function PaperclipIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>
      <path d="M20.4 12.6 12 21a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 19a2 2 0 0 1-3-3l8-8" />
    </svg>
  );
}
