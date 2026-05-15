import { useState, useEffect } from "react";
import { Copy, Check } from "lucide-react";
import { useShiki } from "../hooks/useShiki";

interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  theme?: "light" | "dark";
}

export function CodeBlock({
  code,
  language = "text",
  showLineNumbers = false,
  theme = "dark",
}: CodeBlockProps) {
  const { highlight, isLoading } = useShiki();
  const [html, setHtml] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isLoading) return;

    highlight(code, language, theme)
      .then((highlighted) => {
        setHtml(highlighted);
      })
      .catch((err) => {
        console.error("Failed to highlight code:", err);
        setHtml(`<pre><code>${escapeHtml(code)}</code></pre>`);
      });
  }, [code, language, theme, highlight, isLoading]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy code:", err);
    }
  };

  const lineCount = code.split("\n").length;
  const shouldShowLineNumbers = showLineNumbers || lineCount > 10;

  if (isLoading) {
    return (
      <div className="relative rounded-lg bg-surface-sunken p-4 animate-pulse">
        <div className="h-4 w-3/4 bg-surface-overlay rounded mb-2" />
        <div className="h-4 w-1/2 bg-surface-overlay rounded mb-2" />
        <div className="h-4 w-2/3 bg-surface-overlay rounded" />
      </div>
    );
  }

  return (
    <div className="relative group rounded-lg overflow-hidden my-2">
      {/* Header with language badge and copy button */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-sunken border-b border-border-muted">
        <span className="text-xs font-mono text-text-dim uppercase tracking-wide">
          {language}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text-dim hover:text-text hover:bg-surface-overlay/50 transition-colors"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                Copy
              </span>
            </>
          )}
        </button>
      </div>

      {/* Code content */}
      <div
        className={`overflow-x-auto text-xs ${
          shouldShowLineNumbers ? "code-with-line-numbers" : ""
        }`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m]!);
}
