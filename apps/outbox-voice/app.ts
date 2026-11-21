import { commitAnswer, readOutbox } from "./commit.ts";
import type { Repository } from "./commit.ts";
import { audioEntries } from "./parse.ts";
import type { Entry } from "./parse.ts";
import { listen, speak } from "./speech.ts";

type Settings = Repository & { language: string };
type State = "idle" | "reading" | "command" | "dictating" | "confirming" | "saving";
const storage = "outbox-voice.settings";
const sharedPagesOrigin = /(?:^|\.)github\.io$/i.test(location.hostname);
const form = document.querySelector<HTMLFormElement>("form")!;
const status = document.querySelector<HTMLElement>("#status")!;
const entryView = document.querySelector<HTMLElement>("#entry")!;
const buttons = document.querySelector<HTMLElement>("#commands")!;
const transcriptInput = document.querySelector<HTMLInputElement>("#transcript")!;
const startButton = document.querySelector<HTMLButtonElement>("#start")!;
const commands = ["next", "repeat", "details", "answer", "skip", "done"];
const confirmation = ["commit", "redo", "discard", "done"];
const fields = ["repo", "branch", "token", "language"] as const;
let settings: Settings = { repo: "", branch: "master", token: "", language: "en-US" };
let state: State = "idle";
let session: AbortController | undefined;
let mic: ReturnType<typeof listen>;
let wakeLock: WakeLockSentinel | undefined;
let entries: Entry[] = [];
let position = 0;
let pending = "";
let heardReadback = false;
let editing = false;

try {
  const saved = JSON.parse(localStorage.getItem(storage) ?? "{}");
  for (const key of fields) {
    if (typeof saved?.[key] === "string" && (key !== "token" || !sharedPagesOrigin)) {
      settings[key] = saved[key];
    }
  }
} catch {
  status.textContent = "Saved settings could not be read.";
}
for (const key of fields) form.querySelector<HTMLInputElement>(`[name="${key}"]`)!.value = settings[key];

form.addEventListener("submit", event => {
  event.preventDefault();
  if (state !== "idle") return;
  for (const key of fields) settings[key] = String(new FormData(form).get(key)).trim();
  try {
    const { token, ...nonSecret } = settings;
    localStorage.setItem(storage, JSON.stringify(sharedPagesOrigin ? nonSecret : { ...nonSecret, token }));
    status.textContent = sharedPagesOrigin ? "Settings saved. The token is held for this visit." : "Settings saved.";
  } catch {
    status.textContent = "Settings are available for this visit.";
  }
});

function render(next: State, message: string) {
  state = next;
  status.textContent = message;
  startButton.disabled = next !== "idle";
  form.querySelector<HTMLFieldSetElement>("fieldset")!.disabled = next !== "idle";
  transcriptInput.parentElement!.hidden = next !== "dictating";
  const options = next === "command" ? commands
    : next === "confirming" ? confirmation
    : next === "dictating" ? ["stop", "done"]
    : next === "reading" ? ["done"] : [];
  buttons.replaceChildren(...options.map(command => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = command[0].toUpperCase() + command.slice(1);
    button.addEventListener("click", () => void act(command));
    return button;
  }));
}

function haltMic() {
  mic?.cancel();
  mic = undefined;
}

async function acquireWakeLock() {
  const current = session;
  if (!current || wakeLock || document.visibilityState !== "visible") return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (session !== current || wakeLock) {
      await lock.release();
      return;
    }
    wakeLock = lock;
    lock.addEventListener("release", () => {
      if (wakeLock === lock) wakeLock = undefined;
    });
  } catch {
    // Browsers can refuse a screen wake lock.
  }
}
document.addEventListener("visibilitychange", () => void acquireWakeLock());

function finish(message: string) {
  haltMic();
  session?.abort();
  session = undefined;
  void wakeLock?.release().catch(() => {});
  wakeLock = undefined;
  entries = [];
  pending = "";
  transcriptInput.value = "";
  entryView.textContent = "";
  render("idle", message);
}

function voiceUnavailable() {
  status.textContent += " Microphone unavailable. Use the on-screen controls.";
}

function listenFor(options: string[]) {
  mic = listen(settings.language, "command", (text, final) => {
    const command = text.replace(/[.!?]+$/, "").trim().toLowerCase();
    if (options.includes(command) && (command !== "commit" || final)) void act(command);
  }, () => false, voiceUnavailable);
}

async function say(text: string) {
  const current = session;
  if (!current) return false;
  await speak(text, settings.language, current.signal);
  return session === current;
}

async function readEntry(prefix = "", details = false) {
  const entry = entries[position];
  render("reading", prefix || "Reading entry.");
  if (!entry) {
    if (await say([prefix, "Session complete."].filter(Boolean).join(" "))) finish("Session complete.");
    return;
  }
  entryView.textContent = entry.raw;
  const description = details ? entry.raw : `Entry ${entry.id}. ${entry.type}. ${entry.project}. ${entry.speak}`;
  if (await say([prefix, description, "Say next, repeat, details, answer, skip, or done."].filter(Boolean).join(" "))) {
    render("command", "Choose a command.");
    listenFor(commands);
  }
}

async function dictate() {
  pending = "";
  editing = false;
  transcriptInput.value = "";
  render("reading", "Starting dictation.");
  if (!await say("Dictate your answer. Pause or say stop when finished.")) return;
  render("dictating", "Dictate or type your answer.");
  mic = listen(settings.language, "dictation", (text, final) => {
    if (editing) return;
    const stop = /(?:^|\s)stop[.!?]?$/i.test(text);
    transcriptInput.value = stop ? text.replace(/(?:^|\s)stop[.!?]?$/i, "").trimEnd() : text;
    if (stop && final) void act("stop");
  }, () => {
    if (!transcriptInput.value.trim()) return false;
    void confirmAnswer();
    return true;
  }, voiceUnavailable);
}

transcriptInput.addEventListener("input", () => {
  editing = true;
  haltMic();
});

async function confirmAnswer() {
  if (state !== "dictating") return;
  const text = transcriptInput.value.trim();
  if (!text) return;
  haltMic();
  pending = text;
  render("reading", "Reading back your answer.");
  const current = session;
  if (!current) return;
  const spoken = await speak(`Your answer was: ${pending}. Say commit, redo, or discard.`, settings.language, current.signal);
  if (session !== current) return;
  heardReadback = spoken;
  showConfirmation(`Your answer: ${pending}`);
}

function showConfirmation(message: string) {
  render("confirming", heardReadback ? message : `Audio read-back unavailable. Review the answer on screen. ${message}`);
  listenFor(heardReadback ? confirmation : confirmation.filter(command => command !== "commit"));
}

async function act(command: string) {
  if (command === "done" && state !== "saving" && state !== "idle") {
    finish("Session ended.");
    return;
  }
  const current = state;
  if (current === "dictating" && command === "stop") {
    if (transcriptInput.value.trim()) await confirmAnswer();
    else {
      haltMic();
      await readEntry("No answer captured.");
    }
    return;
  }
  if (current === "command" && commands.includes(command)) {
    haltMic();
    if (command === "answer") await dictate();
    else {
      if (command === "next" || command === "skip") position++;
      await readEntry("", command === "details");
    }
    return;
  }
  if (current !== "confirming" || !confirmation.includes(command)) return;
  haltMic();
  if (command === "redo") await dictate();
  else if (command === "discard") {
    pending = "";
    await readEntry("Answer discarded.");
  } else if (command === "commit") {
    render("saving", "Saving answer.");
    let result: Awaited<ReturnType<typeof commitAnswer>>;
    try {
      result = await commitAnswer(settings, entries[position], pending);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save the answer.";
      if (await say(`${message} Say commit, redo, or discard.`)) {
        showConfirmation(`${message} Your answer: ${pending}`);
      }
      return;
    }
    pending = "";
    position++;
    await readEntry(result === "committed" ? "Answer committed." : "That entry changed or is no longer available.");
  }
}

startButton.addEventListener("click", async () => {
  if (state !== "idle") return;
  if (!settings.repo || !settings.branch || !settings.token || !settings.language) {
    status.textContent = "Save your repository, branch, token, and language in Settings first.";
    form.closest("details")!.open = true;
    return;
  }
  const current = new AbortController();
  session = current;
  position = 0;
  render("reading", "Loading outbox.");
  void acquireWakeLock();
  try {
    const [, { text }] = await Promise.all([say("Loading outbox."), readOutbox(settings)]);
    if (session !== current) return;
    entries = audioEntries(text);
    await readEntry(`${entries.length} ${entries.length === 1 ? "entry" : "entries"} ready.`);
  } catch (error) {
    if (session === current) finish(error instanceof Error ? error.message : "Could not load the outbox.");
  }
});
