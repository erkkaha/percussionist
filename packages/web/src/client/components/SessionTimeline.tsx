import { useState, useEffect } from "react";
import {
  MessageSquare,
  Wrench,
  FileEdit,
  CheckSquare,
  Menu,
  X,
} from "lucide-react";
import type { SessionMessage, ToolPart, FilePart, SubtaskPart } from "../lib/types";

interface TimelineItem {
  id: string;
  type: "message" | "tool" | "file" | "subtask";
  timestamp: Date;
  summary: string;
  status?: "pending" | "running" | "completed" | "error";
}

interface SessionTimelineProps {
  messages: SessionMessage[];
  currentMessageId?: string | null;
  onMessageClick: (id: string) => void;
}

function getRelativeTime(date: Date): string {
  const now = Date.now();
  const timestamp = date.getTime();
  const diffMs = now - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function extractTimelineItems(messages: SessionMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const msg of messages) {
    const timestamp = new Date(msg.info.time.created);

    // Add main message
    items.push({
      id: msg.info.id,
      type: "message",
      timestamp,
      summary:
        msg.info.role === "user"
          ? "User message"
          : "Assistant message",
    });

    // Add tool calls
    const toolParts = msg.parts.filter((p): p is ToolPart => p.type === "tool");
    for (const tool of toolParts) {
      items.push({
        id: tool.id,
        type: "tool",
        timestamp,
        summary: `${tool.tool}`,
        status: tool.state?.status || "pending",
      });
    }

    // Add file parts
    const fileParts = msg.parts.filter((p): p is FilePart => p.type === "file");
    for (const file of fileParts) {
      items.push({
        id: file.id,
        type: "file",
        timestamp,
        summary: file.filename || "File changed",
      });
    }

    // Add subtask parts
    const subtaskParts = msg.parts.filter((p): p is SubtaskPart => p.type === "subtask");
    for (const subtask of subtaskParts) {
      const completed = subtask.todos?.filter((t) => t.status === "completed").length || 0;
      const total = subtask.todos?.length || 0;
      items.push({
        id: subtask.id,
        type: "subtask",
        timestamp,
        summary: `${completed}/${total} tasks done`,
      });
    }
  }

  return items;
}

export function SessionTimeline({
  messages,
  currentMessageId,
  onMessageClick,
}: SessionTimelineProps) {
  const [collapsed, setCollapsed] = useState(() => {
    // Default collapsed on mobile
    const isMobile = window.innerWidth < 768;
    const saved = localStorage.getItem("percussionist:timeline:collapsed");
    return saved ? saved === "true" : isMobile;
  });

  useEffect(() => {
    localStorage.setItem("percussionist:timeline:collapsed", String(collapsed));
  }, [collapsed]);

  const items = extractTimelineItems(messages);

  if (collapsed) {
    return (
      <div className="flex flex-col w-16 border-r border-border-muted bg-surface">
        <button
          onClick={() => setCollapsed(false)}
          className="flex items-center justify-center h-12 border-b border-border-muted hover:bg-surface-overlay transition-colors"
          title="Expand timeline"
        >
          <Menu className="h-5 w-5 text-text-dim" />
        </button>
        <div className="flex-1 overflow-y-auto">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => onMessageClick(item.id)}
              className={`w-full p-3 flex items-center justify-center border-b border-border-muted hover:bg-surface-overlay transition-colors ${
                item.id === currentMessageId
                  ? "bg-surface-overlay border-l-2 border-accent"
                  : ""
              }`}
              title={item.summary}
            >
              {item.type === "message" && (
                <MessageSquare className="h-4 w-4 text-text-dim" />
              )}
              {item.type === "tool" && (
                <Wrench
                  className={`h-4 w-4 ${
                    item.status === "completed"
                      ? "text-phase-succeeded"
                      : item.status === "error"
                        ? "text-phase-failed"
                        : item.status === "running"
                          ? "text-accent animate-pulse"
                          : "text-text-dim"
                  }`}
                />
              )}
              {item.type === "file" && (
                <FileEdit className="h-4 w-4 text-purple-600 dark:text-purple-400" />
              )}
              {item.type === "subtask" && (
                <CheckSquare className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-64 border-l border-border-muted bg-surface">
      <div className="flex items-center justify-between h-12 px-4 border-b border-border-muted">
        <span className="text-body-sm font-semibold text-text">
          Activity
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1 hover:bg-surface-overlay rounded transition-colors"
          title="Collapse timeline"
        >
          <X className="h-4 w-4 text-text-dim" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onMessageClick(item.id)}
            className={`w-full p-3 flex items-start gap-3 border-b border-border-muted hover:bg-surface-overlay transition-colors text-left ${
              item.id === currentMessageId
                ? "bg-surface-overlay border-l-2 border-accent"
                : ""
            }`}
          >
            <div className="flex-shrink-0 mt-0.5">
              {item.type === "message" && (
                <MessageSquare className="h-4 w-4 text-text-dim" />
              )}
              {item.type === "tool" && (
                <Wrench
                  className={`h-4 w-4 ${
                    item.status === "completed"
                      ? "text-phase-succeeded"
                      : item.status === "error"
                        ? "text-phase-failed"
                        : item.status === "running"
                          ? "text-accent animate-pulse"
                          : "text-text-dim"
                  }`}
                />
              )}
              {item.type === "file" && (
                <FileEdit className="h-4 w-4 text-purple-600 dark:text-purple-400" />
              )}
              {item.type === "subtask" && (
                <CheckSquare className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-caption-xs text-text-dim mb-1">
                {getRelativeTime(item.timestamp)}
              </div>
              <div className="text-body-sm text-text truncate">
                {item.summary}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
