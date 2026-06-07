import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { DrumLogo } from "../components/app-sidebar";
import { useAuth } from "../lib/auth";

export default function LoginPage() {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { login, token } = useAuth();
  const navigate = useNavigate();

  if (token) {
    navigate("/", { replace: true });
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/settings", {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (res.ok) {
        login(trimmed);
        navigate("/", { replace: true });
      } else if (res.status === 401) {
        setError("Invalid token");
      } else {
        setError(`Unexpected response (HTTP ${res.status})`);
      }
    } catch {
      setError("Could not connect to server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <DrumLogo playing={false} size={64} />
          <h1 className="text-lg font-semibold text-text">Percussionist</h1>
          <p className="text-sm text-text-dim">Enter the auth token to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Auth token"
            autoFocus
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-accent/60 focus:outline-none"
          />

          {error && (
            <p className="text-sm text-phase-failed">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-md bg-accent text-on-primary px-3 py-2 text-sm font-medium hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            {loading ? "Verifying..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
