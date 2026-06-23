import { useCallback, useRef, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import AgentForm from './components/AgentForm';
import AgentsPage from './components/AgentsPage';
import AuthGuard from './components/AuthGuard';
import BoardView from './components/BoardView';
import CodeServerView from './components/CodeServerView';
import CreateProjectForm from './components/CreateProjectForm';
import CreateRunForm from './components/CreateRunForm';
import EditProjectPage from './components/EditProjectPage';
import Layout from './components/Layout';
import MetricsView from './components/MetricsView';
import PlanView from './components/PlanView';
import ProjectsPage from './components/ProjectsPage';
import RunDetail from './components/RunDetail';
import RunList from './components/RunList';
import SessionDetail from './components/SessionDetail';
import SessionList from './components/SessionList';
import SettingsPage from './components/SettingsPage';
import StatsView from './components/StatsView';
import { AuthProvider } from './lib/auth';
import { ChatContext } from './lib/chat-context';
import type { Task } from './lib/types';
import ActivityPage from './pages/ActivityPage';
import LoginPage from './pages/LoginPage';

export default function App() {
  const [chatOpen, setChatOpen] = useState(false);
  const injectRef = useRef<(task: Task, projectName: string) => void>(undefined);

  const injectTask = useCallback((task: Task, projectName: string) => {
    injectRef.current?.(task, projectName);
  }, []);

  const handleChatReady = useCallback(
    (api: { injectTask: (task: Task, projectName: string) => void }) => {
      injectRef.current = api.injectTask;
    },
    [],
  );

  return (
    <AuthProvider>
      <ChatContext.Provider value={{ injectTask }}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AuthGuard />}>
            <Route
              element={
                <Layout
                  chatOpen={chatOpen}
                  onChatOpenChange={setChatOpen}
                  onChatReady={handleChatReady}
                />
              }
            >
              <Route index element={<ActivityPage />} />
              <Route path="/runs" element={<RunList />} />
              <Route path="/runs/new" element={<CreateRunForm />} />
              <Route path="/runs/:name" element={<RunDetail />} />
              <Route path="/stats" element={<StatsView />} />
              <Route path="/sessions" element={<SessionList />} />
              <Route path="/sessions/:name" element={<SessionDetail />} />
              <Route path="/metrics" element={<MetricsView />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/new" element={<CreateProjectForm />} />
              <Route path="/projects/:name/edit" element={<EditProjectPage />} />
              <Route path="/projects/:name/board" element={<BoardView />} />
              <Route path="/projects/:name/code-server" element={<CodeServerView />} />
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
