import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { LEAD_STATUSES, STATUS_LABEL, type LeadStatus } from "../lib/types";

export const Skeleton = ({ className = "h-4 w-full" }: { className?: string }) => <div className={`skeleton ${className}`} aria-hidden="true" />;

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-3/4" /></div>
      ))}
    </div>
  );
}

export const Empty = ({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) => (
  <div className="card py-10 text-center">
    <p className="font-medium">{title}</p>
    {hint && <p className="mx-auto mt-1 max-w-sm text-sm text-slate-600 dark:text-slate-400">{hint}</p>}
    {action && <div className="mt-4 flex justify-center">{action}</div>}
  </div>
);

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong");

export const ErrorState = ({ error, onRetry }: { error: unknown; onRetry?: () => void }) => (
  <div role="alert" className="card border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950">
    <p className="font-medium text-red-800 dark:text-red-200">Couldn't load this</p>
    <p className="mt-1 text-sm text-red-800 dark:text-red-300">{errorText(error)}</p>
    {onRetry && <button className="btn-secondary mt-3" onClick={onRetry}>Try again</button>}
  </div>
);

const TONE = {
  slate: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  blue: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200",
  green: "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200",
  amber: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  red: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  violet: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
} as const;
export const Badge = ({ tone = "slate", children }: { tone?: keyof typeof TONE; children: ReactNode }) => (
  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}>{children}</span>
);

const LEAD_TONE: Record<LeadStatus, keyof typeof TONE> = { NEW: "blue", CONTACTED: "violet", FOLLOW_UP: "amber", NEGOTIATION: "violet", CLOSED_WON: "green", CLOSED_LOST: "slate" };
export const StatusBadge = ({ status }: { status: LeadStatus }) => <Badge tone={LEAD_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
export const STATUS_OPTIONS = LEAD_STATUSES;

// ---- toasts (aria-live) ----
type Toast = { id: number; text: string; kind: "ok" | "error" };
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const n = useRef(0);
  const push = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = ++n.current;
    setItems((x) => [...x.slice(-2), { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6">
        {items.map((t) => (
          <div key={t.id} role={t.kind === "error" ? "alert" : "status"}
            className={`pointer-events-auto max-w-md rounded-lg px-4 py-3 text-sm shadow-lg ${t.kind === "error" ? "bg-red-700 text-white" : "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- modal / bottom sheet ----
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = ""; prev?.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 md:items-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        className="max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl outline-none dark:bg-slate-900 md:max-w-lg md:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn-secondary" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const Field = ({ label, id, children, hint }: { label: string; id: string; children: ReactNode; hint?: string }) => (
  <div>
    <label htmlFor={id} className="label">{label}</label>
    {children}
    {hint && <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{hint}</p>}
  </div>
);
