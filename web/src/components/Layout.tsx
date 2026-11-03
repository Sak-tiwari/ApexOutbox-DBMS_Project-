import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { startRealtime, type LiveStatus } from "../lib/realtime";
import type { Permission } from "../lib/types";

const NAV: { to: string; label: string; icon: string; perm?: Permission }[] = [
  { to: "/", label: "Home", icon: "◧" },
  { to: "/leads", label: "Leads", icon: "☰", perm: "leads:read" },
  { to: "/scraper", label: "Scraper", icon: "⌕", perm: "scrape:run" },
  { to: "/invoices", label: "Invoices", icon: "₹", perm: "invoices:read" },
  { to: "/settings", label: "More", icon: "⋯" },
];

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("apex-theme", next ? "dark" : "light"); } catch { /* private mode */ }
    setDark(next);
  };
  return { dark, toggle };
}

export function Layout() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const [live, setLive] = useState<LiveStatus>("connecting");
  useEffect(() => startRealtime(qc, setLive), [qc]);
  const items = NAV.filter((n) => !n.perm || can(n.perm));
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-tap flex-1 flex-col items-center justify-center gap-0.5 px-2 text-xs font-medium md:flex-none md:flex-row md:gap-2 md:rounded-lg md:px-3 md:text-sm ${
      isActive ? "text-brand-700 dark:text-brand-100 md:bg-brand-50 md:dark:bg-slate-800" : "text-slate-700 dark:text-slate-300"}`;
  return (
    <div className="min-h-dvh md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-3 focus:text-black">Skip to content</a>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-slate-800 dark:bg-slate-900 md:static md:w-56 md:flex-none md:flex-col md:border-r md:border-t-0 md:p-3">
        <div className="mb-4 hidden px-3 pt-2 md:block">
          <p className="text-lg font-bold">ApexOutbox</p>
          <p className="truncate text-xs text-slate-600 dark:text-slate-400">{me?.tenant.name}</p>
        </div>
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === "/"} className={link}>
            <span aria-hidden="true" className="text-lg leading-none">{n.icon}</span>{n.label}
          </NavLink>
        ))}
      </nav>
      <div className="min-w-0 flex-1 pb-20 md:pb-0">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90 md:hidden">
          <span className="font-bold">ApexOutbox</span>
          <LiveDot live={live} />
        </header>
        <main id="main" className="mx-auto max-w-5xl px-4 py-5">
          <div className="mb-3 hidden justify-end md:flex"><LiveDot live={live} /></div>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const LiveDot = ({ live }: { live: LiveStatus }) => (
  <span className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300" role="status">
    <span className={`h-2 w-2 rounded-full ${live === "live" ? "bg-green-600" : live === "connecting" ? "bg-amber-500" : "bg-red-600"}`} />
    {live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Offline"}
  </span>
);
