import { useCallback, useEffect, useState } from "react";
import { erpApi } from "./erpApi.js";

const modules = [
  ["MM", "Materials Management"],
  ["PRM", "Procurement Management"],
  ["AP", "Accounts Payable"],
  ["SM", "Sales Management"],
  ["FM", "Financial Management"],
  ["PM", "Production Management"],
];
const actions = ["view", "create", "edit", "delete", "reports"];

export default function AdminDashboard() {
  const [users, setUsers] = useState([]);
  const [modulePermissions, setModulePermissions] = useState({});
  const [auditEntries, setAuditEntries] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [permissions, setPermissions] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const loadUsers = useCallback(async () => {
    const result = await erpApi.getAdminUsers();
    setUsers(result.users);
    setModulePermissions(result.modulePermissions);
    return result.users;
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([erpApi.getAdminUsers(), erpApi.getAudit()])
      .then(([userResult, auditResult]) => {
        if (!active) return;
        setUsers(userResult.users);
        setModulePermissions(userResult.modulePermissions);
        setAuditEntries(auditResult.entries);
      })
      .catch((loadError) => { if (active) setError(loadError.message); });
    return () => { active = false; };
  }, []);

  const selectedUser = users.find((user) => user.id === selectedId);

  const createUser = async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const values = new FormData(formElement);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await erpApi.createUser({
        email: String(values.get("email")).trim(),
        temporaryPassword: String(values.get("temporaryPassword")),
      });
      await loadUsers();
      setSelectedId(result.user.id);
      setPermissions(result.user.permissions);
      setNotice(`Account created for ${result.user.email}. It must change its temporary password at first sign-in.`);
      formElement.reset();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const savePermissions = async () => {
    if (!selectedUser || selectedUser.masterAdmin) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await erpApi.updatePermissions(selectedUser.id, permissions);
      setUsers((current) => current.map((user) => user.id === result.user.id ? result.user : user));
      setNotice(`Module permissions updated for ${result.user.email}.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (user) => {
    const nextActive = !user.active;
    if (!nextActive && !window.confirm(`Deactivate ${user.email}? Their current sessions will be revoked.`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await erpApi.setUserActive(user.id, nextActive);
      setUsers((current) => current.map((entry) => entry.id === result.user.id ? result.user : entry));
      setNotice(`${user.email} ${nextActive ? "activated" : "deactivated"}.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const togglePermission = (module, action) => {
    setPermissions((current) => {
      const currentActions = current[module] ?? [];
      const next = currentActions.includes(action)
        ? currentActions.filter((entry) => entry !== action)
        : [...currentActions, action];
      if (action !== "view" && !next.includes("view") && next.length) next.push("view");
      if (action === "view" && !next.includes("view")) next.length = 0;
      return { ...current, [module]: next };
    });
  };

  return <main className="workspace admin-workspace">
    <aside className="side-rail"><div className="rail-label">ADMINISTRATION</div><div className="rail-link active"><span className="rail-icon">♙</span><span>User access</span></div><div className="rail-footnote"><div className="rail-footnote-dot" /><span>Protected console<br /><small>Master administrator only</small></span></div></aside>
    <section className="workspace-content">
      <div className="page-header"><div><div className="eyebrow">SYSTEM ADMINISTRATION</div><h1>Admin dashboard</h1><p>Create accounts, set module-level privileges, and review recent activity.</p></div></div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert success" role="status">{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div>}
      <section className="panel">
        <div className="panel-heading"><div><h2>Create a user account</h2><p>New accounts are created with Materials Management view access and must rotate their temporary password.</p></div></div>
        <form className="admin-create-form" onSubmit={createUser}>
          <label className="field"><span>Email address</span><input name="email" type="email" autoComplete="off" maxLength="254" required /></label>
          <label className="field"><span>Temporary password <small>At least 12 characters</small></span><input name="temporaryPassword" type="password" autoComplete="new-password" minLength="12" maxLength="200" required /></label>
          <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        </form>
      </section>
      <div className="admin-grid">
        <section className="panel">
          <div className="panel-heading"><div><h2>User accounts</h2><p>{users.length} accounts · select a user to edit access.</p></div></div>
          {users.length ? <div className="admin-user-list">{users.map((user) => <div className={`admin-user-row${selectedId === user.id ? " selected" : ""}`} key={user.id}>
            <button type="button" className="admin-user-select" onClick={() => { setSelectedId(user.id); setPermissions(user.permissions); }}><span className="admin-user-avatar">{user.email.slice(0, 1).toUpperCase()}</span><span className="admin-user-detail"><strong>{user.email}</strong><small>{user.masterAdmin ? "Master administrator" : `${Object.keys(user.permissions).length} module grants`}</small></span></button>
            <span className={`status-pill ${user.active ? "status-posted" : "status-low"}`}>{user.active ? "Active" : "Inactive"}</span>
            {!user.masterAdmin && <button className="text-button" type="button" disabled={busy} onClick={() => toggleActive(user)}>{user.active ? "Deactivate" : "Activate"}</button>}
          </div>)}</div> : <div className="loading-state">Loading users…</div>}
        </section>
        <section className="panel">
          <div className="panel-heading"><div><h2>Module permissions</h2><p>{selectedUser?.email ?? "Select an account to configure access."}</p></div></div>
          {!selectedUser ? <div className="empty-state"><strong>Select a user account</strong></div>
            : selectedUser.masterAdmin ? <div className="inline-notice">The master administrator has full access to every module.</div>
              : <><div className="permission-matrix">
                <div className="report-subheading"><div><h3>Feature access for this user</h3><p>Turn off “Enabled” to inactivate a whole module. Switch individual actions on or off, then save.</p></div></div>
                <div className="permission-row permission-header"><strong>Module</strong>{actions.map((action) => <span key={action}>{action === "view" ? "Enabled" : action}</span>)}</div>
                {modules.map(([code, title]) => <div className="permission-row" key={code}>
                  <strong><span>{code}</span>{title}</strong>
                  {(modulePermissions[code] ?? actions).map((action) => <label key={action} aria-label={`${title} ${action === "view" ? "enabled" : action}`} title={`${(permissions[code] ?? []).includes(action) ? "Disable" : "Enable"} ${action === "view" ? title : `${action} in ${title}`}`}><input type="checkbox" checked={(permissions[code] ?? []).includes(action)} onChange={() => togglePermission(code, action)} /><span className="visually-hidden">{action === "view" ? "Enabled" : action}</span></label>)}
                </div>)}
              </div><div className="form-actions"><button className="button button-primary" type="button" disabled={busy} onClick={savePermissions}>{busy ? "Saving…" : "Save privileges"}</button></div></>}
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading"><div><h2>Recent audit activity</h2><p>Latest account and ERP actions.</p></div></div>
        {auditEntries.length ? <div className="table-scroll"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Record</th></tr></thead><tbody>
          {auditEntries.slice(0, 40).map((entry) => <tr key={entry.id}><td>{new Date(`${entry.created_at.replace(" ", "T")}Z`).toLocaleString()}</td><td>{entry.email ?? "System"}</td><td>{entry.action.replaceAll("_", " ")}</td><td>{entry.entity_type}{entry.entity_id ? ` · ${entry.entity_id.slice(0, 8)}` : ""}</td></tr>)}
        </tbody></table></div> : <p className="muted-copy">No audit entries are available.</p>}
      </section>
    </section>
  </main>;
}
