import { Outlet, NavLink } from "react-router-dom";

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
          <SidebarLink to="/projects">Projects</SidebarLink>
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
