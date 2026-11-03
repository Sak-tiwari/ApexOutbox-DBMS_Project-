import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, refreshSession, setAccessToken, setAuthLostHandler, type SessionResponse } from "./api";
import type { Me, Permission } from "./types";

interface AuthState {
  status: "loading" | "anonymous" | "authenticated";
  me: Me | null;
  can: (p: Permission) => boolean;
  startSession: (s: SessionResponse) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [me, setMe] = useState<Me | null>(null);

  const reload = useCallback(async () => {
    const m = await api<Me>("/me");
    setMe(m); setStatus("authenticated");
  }, []);
  const clear = useCallback(() => { setAccessToken(null); setMe(null); setStatus("anonymous"); qc.clear(); }, [qc]);

  useEffect(() => {
    setAuthLostHandler(clear);
    void (async () => {
      const t = await refreshSession();
      if (!t) return setStatus("anonymous");
      try { await reload(); } catch { clear(); }
    })();
  }, [clear, reload]);

  const value = useMemo<AuthState>(() => ({
    status, me,
    can: (p) => !!me?.permissions.includes(p),
    startSession: async (s) => { setAccessToken(s.accessToken); await reload(); },
    logout: async () => {
      try { await api("/auth/logout", { method: "POST" }); } catch { /* cookie cleared best-effort */ }
      clear();
    },
    reload,
  }), [status, me, reload, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
