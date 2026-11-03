import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Field, errorText } from "../components/ui";
import { api, type SessionResponse } from "../lib/api";
import { useAuth } from "../lib/auth";

type Mode = "login" | "register";

export default function AuthPage({ mode }: { mode: Mode }) {
  const { status, startSession } = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  if (status === "authenticated") return <Navigate to="/" replace />;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      let res: SessionResponse | { requiresTwoFactor: true; challengeToken: string };
      if (challenge) res = await api<SessionResponse>("/auth/login/2fa", { method: "POST", body: { challengeToken: challenge, code: String(f.get("code")) } });
      else if (mode === "login") res = await api("/auth/login", { method: "POST", body: { email: f.get("email"), password: f.get("password") } });
      else res = await api<SessionResponse>("/auth/register", { method: "POST", body: { tenantName: f.get("tenantName"), name: f.get("name"), email: f.get("email"), password: f.get("password") } });
      if ("requiresTwoFactor" in res) { setChallenge(res.challengeToken); return; }
      await startSession(res);
      nav("/", { replace: true });
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-8">
      <h1 className="mb-1 text-2xl font-bold">ApexOutbox</h1>
      <p className="mb-6 text-sm text-slate-700 dark:text-slate-300">{challenge ? "Enter the 6-digit code from your authenticator app." : mode === "login" ? "Sign in to your workspace." : "Create your workspace."}</p>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <p role="alert" className="rounded-lg bg-red-100 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">{error}</p>}
        {challenge ? (
          <Field label="Authentication code" id="code" hint="Or use a recovery code.">
            <input id="code" name="code" className="input" inputMode="numeric" autoComplete="one-time-code" required autoFocus />
          </Field>
        ) : (
          <>
            {mode === "register" && (
              <>
                <Field label="Company name" id="tenantName"><input id="tenantName" name="tenantName" className="input" autoComplete="organization" required minLength={2} /></Field>
                <Field label="Your name" id="name"><input id="name" name="name" className="input" autoComplete="name" required /></Field>
              </>
            )}
            <Field label="Email" id="email"><input id="email" name="email" type="email" className="input" inputMode="email" autoComplete="email" autoCapitalize="none" required /></Field>
            <Field label="Password" id="password" hint={mode === "register" ? "At least 12 characters. Avoid common words." : undefined}>
              <input id="password" name="password" type="password" className="input" autoComplete={mode === "login" ? "current-password" : "new-password"} required />
            </Field>
          </>
        )}
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Please wait…" : challenge ? "Verify" : mode === "login" ? "Sign in" : "Create workspace"}</button>
      </form>
      {!challenge && (
        <p className="mt-6 text-center text-sm">
          {mode === "login" ? <>New here? <Link className="font-medium text-brand-700 underline dark:text-brand-100" to="/register">Create a workspace</Link></> : <>Already have one? <Link className="font-medium text-brand-700 underline dark:text-brand-100" to="/login">Sign in</Link></>}
        </p>
      )}
    </main>
  );
}

export function ChangePassword() {
  const { reload, me, logout } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      const s = await api<SessionResponse>("/auth/password/change", { method: "POST", body: { currentPassword: f.get("currentPassword"), newPassword: f.get("newPassword") } });
      const { setAccessToken } = await import("../lib/api");
      setAccessToken(s.accessToken);
      await reload();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-2xl font-bold">Choose a new password</h1>
      <p className="mb-6 text-sm">Hi {me?.user.name}, your password was set by an administrator. Pick your own to continue.</p>
      <form onSubmit={submit} className="space-y-4">
        {error && <p role="alert" className="rounded-lg bg-red-100 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-200">{error}</p>}
        <Field label="Current password" id="currentPassword"><input id="currentPassword" name="currentPassword" type="password" className="input" autoComplete="current-password" required /></Field>
        <Field label="New password" id="newPassword" hint="At least 12 characters."><input id="newPassword" name="newPassword" type="password" className="input" autoComplete="new-password" required /></Field>
        <button className="btn-primary w-full" disabled={busy}>Save password</button>
        <button type="button" className="btn-secondary w-full" onClick={() => void logout()}>Sign out</button>
      </form>
    </main>
  );
}
