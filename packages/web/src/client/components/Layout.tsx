import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { useRuns } from "../hooks/useRuns";
import { useRunsEvents } from "../hooks/useRunsEvents";
import { useRunNotifications } from "../hooks/useRunNotifications";
import { TERMINAL_PHASES } from "@percussionist/api";
import { authHeaders } from "../lib/auth";
import NotificationBell from "./NotificationBell";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { AppSidebar } from "./app-sidebar";
import AgentChatPanel from "./AgentChatPanel";
import type { Task } from "@/lib/types";

export default function Layout({ chatOpen, onChatOpenChange, onChatReady }: { chatOpen?: boolean; onChatOpenChange?: (open: boolean) => void; onChatReady?: (api: { injectTask: (task: Task, projectName: string) => void }) => void }) {
  const { connected: runsSseConnected, eventTick } = useRunsEvents();
  void eventTick;
  const { data: runs } = useRuns(runsSseConnected ? false : 5_000);
  const hasInProgress = (runs ?? []).some((r) => r.status?.phase != null && !TERMINAL_PHASES.has(r.status.phase));
  useRunNotifications(runs);

  const [managerAvailable, setManagerAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    function check() {
      fetch("/api/agent/status", { headers: authHeaders() })
        .then((r) => r.json())
        .then((d) => setManagerAvailable(d.available === true))
        .catch(() => setManagerAvailable(false));
    }
    check();
    const id = setInterval(check, 10_000);
    return () => clearInterval(id);
  }, []);

  return (
    <SidebarProvider>
      <AppSidebar playing={hasInProgress} managerAvailable={managerAvailable} />
      <SidebarInset className="transition-all duration-300 ease-in-out">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-4">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="-ml-1 data-[state=open]:rotate-180" />
          </div>
          <NotificationBell />
        </header>
        <main className="flex-1 min-w-0 overflow-x-hidden p-6">
          <Outlet />
        </main>
      </SidebarInset>
      <AgentChatPanel open={chatOpen ?? false} onOpenChange={onChatOpenChange} onChatReady={onChatReady} />
    </SidebarProvider>
  );
}
