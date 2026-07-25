import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Code2,
  Folder,
  LogOut,
  MessageSquare,
  Plus,
  Settings,
  Terminal,
  TrendingUp,
} from 'lucide-react';
import React from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useProjects } from '../hooks/useProjects';
import { useProjectsEvents } from '../hooks/useProjectsEvents';
import { fetchUpdateStatus } from '../lib/api';
import { useAuth } from '../lib/auth';
import { deriveIdeUrl } from '../lib/code-server-url';
import { UsageBar } from './UsageBar';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from './ui/sidebar';

const topNavItems = [
  { title: 'Activity', url: '/', icon: Activity },
  { title: 'Runs', url: '/runs', icon: Terminal },
];

const bottomNavItems = [
  { title: 'Settings', url: '/settings', icon: Settings },
  { title: 'Sessions', url: '/sessions', icon: MessageSquare },
  { title: 'Stats', url: '/stats', icon: TrendingUp },
  { title: 'Metrics', url: '/metrics', icon: BarChart3 },
];

export function DrumLogo({ playing, size = 24 }: { playing: boolean; size?: number }) {
  // Gradient/clip ids must be unique per instance — several logos can share a page.
  const uid = React.useId().replace(/:/g, '');
  const shadeId = `drum-shade-${uid}`;
  const clipId = `drum-clip-${uid}`;
  return (
    <>
      <style>{`
        @keyframes drum-left{0%,15%,100%{transform:rotate(0)}7%{transform:rotate(-25deg)}}
        @keyframes drum-right{0%,15%,100%{transform:rotate(0)}7%{transform:rotate(25deg)}}
        .drum-left{transform-origin:15px 14px;animation:none}
        .drum-right{transform-origin:49px 14px;animation:none}
        .playing .drum-left{animation:drum-left .5s ease-in infinite}
        .playing .drum-right{animation:drum-right .5s ease-in infinite .25s}
      `}</style>
      <svg
        className={playing ? 'playing' : ''}
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id={shadeId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#a34a0e" />
            <stop offset="0.45" stopColor="#8a380b" />
            <stop offset="1" stopColor="#5e2208" />
          </linearGradient>
          <clipPath id={clipId}>
            <path d="M12 35 H52 V47 A20 7.5 0 0 1 12 47 Z" />
          </clipPath>
        </defs>

        <rect width="64" height="64" rx="12" fill="#fbbf24" />

        {/* shell, with tension rods and bottom hoop trimmed to the cylinder */}
        <g clipPath={`url(#${clipId})`}>
          <rect x="10" y="30" width="44" height="28" fill={`url(#${shadeId})`} />
          <g stroke="#c26a10" strokeWidth="1.6">
            <path d="M18.5 32 V56" />
            <path d="M27.5 32 V56" />
            <path d="M36.5 32 V56" />
            <path d="M45.5 32 V56" />
          </g>
          <path d="M12 44 A20 7.5 0 0 0 52 44 V60 H12 Z" fill="#d97706" />
        </g>
        <path
          d="M12 35 H52 V47 A20 7.5 0 0 1 12 47 Z"
          fill="none"
          stroke="#4a1a06"
          strokeWidth="1.5"
        />

        {/* batter head */}
        <ellipse
          cx="32"
          cy="35"
          rx="20"
          ry="7.5"
          fill="#d97706"
          stroke="#4a1a06"
          strokeWidth="1.5"
        />
        <ellipse cx="32" cy="35" rx="15.5" ry="5" fill="#fef3c7" />

        {/* sticks — each pivots on its butt end so the tip lifts off the head */}
        <g stroke="#451a03" strokeWidth="2.8" strokeLinecap="round" fill="#451a03">
          <g className="drum-left">
            <path d="M15 14 L40 32" />
            <circle cx="40" cy="32" r="2.2" stroke="none" />
          </g>
          <g className="drum-right">
            <path d="M49 14 L24 32" />
            <circle cx="24" cy="32" r="2.2" stroke="none" />
          </g>
        </g>
      </svg>
    </>
  );
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  playing?: boolean;
  managerAvailable?: boolean | null;
}

export function AppSidebar({ playing, managerAvailable, ...props }: AppSidebarProps) {
  const location = useLocation();
  const { isAuthenticated, user, logout } = useAuth();
  const { connected: projectsSseConnected, eventTick } = useProjectsEvents();
  void eventTick;
  const { data: projects } = useProjects(projectsSseConnected ? false : 10_000);
  const { data: updateStatus } = useQuery({
    queryKey: ['update-status'],
    queryFn: fetchUpdateStatus,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    retry: 1,
  });

  const { isMobile, setOpenMobile } = useSidebar();

  const handleNavClick = React.useCallback(
    (e: React.MouseEvent) => {
      // Skip closing on modified clicks (cmd/ctrl-click for new tab, middle-click).
      if (e.metaKey || e.ctrlKey || e.button !== 0) return;
      if (isMobile) setOpenMobile(false);
    },
    [isMobile, setOpenMobile],
  );

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="p-0">
        <div className="flex h-14 items-center gap-2.5 px-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <DrumLogo playing={!!playing} />
          <div className="group-data-[collapsible=icon]:hidden">
            <p className="text-sm font-semibold tracking-tight text-sidebar-foreground">
              percussionist
            </p>
            <p className="text-caption-xs text-sidebar-foreground/60 mt-0.5">agent orchestration</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu className="[[data-collapsible=icon]_&]:items-center">
          {topNavItems.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild
                isActive={location.pathname === item.url}
                tooltip={item.title}
              >
                <NavLink to={item.url} end onClick={handleNavClick}>
                  <item.icon />
                  <span>{item.title}</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {projects && projects.length > 0 ? (
            projects.map((p) => {
              const name = p.metadata.name;
              const url = `/projects/${encodeURIComponent(name)}/board`;
              return (
                <SidebarMenuItem key={name}>
                  <div className="flex items-center">
                    <SidebarMenuButton
                      asChild
                      isActive={location.pathname.startsWith(
                        `/projects/${encodeURIComponent(name)}`,
                      )}
                      tooltip={p.spec.displayName || name}
                      className="flex-1"
                    >
                      <NavLink to={url} onClick={handleNavClick}>
                        <Folder />
                        <span>{p.spec.displayName || name}</span>
                      </NavLink>
                    </SidebarMenuButton>
                    {deriveIdeUrl(name) && (
                      <Link
                        to={`/projects/${encodeURIComponent(name)}/code-server`}
                        onClick={(e) => e.stopPropagation()}
                        title="Open code-server workspace"
                        className="flex items-center justify-center w-8 h-8 shrink-0 text-text-dim hover:text-text transition-colors group-data-[collapsible=icon]:hidden"
                      >
                        <Code2 className="h-3.5 w-3.5" />
                      </Link>
                    )}
                  </div>
                </SidebarMenuItem>
              );
            })
          ) : (
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={false} tooltip="New project">
                <NavLink to="/projects/new" onClick={handleNavClick}>
                  <Plus />
                  <span>New project</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {bottomNavItems.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild
                isActive={
                  item.url === '/sessions'
                    ? location.pathname.startsWith('/sessions')
                    : location.pathname === item.url
                }
                tooltip={item.title}
              >
                <NavLink to={item.url} end onClick={handleNavClick}>
                  <item.icon />
                  {item.title === 'Settings' && updateStatus?.updateAvailable && (
                    <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-400" />
                  )}
                  <span>{item.title}</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <UsageBar />
        <div className="flex items-center gap-1.5 px-1 py-1 group-data-[collapsible=icon]:justify-center">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
              managerAvailable === null
                ? 'bg-phase-pending'
                : managerAvailable
                  ? 'bg-phase-succeeded'
                  : 'bg-phase-failed'
            }`}
          />
          <span className="text-caption-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
            v{__APP_VERSION__}
          </span>
          {isAuthenticated && (
            <button
              type="button"
              onClick={logout}
              title={user?.email ? `Sign out (${user.email})` : 'Sign out'}
              aria-label="Sign out"
              className="ml-auto rounded p-1 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors group-data-[collapsible=icon]:ml-0"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
