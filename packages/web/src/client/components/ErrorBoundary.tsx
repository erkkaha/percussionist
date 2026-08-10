import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  /** Rendered in place of the children when a child render throws. */
  fallback?: ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Small inline render-error boundary. Session payloads are proxied straight
 * from the runner without validation, so a single malformed part must not
 * unmount the whole page — this catches the render error, logs it, and shows
 * the fallback instead. Keep it tiny and explicit: it only wraps what it is
 * given, so it never over-catches beyond its subtree.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Do not swallow — surface the malformed part in the console.
    console.error('ErrorBoundary caught a render error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="rounded-lg border border-phase-failed/30 bg-phase-failed/10 p-4 text-sm text-phase-failed">
            Something went wrong rendering this section.
          </div>
        )
      );
    }
    return this.props.children;
  }
}
