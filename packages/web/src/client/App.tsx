import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import RunList from "./components/RunList";
import RunDetail from "./components/RunDetail";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<RunList />} />
        <Route path="/runs/:name" element={<RunDetail />} />
      </Route>
    </Routes>
  );
}
