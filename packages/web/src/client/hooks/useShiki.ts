import { useEffect, useRef, useState } from 'react';
import type { Highlighter } from 'shiki';

// Module-scoped cache for the highlighter instance
let highlighterCache: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

const COMMON_LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'bash',
  'sh',
  'json',
  'python',
  'yaml',
  'markdown',
  'html',
  'css',
  'sql',
];

async function loadHighlighter(): Promise<Highlighter> {
  if (highlighterCache) {
    return highlighterCache;
  }

  if (highlighterPromise) {
    return highlighterPromise;
  }

  highlighterPromise = (async () => {
    const { createHighlighter } = await import('shiki');

    const highlighter = await createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: COMMON_LANGUAGES,
    });

    highlighterCache = highlighter;
    return highlighter;
  })();

  return highlighterPromise;
}

export function useShiki() {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(highlighterCache);
  const [isLoading, setIsLoading] = useState(!highlighterCache);
  const [error, setError] = useState<Error | null>(null);
  const loadRef = useRef(false);

  useEffect(() => {
    if (loadRef.current) return;
    loadRef.current = true;

    loadHighlighter()
      .then((h) => {
        setHighlighter(h);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load shiki:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      });
  }, []);

  const highlight = async (
    code: string,
    lang: string,
    theme: 'light' | 'dark' = 'dark',
  ): Promise<string> => {
    try {
      const h = highlighter || (await loadHighlighter());

      // Check if language is loaded
      const loadedLangs = h.getLoadedLanguages();
      if (!loadedLangs.includes(lang as string)) {
        // Try to load the language
        try {
          await h.loadLanguage(lang as string);
        } catch {
          // Language not available, fall back to plain text
          return `<pre><code>${escapeHtml(code)}</code></pre>`;
        }
      }

      const themeName = theme === 'dark' ? 'github-dark' : 'github-light';
      return h.codeToHtml(code, {
        lang,
        theme: themeName,
      });
    } catch (err) {
      console.error('Failed to highlight code:', err);
      return `<pre><code>${escapeHtml(code)}</code></pre>`;
    }
  };

  return { highlight, isLoading, error, highlighter };
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]!);
}
