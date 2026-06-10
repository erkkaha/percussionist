import { useState, useEffect, useRef, useCallback } from "react";
import { Send, Mic, MicOff, Volume2, VolumeX, X } from "lucide-react";
import { DrumLogo } from "./app-sidebar";
import { authHeaders, getToken } from "../lib/auth";
import type { Task } from "@/lib/types";
import { useIsMobile } from "@/hooks/use-mobile";
import { parseOptionBlocks } from "@/lib/chat-utils";
import ChatOptionCard from "./ChatOptionCard";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
  id?: string;
  created?: number;
}

function formatTaskContext(task: Task, projectName: string): string {
  const lines: string[] = [];
  lines.push(`@task ${task.metadata.name} (project: ${projectName})`);
  lines.push(`Title: ${task.spec.title}`);
  if (task.spec.description) lines.push(`Description: ${task.spec.description}`);
  lines.push(`Type: ${task.spec.type}`);
  lines.push(`Priority: ${task.spec.priority ?? "medium"}`);
  lines.push(`Status: ${task.status?.phase ?? "unknown"}`);
  if (task.spec.agent) lines.push(`Agent: ${task.spec.agent}`);
  if (task.spec.parentTaskRef) lines.push(`Parent: ${task.spec.parentTaskRef}`);
  return lines.join("\n");
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

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function messageKey(m: ChatMessage): string {
  return `${m.role}\0${m.text}`;
}

interface AgentChatPanelProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onChatReady?: (api: { injectTask: (task: Task, projectName: string) => void }) => void;
}

export default function AgentChatPanel({ open, onOpenChange, onChatReady }: AgentChatPanelProps) {
  const isMobile = useIsMobile();
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
  const speakAfterCreatedRef = useRef(0);
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
    if (msg.role !== "assistant") return;
    const isNew = msg.created != null && msg.created > speakAfterCreatedRef.current;
    if (isNew || speakEnabledRef.current) {
      setTimeout(() => speak(msg.text), 300);
    }
  }, [speak]);

  const resetSeen = useCallback(() => {
    seenKeysRef.current = new Set();
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
      fetch("/api/agent/status", { headers: authHeaders() })
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
    setMessages([]);
    speakAfterCreatedRef.current = 0;
    fetch("/api/agent/chat/history", { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        const history = d.history as ChatMessage[] | undefined;
        setMessages(history ?? []);
        let maxCreated = 0;
        for (const m of history ?? []) {
          seenKeysRef.current.add(messageKey(m));
          if (m.created && m.created > maxCreated) maxCreated = m.created;
        }
        speakAfterCreatedRef.current = maxCreated;
      })
      .catch(() => {})
      .finally(() => setHistoryLoaded(true));
  }, [open, resetSeen]);

  // SSE stream for real-time updates — only open after history is loaded to avoid race
  useEffect(() => {
    if (!open || !historyLoaded) return;
    const token = getToken();
    const streamUrl = token ? `/api/agent/chat/stream?token=${encodeURIComponent(token)}` : "/api/agent/chat/stream";
    const es = new EventSource(streamUrl);
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

  const sendText = useCallback(async (text: string) => {
    if (!text || sending) return;
    speakEnabledRef.current = true;
    setSending(true);
    addMessageIfNew({ role: "user", text });

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
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
  }, [sending, addMessageIfNew]);

  // Register chat API for external injection (called from board)
  useEffect(() => {
    if (!onChatReady) return;
    onChatReady({
      injectTask(task, projectName) {
        onOpenChange?.(true);
        const msg = formatTaskContext(task, projectName);
        sendText(msg);
      },
    });
    return () => onChatReady({ injectTask: () => {} });
  }, [onChatReady, sendText, onOpenChange]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    await sendText(text);
  }

  return (
    <>
      {available !== false && !open && (
        <button
          onClick={() => onOpenChange?.(true)}
          className="fixed bottom-4 right-4 z-50 w-12 h-12 rounded-md bg-accent text-surface shadow-lg hover:bg-accent/80 flex items-center justify-center"
          title="Chat with manager agent"
        >
          <DrumLogo playing={false} size={40} />
        </button>
      )}

      {open && (
        <div className={`${isMobile ? "fixed inset-0 z-[60] flex flex-col bg-background" : "w-96 flex-shrink-0 border-l border-border flex flex-col bg-background max-h-screen sticky top-0"}`}>
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surface-raised">
            <div className={`w-2 h-2 rounded-full ${available === null ? "bg-phase-pending" : available ? "bg-phase-succeeded" : "bg-phase-failed"}`} />
            <span className="font-medium text-sm text-text">Manager Agent</span>
            <button
              onClick={() => onOpenChange?.(false)}
              className="ml-auto rounded-sm opacity-70 hover:opacity-100 transition-opacity text-text-dim hover:text-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <p className="text-text-dim text-sm text-center mt-8">
                Ask the manager agent about board state, task status, or cluster issues.
              </p>
            )}
            {messages.map((msg, i) => {
              // Parse option blocks for assistant messages
              let cleanText = msg.text;
              let options: Array<{ key: string; label: string; description?: string }> = [];
              
              if (msg.role === "assistant") {
                const result = parseOptionBlocks(msg.text);
                cleanText = result.cleanText;
                options = result.options;
              }
              
              return (
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
                    {cleanText && <div>{cleanText}</div>}
                    {msg.role === "assistant" && options.length > 0 && (
                      <ChatOptionCard
                        options={options}
                        onSelect={(key) => sendText(`I choose option [${key}]`)}
                        disabled={sending}
                      />
                    )}
                    {msg.created && (
                      <div className="text-caption-xs text-text-dim/60 mt-1 leading-none">{timeAgo(msg.created)}</div>
                    )}
                  </div>
                </div>
              );
            })}
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
