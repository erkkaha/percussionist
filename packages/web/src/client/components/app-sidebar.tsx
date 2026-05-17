import { NavLink, useLocation } from "react-router-dom";
import {
  BarChart3,
  Terminal,
  Bot,
  TrendingUp,
  Folder,
  ChevronRight,
  Settings,
} from "lucide-react";
import { useProjects } from "../hooks/useProjects";
import { useProjectsEvents } from "../hooks/useProjectsEvents";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "./ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";

const topNavItems = [
  { title: "Runs", url: "/", icon: Terminal },
];

const bottomNavItems = [
  { title: "Settings", url: "/settings", icon: Settings },
  { title: "Agents", url: "/agents", icon: Bot },
  { title: "Stats", url: "/stats", icon: TrendingUp },
  { title: "Metrics", url: "/metrics", icon: BarChart3 },
];

export function DrumLogo({ playing, size = 24 }: { playing: boolean; size?: number }) {
  return (
    <>
      <style>{`
        @keyframes drum-left{0%,15%,100%{transform:rotate(0)}7%{transform:rotate(-25deg)}}
        @keyframes drum-right{0%,15%,100%{transform:rotate(0)}7%{transform:rotate(25deg)}}
        .drum-left{transform-origin:14px 48px;animation:none}
        .drum-right{transform-origin:50px 48px;animation:none}
        .playing .drum-left{animation:drum-left .5s ease-in infinite}
        .playing .drum-right{animation:drum-right .5s ease-in infinite .25s}
      `}</style>
      <svg className={playing ? "playing" : ""} width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="64" height="64" rx="12" fill="#fbbf24"/>
        <ellipse cx="32" cy="38" rx="20" ry="14" fill="#92400e" stroke="#78350f" strokeWidth="2"/>
        <ellipse cx="32" cy="38" rx="16" ry="10" fill="#b45309"/>
        <ellipse cx="32" cy="28" rx="20" ry="8" fill="#d97706" stroke="#b45309" strokeWidth="1.5"/>
        <ellipse cx="32" cy="28" rx="16" ry="5" fill="#fbbf24"/>
        <g className="drum-left">
          <line x1="14" y1="48" x2="28" y2="20" stroke="#451a03" strokeWidth="3" strokeLinecap="round"/>
        </g>
        <g className="drum-right">
          <line x1="50" y1="48" x2="36" y2="20" stroke="#451a03" strokeWidth="3" strokeLinecap="round"/>
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
  const { connected: projectsSseConnected, eventTick } = useProjectsEvents();
  void eventTick;
  const { data: projects } = useProjects(
    projectsSseConnected ? false : 10_000,
  );

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex h-14 items-center gap-2.5 px-1 py-1 group-data-[collapsible=icon]:justify-center">
          <DrumLogo playing={!!playing} />
          <div className="group-data-[collapsible=icon]:hidden">
            <p className="text-sm font-semibold tracking-tight text-sidebar-foreground">percussionist</p>
            <p className="text-[10px] text-sidebar-foreground/60 mt-0.5">agent orchestration</p>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarMenu>
            {topNavItems.map((item) => (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  isActive={location.pathname === item.url}
                  tooltip={item.title}
                >
                  <NavLink to={item.url} end>
                    <item.icon />
                    <span>{item.title}</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            <Collapsible defaultOpen className="group/collapsible">
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton tooltip="Projects">
                    <Folder />
                    <span>Projects</span>
                    <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {projects && projects.length > 0 ? (
                      projects.map((p) => {
                        const name = p.metadata.name;
                        const url = `/projects/${encodeURIComponent(name)}/board`;
                        return (
                          <SidebarMenuSubItem key={name}>
                            <SidebarMenuSubButton
                              asChild
                              isActive={location.pathname.startsWith(url)}
                            >
                              <NavLink to={url}>
                                <span>{p.spec.displayName || name}</span>
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        );
                      })
                    ) : (
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <NavLink to="/projects">
                            <span className="text-sidebar-foreground/60">No projects yet</span>
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    )}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
            {bottomNavItems.map((item) => (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  isActive={location.pathname === item.url}
                  tooltip={item.title}
                >
                  <NavLink to={item.url} end>
                    <item.icon />
                    <span>{item.title}</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <div className="flex items-center gap-1.5 px-1 py-1 group-data-[collapsible=icon]:justify-center">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
              managerAvailable === null
                ? "bg-phase-pending"
                : managerAvailable
                  ? "bg-phase-succeeded"
                  : "bg-phase-failed"
            }`}
          />
          <span className="text-[10px] text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
            v{__APP_VERSION__}
          </span>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
