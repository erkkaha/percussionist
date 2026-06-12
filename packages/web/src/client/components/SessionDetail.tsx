import { ArrowLeft, MessageSquare } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { Card } from './ui/card';

export default function SessionDetail() {
  const { name } = useParams<{ name: string }>();

  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <Link
          to="/sessions"
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text transition-colors"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to sessions
        </Link>
      </div>
      <div className="flex items-center gap-2.5 mb-4">
        <MessageSquare className="w-4 h-4 text-text-muted" />
        <h1 className="text-sm font-semibold text-text">Session</h1>
        {name && (
          <span className="font-mono text-xs text-text-muted">/{decodeURIComponent(name)}</span>
        )}
      </div>
      <Card className="p-8 flex flex-col items-center justify-center gap-2 min-h-[200px]">
        <MessageSquare className="w-8 h-8 opacity-30 text-text-muted" />
        <p className="text-sm text-text-muted">Session detail coming soon.</p>
      </Card>
    </div>
  );
}
