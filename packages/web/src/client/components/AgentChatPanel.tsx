import { useState, useEffect, useRef, useCallback } from "react";
import { X, Send, Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { DrumLogo } from "./app-sidebar";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

type SpeechRecognitionType = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onresult: ((e: unknown) => void) | null;
  start: () => void;
  stop: () => void;
};

const SpeechRecognitionAPI =
  typeof window !== "undefined"
    ? ((window as unknown as { SpeechRecognition?: SpeechRecognitionType; webkitSpeechRecognition?: SpeechRecognitionType }).SpeechRecognition ||
       (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionType }).webkitSpeechRecognition)
    : null;

function messageKey(m: ChatMessage): string {
  return `${m.role}\0${m.text}`;
}

export default function AgentChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [recording, setRecording] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const seenKeysRef = useRef<Set<string>>(new Set());
  const speakEnabledRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const sttSupported = !!SpeechRecognitionAPI;

function sanitizeForSpeech(text: string): string {
  return text
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{231A}-\u{231B}\u{2328}\u{2934}\u{2935}\u{25AA}\u{25AB}\u{25FB}-\u{25FE}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu, "")
    .replace(/[*_~`#>\-|]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s{3,}/g, " ")
    .trim();
}

  const speak = useCallback((text: string) => {
    if (!ttsEnabled || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(sanitizeForSpeech(text));
    utterance.lang = "en-US";
    utterance.rate = 1.1;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }, [ttsEnabled]);

  const addMessageIfNew = useCallback((msg: ChatMessage) => {
    const key = messageKey(msg);
    if (seenKeysRef.current.has(key)) return;
    seenKeysRef.current.add(key);
    setMessages((prev) => [...prev, msg]);
    if (msg.role === "assistant" && speakEnabledRef.current) {
      setTimeout(() => speak(msg.text), 300);
    }
  }, [speak]);

  const resetSeen = useCallback(() => {
    seenKeysRef.current = new Set();
    speakEnabledRef.current = false;
  }, []);

  const startRecording = useCallback(() => {
    if (!sttSupported || recording) return;
    const SpeechRecognition = SpeechRecognitionAPI;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => setRecording(true);
    recognition.onend = () => setRecording(false);
    recognition.onerror = () => setRecording(false);

    recognition.onresult = (event: unknown) => {
      const e = event as { results: { length: number; [i: number]: { isFinal: boolean; [i: number]: { transcript: string } } } };
      const results = e.results;
      if (!results || results.length === 0) return;
      const result = results[results.length - 1];
      if (!result) return;
      if (result.isFinal) {
        const transcript = result[0];
        if (transcript) {
          setInput((prev) => prev + transcript.transcript);
        }
      }
    };

    recognition.start();
    recognitionRef.current = recognition;
  }, [sttSupported, recording]);

  const stopRecording = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }, []);

  // Check agent availability on mount with polling
  useEffect(() => {
    function check() {
      fetch("/api/agent/status")
        .then((r) => r.json())
        .then((d) => setAvailable(d.available === true))
        .catch(() => setAvailable(false));
    }
    check();
    const id = setInterval(check, 10_000);
    return () => clearInterval(id);
  }, []);

  // Load history when panel opens
  useEffect(() => {
    if (!open) return;
    setHistoryLoaded(false);
    resetSeen();
    fetch("/api/agent/chat/history")
      .then((r) => r.json())
      .then((d) => {
        if (d.history?.length) {
          setMessages(d.history);
          for (const m of d.history) {
            seenKeysRef.current.add(messageKey(m as ChatMessage));
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        speakEnabledRef.current = true;
        setHistoryLoaded(true);
      });
  }, [open, resetSeen]);

  // SSE stream for real-time updates — only open after history is loaded to avoid race
  useEffect(() => {
    if (!open || !historyLoaded) return;
    const es = new EventSource("/api/agent/chat/stream");
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as ChatMessage;
        addMessageIfNew(msg);
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => { /* SSE will retry automatically */ };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [open, historyLoaded, addMessageIfNew]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Cleanup speech and recognition on close/unmount
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      recognitionRef.current?.stop();
    };
  }, []);

  function handleCancel() {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    addMessageIfNew({ role: "user", text });

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
        signal: ac.signal,
      });
      const data = await res.json();
      if (data.cancelled) {
        addMessageIfNew({ role: "system", text: "Request cancelled." });
      } else if (data.response) {
        addMessageIfNew({ role: "assistant", text: data.response });
      } else if (data.error) {
        addMessageIfNew({ role: "system", text: `Error: ${data.error}` });
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        addMessageIfNew({ role: "system", text: "Request cancelled." });
      } else {
        addMessageIfNew({ role: "system", text: `Error: ${err.message}` });
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setSending(false);
    }
  }

  if (available === false) return null;

  return (
    <>
      {/* Toggle button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-4 right-4 z-50 w-12 h-12 rounded-md bg-accent text-surface shadow-lg hover:bg-accent/80 flex items-center justify-center"
          title="Chat with manager agent"
        >
          <DrumLogo playing={false} size={40} />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed z-50 bg-surface shadow-xl border border-border flex flex-col inset-0 w-full h-dvh sm:inset-auto sm:bottom-4 sm:right-4 sm:w-96 sm:h-[32rem] sm:rounded-lg">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface-raised sm:rounded-t-lg">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${available === null ? "bg-phase-pending" : available ? "bg-phase-succeeded" : "bg-phase-failed"}`} />
              <span className="font-medium text-sm text-text">Manager Agent</span>
            </div>
            <button onClick={() => setOpen(false)} className="text-text-dim hover:text-text-muted transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <p className="text-text-dim text-sm text-center mt-8">
                Ask the manager agent about board state, task status, or cluster issues.
              </p>
            )}
            {messages.map((msg, i) => (
              <div key={`${messageKey(msg)}-${i}`} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                    msg.role === "user"
                      ? "bg-accent/15 text-text border border-accent/30"
                      : msg.role === "system"
                        ? "bg-phase-failed/10 text-phase-failed border border-phase-failed/30"
                        : "bg-surface-raised text-text border border-border-muted"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-lg px-3 py-2 bg-surface-raised border border-border-muted text-sm text-text-dim">
                  <span>Thinking…</span>
                  <span className="text-border-muted">·</span>
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="text-xs text-phase-failed/70 hover:text-phase-failed transition-colors"
                  >
                    cancel
                  </button>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-border px-4 py-3">
            <form
              onSubmit={(e) => { e.preventDefault(); handleSend(); }}
              className="flex gap-2 items-end"
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 160) + "px";
                }}
                placeholder="Ask the agent..."
                rows={1}
                readOnly={sending}
                className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-accent/60 focus:outline-none resize-none overflow-y-auto max-h-[160px]"
              />
              {sttSupported && (
                <button
                  type="button"
                  onClick={recording ? stopRecording : startRecording}
                  className={`p-2 rounded-md transition-colors ${
                    recording
                      ? "bg-phase-failed/20 text-phase-failed animate-pulse"
                      : "hover:bg-surface-raised text-text-dim hover:text-text"
                  }`}
                  title={recording ? "Stop recording" : "Voice input"}
                >
                  {recording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setTtsEnabled((v) => {
                    if (v && typeof window !== "undefined" && "speechSynthesis" in window) {
                      window.speechSynthesis.cancel();
                    }
                    return !v;
                  });
                }}
                className={`p-2 rounded-md transition-colors hover:bg-surface-raised ${
                  ttsEnabled ? "text-accent" : "text-text-dim"
                }`}
                title={ttsEnabled ? "Disable voice" : "Enable voice"}
              >
                {ttsEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </button>
              {sending ? (
                <div className="flex items-center justify-center w-[2.375rem] h-[2.375rem]">
                  <DrumLogo playing={true} size={32} />
                </div>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  className="rounded-md bg-phase-pending text-on-primary px-3 py-2 text-sm font-medium hover:bg-phase-pending/80 disabled:cursor-not-allowed transition-colors"
                >
                  <Send className="w-4 h-4" />
                </button>
              )}
            </form>
          </div>
        </div>
      )}
    </>
  );
}
