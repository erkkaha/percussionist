import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import RunList from "./components/RunList";
import RunDetail from "./components/RunDetail";
import CreateRunForm from "./components/CreateRunForm";
import StatsView from "./components/StatsView";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<RunList />} />
        <Route path="/runs/new" element={<CreateRunForm />} />
        <Route path="/runs/:name" element={<RunDetail />} />
        <Route path="/stats" element={<StatsView />} />
      </Route>
    </Routes>
  );
}
