import { MessageSquare } from 'lucide-react';
import { Card } from './ui/card';

export default function SessionList() {
  return (
    <div className="p-6">
      <div className="flex items-center gap-2.5 mb-4">
        <MessageSquare className="w-4 h-4 text-text-muted" />
        <h1 className="text-sm font-semibold text-text">Sessions</h1>
      </div>
      <Card className="p-8 flex flex-col items-center justify-center gap-2 min-h-[200px]">
        <MessageSquare className="w-8 h-8 opacity-30 text-text-muted" />
        <p className="text-sm text-text-muted">Session list coming soon.</p>
      </Card>
    </div>
  );
}
