import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import Navbar from "./components/Navbar/Navbar.jsx";
import ERPWorkspace from "./pages/ERP/ERPWorkspace.jsx";
import { erpApi, setCsrfToken } from "./pages/ERP/erpApi.js";
import "./App.css";

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");

  useEffect(() => {
    let active = true;
    erpApi.getSession()
      .then((session) => {
        if (!active) return;
        setCsrfToken(session.csrfToken);
        setUser(session.user);
      })
      .catch((error) => {
        if (!active) return;
        if (error.status !== 401) setConnectionError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const submitLogin = async (credentials) => {
    const session = await erpApi.login(credentials);
    setCsrfToken(session.csrfToken);
    setUser(session.user);
    setConnectionError("");
  };
  const signOut = async () => {
    await erpApi.logout();
    setCsrfToken("");
    setUser(null);
  };
  const passwordChanged = () => {
    setCsrfToken("");
    setUser(null);
  };

  if (loading) return <div className="auth-loading">Connecting to Mercurio ERP…</div>;
  if (connectionError && !user) return <AuthScreen error={connectionError} onSubmit={submitLogin} />;
  if (!user) return <AuthScreen error="" onSubmit={submitLogin} />;
  if (user.forcePasswordChange) {
    return <PasswordChangeScreen user={user} onChanged={passwordChanged} />;
  }

  return (
    <div className="app-shell">
      <Navbar user={user} onLogout={signOut} />
      <Routes>
        <Route path="*" element={<ERPWorkspace initialUser={user} />} />
      </Routes>
    </div>
  );
}

function AuthScreen({ error: initialError, onSubmit }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit({ email, password });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout eyebrow="SECURE SIGN IN" title="Welcome back" description="Sign in to your Mercurio operations workspace.">
      <form className="auth-form" onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <label className="field"><span>Email address</span><input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="auth-footnote">Contact your system administrator if you need an account or password reset.</p>
    </AuthLayout>
  );
}

function PasswordChangeScreen({ user, onChanged }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await erpApi.changePassword({ currentPassword, newPassword });
      setNotice(result.message);
      window.setTimeout(onChanged, 1200);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout eyebrow="ACCOUNT SECURITY" title="Set a new password" description={`Welcome, ${user.email}. Change your temporary password to continue.`}>
      <form className="auth-form" onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        {notice && <div className="alert success" role="status">{notice}</div>}
        <label className="field"><span>Temporary password</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
        <label className="field"><span>New password <small>At least 12 characters</small></span><input type="password" autoComplete="new-password" minLength="12" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
        <label className="field"><span>Confirm new password</span><input type="password" autoComplete="new-password" minLength="12" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
        <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
      </form>
    </AuthLayout>
  );
}

function AuthLayout({ eyebrow, title, description, children }) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand"><span className="brand-mark">M</span><span>mercurio<span className="brand-light"> / ERP</span></span></div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p className="auth-description">{description}</p>
        {children}
      </section>
    </main>
  );
}
