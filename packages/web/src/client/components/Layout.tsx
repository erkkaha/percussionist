import { useState } from "react";
import { Outlet, NavLink } from "react-router-dom";
import { useProjects } from "../hooks/useProjects";
import { useRuns } from "../hooks/useRuns";
import { useProjectsEvents } from "../hooks/useProjectsEvents";
import { useRunsEvents } from "../hooks/useRunsEvents";
import { useRunNotifications } from "../hooks/useRunNotifications";
import { TERMINAL_PHASES } from "@percussionist/api";
import NotificationBell from "./NotificationBell";
import { BarChart3, Terminal, Bot, TrendingUp, Folder } from "lucide-react";

function SidebarLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
          isActive
            ? "bg-surface-overlay text-text"
            : "text-text-dim hover:bg-surface-raised hover:text-text-muted"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-3 h-3 text-text-dim transition-transform ${open ? "rotate-90" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function ProjectNav() {
  const [open, setOpen] = useState(true);
  const { connected: projectsSseConnected, eventTick } = useProjectsEvents();
  void eventTick;
  const { data: projects } = useProjects(
    projectsSseConnected ? false : 10_000,
  );

  if (!projects || projects.length === 0) return null;

  return (
    <div className="space-y-0.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-between w-full rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${open ? "text-text bg-surface-overlay" : "text-text-dim hover:bg-surface-raised hover:text-text-muted"}`}
      >
        <span className="flex items-center gap-2"><Folder className="w-4 h-4" />Projects</span>
        <Chevron open={open} />
      </button>
      {open && projects.map((p) => (
        <SidebarLink key={p.metadata.uid ?? p.metadata.name} to={`/projects/${encodeURIComponent(p.metadata.name)}/board`}>
          <span className="truncate">{p.spec.displayName || p.metadata.name}</span>
        </SidebarLink>
      ))}
    </div>
  );
}

function DrumLogo({ playing }: { playing: boolean }) {
  return (
    <>
      <style>{`
        @keyframes drum-left{0%,100%{transform:rotate(0)}50%{transform:rotate(-22deg)}}
        @keyframes drum-right{0%,100%{transform:rotate(0)}50%{transform:rotate(22deg)}}
        .drum-left{transform-origin:14px 48px;animation:none}
        .drum-right{transform-origin:50px 48px;animation:none}
        .playing .drum-left{animation:drum-left .3s ease-in-out infinite}
        .playing .drum-right{animation:drum-right .3s ease-in-out infinite .15s}
      `}</style>
      <svg className={playing ? "playing" : ""} width="24" height="24" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="64" height="64" rx="12" fill="#fbbf24"/>
        <ellipse cx="32" cy="38" rx="20" ry="14" fill="#92400e" stroke="#78350f" strokeWidth="2"/>
        <ellipse cx="32" cy="38" rx="16" ry="10" fill="#b45309"/>
        <ellipse cx="32" cy="28" rx="20" ry="8" fill="#d97706" stroke="#b45309" strokeWidth="1.5"/>
        <ellipse cx="32" cy="28" rx="16" ry="5" fill="#fbbf24"/>
        <g className="drum-left"><line x1="14" y1="48" x2="28" y2="20" stroke="#78350f" strokeWidth="3.5" strokeLinecap="round"/></g>
        <g className="drum-right"><line x1="50" y1="48" x2="36" y2="20" stroke="#78350f" strokeWidth="3.5" strokeLinecap="round"/></g>
        <circle cx="29" cy="19" r="3" fill="#d97706"/>
        <circle cx="35" cy="19" r="3" fill="#d97706"/>
      </svg>
    </>
  );
}

export default function Layout() {
  const { connected: runsSseConnected, eventTick } = useRunsEvents();
  void eventTick;
  const { data: runs } = useRuns(runsSseConnected ? false : 5_000);
  const hasInProgress = (runs ?? []).some((r) => r.status?.phase != null && !TERMINAL_PHASES.has(r.status.phase));
  useRunNotifications(runs);

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-52 shrink-0 border-r border-border bg-surface-raised flex flex-col">
        <div className="px-4 py-4 border-b border-border flex items-center gap-2.5">
          <DrumLogo playing={hasInProgress} />
          <div>
            <span className="text-base font-semibold tracking-tight text-text">percussionist</span>
            <p className="text-xs text-text-dim mt-0.5">agent orchestration</p>
          </div>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          <SidebarLink to="/">
            <Terminal className="w-4 h-4" />
            Runs
          </SidebarLink>
          <ProjectNav />
          <SidebarLink to="/agents">
            <Bot className="w-4 h-4" />
            Agents
          </SidebarLink>
          <SidebarLink to="/stats">
            <TrendingUp className="w-4 h-4" />
            Stats
          </SidebarLink>
          <SidebarLink to="/metrics">
            <BarChart3 className="w-4 h-4" />
            Metrics
          </SidebarLink>
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-11 shrink-0 border-b border-border bg-surface-raised flex items-center justify-end px-4">
          <NotificationBell />
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
