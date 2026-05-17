import { Routes, Route } from "react-router-dom";
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
import AgentChatPanel from "./components/AgentChatPanel";
import SettingsPage from "./components/SettingsPage";

export default function App() {
  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<RunList />} />
          <Route path="/runs/new" element={<CreateRunForm />} />
          <Route path="/runs/:name" element={<RunDetail />} />
          <Route path="/stats" element={<StatsView />} />
          <Route path="/metrics" element={<MetricsView />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/new" element={<CreateProjectForm />} />
          <Route path="/projects/:name/edit" element={<EditProjectPage />} />
          <Route path="/projects/:name/board" element={<BoardView />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/new" element={<AgentForm />} />
          <Route path="/agents/:name/edit" element={<AgentForm />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
      <AgentChatPanel />
    </>
  );
}
