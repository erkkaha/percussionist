import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Link, useParams } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { fetchPlan } from '../lib/api';
import { CodeBlock } from './CodeBlock';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

export default function PlanView() {
  const { name: projectName, taskId } = useParams<{ name: string; taskId: string }>();

  const { data, error, isLoading } = useQuery({
    queryKey: ['plan', projectName, taskId],
    queryFn: () => fetchPlan(projectName ?? '', taskId ?? ''),
    enabled: !!projectName && !!taskId,
  });

  if (error) {
    return (
      <div className="space-y-4">
        <Link
          to={`/projects/${encodeURIComponent(projectName ?? '')}/board`}
          className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Board
        </Link>
        <Card className="border-phase-failed/30 bg-phase-failed/10">
          <CardHeader>
            <CardTitle className="text-phase-failed">Failed to load plan</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-phase-failed">{error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Link
          to={`/projects/${encodeURIComponent(projectName ?? '')}/board`}
          className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Board
        </Link>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3 text-text-dim">
              <div className="animate-spin h-5 w-5 border-2 border-text-dim border-t-transparent rounded-full" />
              <span>Loading plan...</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Back navigation */}
      <Link
        to={`/projects/${encodeURIComponent(projectName ?? '')}/board`}
        className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Board
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-headline-lg text-text mb-1">Plan: {taskId}</h1>
          <p className="text-caption-xs text-text-dim">Project: {projectName}</p>
        </div>
      </div>

      {/* Plan content */}
      <Card>
        <CardHeader className="border-b border-border-muted">
          <CardTitle className="text-label-md font-mono uppercase text-text-dim">
            Plan Content
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <div style={{ fontSize: '12px', lineHeight: '1.5' }} className="max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => <p className="my-0">{children}</p>,
                pre: ({ children }) => <div className="mb-2">{children}</div>,
                code: ({ children, className }) => {
                  const lang = className?.replace('language-', '') ?? '';
                  const code = String(children).replace(/\n$/, '');
                  if (lang || code.includes('\n')) {
                    return (
                      <div className="mb-2">
                        <CodeBlock code={code} language={lang} />
                      </div>
                    );
                  }
                  return (
                    <span className="bg-surface-sunken rounded px-1 py-0.5 text-xs font-mono">
                      {children}
                    </span>
                  );
                },
                h1: ({ children }) => <h1 className="text-2xl font-bold mt-4 mb-1">{children}</h1>,
                h2: ({ children }) => (
                  <h2 className="text-xl font-semibold mt-3 mb-1">{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-lg font-semibold mt-2 mb-1">{children}</h3>
                ),
                h4: ({ children }) => (
                  <h4 className="text-base font-semibold mt-2 mb-0.5">{children}</h4>
                ),
                ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
                li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                hr: () => <hr className="my-3 border-border-muted" />,
              }}
            >
              {data.content}
            </ReactMarkdown>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
