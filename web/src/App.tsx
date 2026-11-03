import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ListSkeleton } from "./components/ui";
import { useAuth } from "./lib/auth";
import type { Permission } from "./lib/types";

const Auth = lazy(() => import("./pages/AuthPages"));
const ChangePassword = lazy(() => import("./pages/AuthPages").then((m) => ({ default: m.ChangePassword })));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Leads = lazy(() => import("./pages/Leads"));
const Scraper = lazy(() => import("./pages/Scraper"));
const Invoices = lazy(() => import("./pages/Invoices"));
const Settings = lazy(() => import("./pages/Settings"));

const Guard = ({ perm, children }: { perm?: Permission; children: React.ReactNode }) => {
  const { can } = useAuth();
  return !perm || can(perm) ? <>{children}</> : <p className="card" role="alert">You don't have access to this page.</p>;
};

function Private() {
  const { status, me } = useAuth();
  const loc = useLocation();
  if (status === "loading") return <div className="mx-auto max-w-md p-6"><ListSkeleton rows={3} /></div>;
  if (status === "anonymous") return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (me?.user.mustChangePassword) return <ChangePassword />;
  return <Layout />;
}

export default function App() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-md p-6"><ListSkeleton rows={3} /></div>}>
      <Routes>
        <Route path="/login" element={<Auth mode="login" />} />
        <Route path="/register" element={<Auth mode="register" />} />
        <Route element={<Private />}>
          <Route index element={<Dashboard />} />
          <Route path="leads" element={<Guard perm="leads:read"><Leads /></Guard>} />
          <Route path="scraper" element={<Guard perm="scrape:run"><Scraper /></Guard>} />
          <Route path="invoices" element={<Guard perm="invoices:read"><Invoices /></Guard>} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
