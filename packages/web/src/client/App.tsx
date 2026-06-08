import { useState, useRef, useCallback } from "react";
import { Routes, Route } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import AuthGuard from "./components/AuthGuard";
import Layout from "./components/Layout";
import RunList from "./components/RunList";
import RunDetail from "./components/RunDetail";
import CreateRunForm from "./components/CreateRunForm";
import StatsView from "./components/StatsView";
import ProjectsPage from "./components/ProjectsPage";
import CreateProjectForm from "./components/CreateProjectForm";
import EditProjectPage from "./components/EditProjectPage";
import AgentsPage from "./components/AgentsPage";
import AgentForm from "./components/AgentForm";
import BoardView from "./components/BoardView";
import MetricsView from "./components/MetricsView";
import SettingsPage from "./components/SettingsPage";
import PlanView from "./components/PlanView";
import ActivityPage from "./pages/ActivityPage";
import LoginPage from "./pages/LoginPage";
import { ChatContext } from "./lib/chat-context";
import type { Task } from "./lib/types";

export default function App() {
  const [chatOpen, setChatOpen] = useState(false);
  const injectRef = useRef<(task: Task, projectName: string) => void>(undefined);

  const injectTask = useCallback((task: Task, projectName: string) => {
    injectRef.current?.(task, projectName);
  }, []);

  const handleChatReady = useCallback((api: { injectTask: (task: Task, projectName: string) => void }) => {
    injectRef.current = api.injectTask;
  }, []);

  return (
    <AuthProvider>
      <ChatContext.Provider value={{ injectTask }}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AuthGuard />}>
            <Route element={<Layout chatOpen={chatOpen} onChatOpenChange={setChatOpen} onChatReady={handleChatReady} />}>
              <Route index element={<ActivityPage />} />
              <Route path="/runs" element={<RunList />} />
              <Route path="/runs/new" element={<CreateRunForm />} />
              <Route path="/runs/:name" element={<RunDetail />} />
              <Route path="/stats" element={<StatsView />} />
              <Route path="/metrics" element={<MetricsView />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/new" element={<CreateProjectForm />} />
              <Route path="/projects/:name/edit" element={<EditProjectPage />} />
              <Route path="/projects/:name/board" element={<BoardView />} />
              <Route path="/projects/:name/plans/:taskId" element={<PlanView />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/agents/new" element={<AgentForm />} />
              <Route path="/agents/:name/edit" element={<AgentForm />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Route>
        </Routes>
      </ChatContext.Provider>
    </AuthProvider>
  );
}
