import { Outlet, Link } from "react-router-dom";

export default function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-surface-raised px-6 py-3 flex items-center gap-4">
        <Link to="/" className="flex items-center gap-2 text-text hover:text-white transition-colors">
          <span className="text-lg font-semibold tracking-tight">percussionist</span>
        </Link>
        <span className="text-text-dim text-sm">agent orchestration dashboard</span>
      </header>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
