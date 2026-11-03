import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTheme } from "../components/Layout";
import { Badge, errorText, useToast } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export default function Settings() {
  const { me, can, logout, reload } = useAuth();
  const { dark, toggle } = useTheme();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret?: string; otpauthUrl?: string; uri?: string } | null>(null);
  const features = (me?.tenant.settings.features ?? {}) as { invoices?: boolean; email?: boolean };
  const flag = useMutation({
    mutationFn: (f: Record<string, boolean>) => api("/tenant/settings", { method: "PATCH", body: { features: f } }),
    onSuccess: () => { void reload(); toast("Saved"); }, onError: (e) => toast(errorText(e), "error"),
  });
  const begin = useMutation({ mutationFn: () => api<typeof setup>("/auth/2fa/setup", { method: "POST" }), onSuccess: setSetup, onError: (e) => toast(errorText(e), "error") });
  const enable = useMutation({
    mutationFn: (code: string) => api<{ recoveryCodes?: string[] }>("/auth/2fa/enable", { method: "POST", body: { code } }),
    onSuccess: (r) => { setSetup(null); void reload(); toast(r.recoveryCodes ? `Two-factor on. Save these recovery codes: ${r.recoveryCodes.join(" ")}` : "Two-factor on"); },
    onError: (e) => toast(errorText(e), "error"),
  });
  const logoutAll = useMutation({ mutationFn: () => api("/auth/logout-all", { method: "POST" }), onSuccess: () => void logout(), onError: (e) => toast(errorText(e), "error") });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Account</h1>
      <section className="card space-y-1">
        <p className="font-medium">{me?.user.name}</p>
        <p className="text-sm">{me?.user.email}</p>
        <p className="flex items-center gap-2 text-sm">{me?.tenant.name} <Badge>{me?.user.role.toLowerCase()}</Badge></p>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Appearance</h2>
        <label className="flex min-h-tap items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5" checked={dark} onChange={toggle} />Dark mode</label>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Two-factor authentication</h2>
        {me?.user.totpEnabled ? <p className="text-sm">Enabled.</p> : setup ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); enable.mutate(String(new FormData(e.currentTarget).get("code"))); }}>
            <p className="text-sm">Add this key to your authenticator app, then enter the 6-digit code.</p>
            <code className="block break-all rounded bg-slate-100 p-2 text-sm dark:bg-slate-800">{setup.secret ?? setup.uri ?? setup.otpauthUrl}</code>
            <input name="code" className="input" inputMode="numeric" autoComplete="one-time-code" aria-label="6-digit code" required />
            <button className="btn-primary" disabled={enable.isPending}>Turn on</button>
          </form>
        ) : <button className="btn-secondary" onClick={() => begin.mutate()}>Set up</button>}
      </section>

      {can("tenant:settings") && (
        <section className="card space-y-2">
          <h2 className="font-semibold">Workspace features</h2>
          <label className="flex min-h-tap items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5" checked={features.invoices !== false} onChange={(e) => flag.mutate({ invoices: e.target.checked })} />Create invoices when a lead is won</label>
          <label className="flex min-h-tap items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5" checked={features.email !== false} onChange={(e) => flag.mutate({ email: e.target.checked })} />Send invoice e-mails</label>
        </section>
      )}

      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={() => void logout()}>Sign out</button>
        <button className="btn-secondary" onClick={() => logoutAll.mutate()}>Sign out everywhere</button>
      </div>
    </div>
  );
}
