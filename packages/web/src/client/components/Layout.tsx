import { useState } from "react";
import { Outlet, NavLink } from "react-router-dom";
import { useProjects } from "../hooks/useProjects";

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
  const { data: projects } = useProjects();

  if (!projects || projects.length === 0) return null;

  return (
    <div className="space-y-0.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-between w-full rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${open ? "text-text bg-surface-overlay" : "text-text-dim hover:bg-surface-raised hover:text-text-muted"}`}
      >
        <span>Projects</span>
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

export default function Layout() {
  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-52 shrink-0 border-r border-border bg-surface-raised flex flex-col">
        <div className="px-4 py-4 border-b border-border">
          <span className="text-base font-semibold tracking-tight text-text">percussionist</span>
          <p className="text-xs text-text-dim mt-0.5">agent orchestration</p>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          <SidebarLink to="/">Runs</SidebarLink>
          <ProjectNav />
          <SidebarLink to="/agents">Agents</SidebarLink>
          <SidebarLink to="/stats">Stats</SidebarLink>
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
