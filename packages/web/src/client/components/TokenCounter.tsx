function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface TokenCounterProps {
  tokensIn?: number;
  tokensOut?: number;
}

export default function TokenCounter({ tokensIn, tokensOut }: TokenCounterProps) {
  if (tokensIn == null && tokensOut == null) {
    return <span className="text-text-dim">-</span>;
  }
  return (
    <span className="inline-flex items-center gap-2 text-sm tabular-nums">
      <span className="text-text-muted" title="Tokens in (input)">
        <span className="text-text-dim mr-0.5">in</span>
        {formatNumber(tokensIn ?? 0)}
      </span>
      <span className="text-text-dim">/</span>
      <span className="text-text-muted" title="Tokens out (output)">
        <span className="text-text-dim mr-0.5">out</span>
        {formatNumber(tokensOut ?? 0)}
      </span>
    </span>
  );
}
