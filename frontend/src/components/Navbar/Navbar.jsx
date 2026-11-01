import { NavLink } from "react-router-dom";
import { FiBarChart2, FiBox, FiCreditCard, FiDollarSign, FiLogOut, FiPackage, FiSettings, FiShoppingCart, FiTrendingUp, FiUsers } from "react-icons/fi";
import "./Navbar.css";

const modules = [
  { code: "MM", title: "Materials Management", to: "/MMpg", icon: FiPackage, report: { label: "Inventory Reports", to: "/MMpg/reports" } },
  { code: "AP", title: "Accounts Payable", to: "/APpg", icon: FiCreditCard, children: [{ label: "Supplier Accounts", to: "/APpg/suppliers", icon: FiUsers }] },
  { code: "PRM", title: "Procurement Management", to: "/purchasing", icon: FiShoppingCart, report: { label: "Procurement Reports", to: "/purchasing/reports" } },
  { code: "SM", title: "Sales Management", to: "/SMpg", icon: FiTrendingUp, report: { label: "Sales Reports", to: "/SMpg/reports" } },
  { code: "FM", title: "Financial Management", to: "/FMpg", icon: FiDollarSign, report: { label: "Financial Reporting", to: "/FMpg/reports" } },
  { code: "PM", title: "Production Management", to: "/PMpg", icon: FiSettings, children: [{ label: "Jobcards", to: "/PMpg", icon: FiBox }], report: { label: "Production Reports", to: "/PMpg/reports" } },
];

export default function Navbar({ user, onLogout }) {
  const canView = (module) => user?.masterAdmin || user?.permissions?.[module]?.includes("view");
  const canReport = (module) => user?.masterAdmin || user?.permissions?.[module]?.includes("reports");
  const availableModules = modules.filter(({ code }) => canView(code) || canReport(code));

  return (
    <header className="topbar">
      <NavLink className="brand" to="/" aria-label="Mercurio home">
        <span className="brand-mark">M</span>
        <span>mercurio<span className="brand-light"> / ERP</span></span>
      </NavLink>
      <nav className="nav" aria-label="Management modules">
        {availableModules.map(({ code, title, to, icon: Icon, children, report }) => (
          <div className="module-menu" key={code}>
            <NavLink
              to={canView(code) ? to : report.to}
              className={({ isActive }) => `nav-link module-link${isActive ? " active" : ""}`}
              aria-label={`${code} ${title}`}
            >
              <span className="module-icon"><Icon aria-hidden="true" /></span>
              <span className="module-code">{code}</span>
              <span className="module-title">{title}</span>
            </NavLink>
            {(children || (report && canReport(code))) && <div className="module-dropdown">
              <div className="dropdown-heading">{code} · {title}</div>
              {canView(code) && children?.map(({ label, to: childTo, icon: ChildIcon }) => <NavLink key={childTo} to={childTo}><ChildIcon aria-hidden="true" />{label}</NavLink>)}
              {report && canReport(code) && <NavLink className="module-report-link" to={report.to}><FiBarChart2 aria-hidden="true" />{report.label}</NavLink>}
            </div>}
          </div>
        ))}
      </nav>
      <div className="topbar-account">
        {user?.masterAdmin && <NavLink className="admin-link" to="/admin"><FiUsers aria-hidden="true" /> Admin</NavLink>}
        <span className="account-email" title={user?.email}>{user?.email}</span>
        <button className="logout-button" type="button" onClick={onLogout} aria-label="Sign out"><FiLogOut aria-hidden="true" /><span>Sign out</span></button>
      </div>
    </header>
  );
}
