interface Recognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  start(): void;
  abort(): void;
}

interface ResultEvent extends Event {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type RecognitionConstructor = new () => Recognition;
const browser = window as Window & {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
};

export function speak(text: string, language: string, signal: AbortSignal): Promise<boolean> {
  if (!window.speechSynthesis || signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language;
    const finish = (spoken: boolean) => {
      signal.removeEventListener("abort", cancel);
      window.clearTimeout(timeout);
      resolve(spoken);
    };
    const cancel = () => {
      speechSynthesis.cancel();
      finish(false);
    };
    const timeout = window.setTimeout(cancel, Math.max(8000, text.length * 150));
    utterance.onend = () => finish(true);
    utterance.onerror = () => finish(false);
    signal.addEventListener("abort", cancel, { once: true });
    speechSynthesis.speak(utterance);
  });
}

export function listen(
  language: string,
  mode: "command" | "dictation",
  receive: (text: string, final: boolean) => void,
  ended: () => boolean,
  unavailable: () => void,
) {
  const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  if (!Constructor) {
    unavailable();
    return;
  }

  let active = true;
  let retry: number | undefined;
  let recognition: Recognition | undefined;
  const begin = () => {
    const current = new Constructor();
    recognition = current;
    current.lang = language;
    current.interimResults = true;
    current.addEventListener("result", event => {
      if (!active) return;
      const results = Array.from((event as ResultEvent).results);
      receive(results.map(result => result[0].transcript).join(" ").trim(),
        results.length > 0 && results.every(result => result.isFinal));
    });
    current.addEventListener("error", event => {
      if (!active || (event as Event & { error: string }).error === "no-speech") return;
      active = false;
      unavailable();
    });
    current.addEventListener("end", () => {
      if (!active) return;
      recognition = undefined;
      // Speech recognition has ended before we either consume dictation or restart.
      // Cancel clears any pending restart before the session speaks or ends.
      if (mode === "dictation" && ended()) return;
      if (active) retry = window.setTimeout(begin, 150);
    });
    try {
      current.start();
    } catch {
      active = false;
      unavailable();
    }
  };
  begin();
  return {
    cancel() {
      active = false;
      window.clearTimeout(retry);
      recognition?.abort();
    },
  };
}
