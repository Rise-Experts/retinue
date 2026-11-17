"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Press-and-hold dictation for the chat box — #549.
 *
 * The browser's own speech recognition (`SpeechRecognition`, `webkitSpeechRecognition` in Chrome and
 * Safari), so nothing is uploaded by this app and nothing costs credits. Where the browser has none the
 * hook reports `supported: false` and the button is not drawn — a microphone that does nothing is worse
 * than no microphone.
 *
 * The language is the person's choice from the chevron beside the button, remembered per browser.
 */
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

const LANG_KEY = "chorus.dictation.lang";
export const DICTATION_LANGS = ["en-US", "de-DE"] as const;
export type DictationLang = (typeof DICTATION_LANGS)[number];

const constructorOf = (): (new () => Recognition) | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

const noop = () => () => {};

export function useDictation(onText: (text: string) => void, fallbackLang: DictationLang) {
  // Server render: unsupported; the client re-renders with the real answer and no hydration warning.
  const supported = useSyncExternalStore(noop, () => constructorOf() !== null, () => false);
  const [listening, setListening] = useState(false);
  const [lang, setLangState] = useState<DictationLang>(fallbackLang);
  const recognition = useRef<Recognition | null>(null);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LANG_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a one-shot read of a browser preference after hydration
      if ((DICTATION_LANGS as readonly string[]).includes(stored ?? "")) setLangState(stored as DictationLang);
    } catch {
      // Private windows throw; the fallback language stands.
    }
  }, []);

  const setLang = useCallback((next: DictationLang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(LANG_KEY, next);
    } catch {
      // Not remembered; still used for this session.
    }
  }, []);

  const start = useCallback(() => {
    const Ctor = constructorOf();
    if (Ctor === null || recognition.current !== null) return;
    const r = new Ctor();
    r.lang = lang;
    r.interimResults = false;
    r.continuous = true;
    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]!;
        if (result.isFinal) onTextRef.current(result[0].transcript.trim());
      }
    };
    r.onerror = () => {
      recognition.current = null;
      setListening(false);
    };
    r.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    recognition.current = r;
    setListening(true);
    r.start();
  }, [lang]);

  const stop = useCallback(() => {
    recognition.current?.stop();
  }, []);

  useEffect(() => () => recognition.current?.stop(), []);

  return { supported, listening, lang, setLang, start, stop };
}
