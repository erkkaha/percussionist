import { useState, useEffect, useRef } from "react";
import { MessageCircle, X, Send, Loader2 } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

export default function AgentChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Check agent availability on mount
  useEffect(() => {
    fetch("/api/agent/status")
      .then((r) => r.json())
      .then((d) => setAvailable(d.available === true))
      .catch(() => setAvailable(false));
  }, []);

  // Load history when panel opens
  useEffect(() => {
    if (!open) return;
    fetch("/api/agent/chat/history")
      .then((r) => r.json())
      .then((d) => {
        if (d.history?.length) setMessages(d.history);
      })
      .catch(() => {});
  }, [open]);

  // SSE stream for real-time updates
  useEffect(() => {
    if (!open) return;
    const es = new EventSource("/api/agent/chat/stream");
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as ChatMessage;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === msg.role && last.text === msg.text) return prev;
          return [...prev, msg];
        });
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => { /* SSE will retry automatically */ };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [open]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { role: "user", text }]);

    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      if (data.response) {
        setMessages((prev) => [...prev, { role: "assistant", text: data.response }]);
      } else if (data.error) {
        setMessages((prev) => [...prev, { role: "system", text: `Error: ${data.error}` }]);
      }
    } catch (e) {
      setMessages((prev) => [...prev, { role: "system", text: `Error: ${(e as Error).message}` }]);
    } finally {
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
          className="fixed bottom-4 right-4 z-50 w-12 h-12 rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-700 flex items-center justify-center"
          title="Chat with manager agent"
        >
          <MessageCircle className="w-6 h-6" />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-4 right-4 z-50 w-96 h-[32rem] bg-white rounded-lg shadow-xl border border-gray-200 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50 rounded-t-lg">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${available === null ? "bg-yellow-400" : available ? "bg-green-500" : "bg-red-500"}`} />
              <span className="font-medium text-sm">Manager Agent</span>
            </div>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <p className="text-gray-400 text-sm text-center mt-8">
                Ask the manager agent about board state, task status, or cluster issues.
              </p>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white"
                      : msg.role === "system"
                        ? "bg-red-50 text-red-700 border border-red-200"
                        : "bg-gray-100 text-gray-900"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-gray-200 px-4 py-3">
            <form
              onSubmit={(e) => { e.preventDefault(); handleSend(); }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask the agent..."
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={sending}
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="rounded-md bg-blue-600 px-3 py-2 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
