import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { erpApi } from "./erpApi.js";
import AdminDashboard from "./AdminDashboard.jsx";
import FinanceManagement from "./FinanceManagement.jsx";
import SalesManagement from "./SalesManagement.jsx";
import ModuleReports from "./ModuleReports.jsx";
import DocumentActions from "./DocumentActions.jsx";
import InventoryItemDetails from "./InventoryItemDetails.jsx";
import SupplierManagement from "./SupplierManagement.jsx";

const EMPTY_DATA = {
  categories: [],
  items: [],
  suppliers: [],
  purchaseOrders: [],
  invoices: [],
  jobcards: [],
  movements: [],
};
const today = () => new Date().toISOString().slice(0, 10);
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const FINANCIAL_YEAR_START_MONTH = 3;
const numberFormat = new Intl.NumberFormat("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatValue = (value) => numberFormat.format(Number(value) || 0);
const formatDate = (date) => date ? new Date(`${date}T00:00:00`).toLocaleDateString() : "—";
const financialYearStart = (date) => date.getMonth() + 1 >= FINANCIAL_YEAR_START_MONTH ? date.getFullYear() : date.getFullYear() - 1;

function emptyLine() {
  return { id: makeId(), itemId: "", quantity: "", unitCost: "" };
}

function LinesEditor({ lines, items, onChange }) {
  const updateLine = (id, field, value) => {
    onChange(lines.map((line) => line.id === id ? { ...line, [field]: value } : line));
  };

  return (
    <div className="lines-editor">
      {lines.map((line, index) => (
        <div className="line-editor-row" key={line.id}>
          <label className="field line-item">
            <span>Item {index + 1}</span>
            <select required value={line.itemId} onChange={(event) => updateLine(line.id, "itemId", event.target.value)}>
              <option value="">Select inventory item</option>
              {items.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.sku}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Quantity</span>
            <input required type="number" min="0.001" step="any" value={line.quantity} onChange={(event) => updateLine(line.id, "quantity", event.target.value)} />
          </label>
          <label className="field">
            <span>Unit cost</span>
            <input required type="number" min="0" step="0.01" value={line.unitCost} onChange={(event) => updateLine(line.id, "unitCost", event.target.value)} />
          </label>
          {lines.length > 1 && (
            <button className="icon-button remove-line" type="button" aria-label={`Remove item ${index + 1}`} onClick={() => onChange(lines.filter((entry) => entry.id !== line.id))}>×</button>
          )}
        </div>
      ))}
      <button className="text-button" type="button" onClick={() => onChange([...lines, emptyLine()])}>＋ Add another item</button>
    </div>
  );
}

function StatCard({ label, value, note, tone = "green" }) {
  return (
    <article className={`stat-card tone-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{note}</div>
    </article>
  );
}

function PageHeader({ eyebrow, title, description, action }) {
  return (
    <div className="page-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export default function ERPWorkspace({ initialUser }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const invoiceId = searchParams.get("invoiceId");
  const jobcardId = searchParams.get("jobcardId");
  const [data, setData] = useState(EMPTY_DATA);
  const [storageError, setStorageError] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [purchaseTab, setPurchaseTab] = useState("orders");
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [selectedInvoiceOrderId, setSelectedInvoiceOrderId] = useState("");
  const [showForm, setShowForm] = useState("");
  const [issueJobId, setIssueJobId] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [reportYear] = useState(String(financialYearStart(new Date())));
  const [newCategory, setNewCategory] = useState("");

  const refreshWorkspace = useCallback(async () => {
    try {
      const workspace = await erpApi.getWorkspace();
      setData(workspace);
      setStorageError("");
      return workspace;
    } catch (error) {
      setStorageError(error.message);
      throw error;
    }
  }, []);

  useEffect(() => {
    let active = true;
    async function loadWorkspace() {
      try {
        const workspace = await erpApi.getWorkspace();
        if (active) {
          setData(workspace);
          setStorageError("");
        }
      } catch (error) {
        if (active) setStorageError(error.message);
      } finally {
        if (active) setLoading(false);
      }
    }
    loadWorkspace();
    return () => { active = false; };
  }, []);

  const quantities = useMemo(() => {
    return new Map(data.items.map((item) => [item.id, item.onHand ?? 0]));
  }, [data.items]);

  const currentMonth = today().slice(0, 7);
  const monthInvoices = data.invoices.filter((invoice) => invoice.date?.startsWith(currentMonth));
  const monthValue = monthInvoices.reduce((total, invoice) => total + invoice.total, 0);
  const lowStock = data.items.filter((item) => (
    (quantities.get(item.id) ?? 0) - (item.reserved ?? 0) <= Number(item.minStock)
  ));
  const openOrders = data.purchaseOrders.filter((order) => order.status !== "Received");
  const activeJobcards = data.jobcards.filter((jobcard) => jobcard.status !== "Completed");
  const view = ({
    "/MMpg": "inventory",
    "/MMpg/reports": "inventoryReports",
    "/purchasing": "purchasing",
    "/purchasing/reports": "procurementReports",
    "/APpg": "accountsPayable",
    "/APpg/suppliers": "suppliers",
    "/PMpg": "jobcards",
    "/PMpg/reports": "productionReports",
    "/FMpg": "finance",
    "/FMpg/reports": "financialReports",
    "/SMpg": "sales",
    "/SMpg/reports": "salesReports",
    "/admin": "admin",
  })[location.pathname] ?? "overview";
  const canView = (module) => initialUser.masterAdmin || initialUser.permissions?.[module]?.includes("view");
  const canCreate = (module) => initialUser.masterAdmin || initialUser.permissions?.[module]?.includes("create");
  const canEdit = (module) => initialUser.masterAdmin || initialUser.permissions?.[module]?.includes("edit");
  const requiredModule = ({
    inventory: "MM", inventoryReports: "MM",
    purchasing: "PRM", procurementReports: "PRM",
    accountsPayable: "AP", suppliers: "AP",
    jobcards: "PM", productionReports: "PM",
    finance: "FM", financialReports: "FM",
    sales: "SM", salesReports: "SM",
  })[view];
  const reportModule = ({
    inventoryReports: "MM",
    procurementReports: "PRM",
    productionReports: "PM",
    financialReports: "FM",
    salesReports: "SM",
  })[view];
  const canReport = (module) => initialUser.masterAdmin || initialUser.permissions?.[module]?.includes("reports");

  const showNotice = (message) => {
    setNotice(message);
    setFormError("");
    setShowForm("");
  };
  const setPurchaseView = (tab) => {
    setPurchaseTab(tab);
    if (invoiceId) {
      const params = new URLSearchParams(searchParams);
      params.delete("invoiceId");
      setSearchParams(params, { replace: true });
    }
  };
  const validateLines = (lines) => lines.every((line) => (
    line.itemId
    && data.items.some((item) => item.id === line.itemId)
    && Number.isFinite(Number(line.quantity))
    && Number(line.quantity) > 0
    && Number.isFinite(Number(line.unitCost))
    && Number(line.unitCost) >= 0
  ));
  const prepareLines = (lines) => lines.map((line) => ({
    itemId: line.itemId,
    quantity: Number(line.quantity),
    unitCost: Number(line.unitCost),
    total: Number(line.quantity) * Number(line.unitCost),
  }));

  const createItem = async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const sku = String(form.get("sku")).trim();
    const item = {
      name: String(form.get("name")).trim(),
      sku,
      unit: String(form.get("unit")).trim(),
      minStock: Number(form.get("minStock")),
    };
    try {
      await erpApi.createItem(item);
      await refreshWorkspace();
      showNotice(`${item.name} was added to inventory.`);
      formElement.reset();
    } catch (error) {
      setFormError(error.message);
    }
  };

  const createOrder = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const lines = formLines(event.currentTarget);
    const supplierId = String(form.get("supplierId"));
    const supplier = data.suppliers.find((entry) => entry.id === supplierId && entry.active);
    if (!supplier) {
      setFormError("Select an active registered supplier for this purchase order.");
      return;
    }
    if (!validateLines(lines)) {
      setFormError("Add at least one valid item, quantity, and unit cost.");
      return;
    }
    const order = {
      reference: String(form.get("reference")).trim(),
      supplierId,
      date: String(form.get("date")),
      lines: prepareLines(lines),
    };
    try {
      await erpApi.createOrder(order);
      await refreshWorkspace();
      showNotice(`Purchase order ${order.reference} for ${supplier.name} was created. Stock is added only when its invoice is posted.`);
    } catch (error) {
      setFormError(error.message);
    }
  };

  const createInvoice = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const lines = formLines(event.currentTarget);
    if (!validateLines(lines)) {
      setFormError("Add at least one valid item, quantity, and unit cost.");
      return;
    }
    const supplier = data.suppliers.find((entry) => entry.id === String(form.get("supplierId")) && entry.active);
    if (!supplier) {
      setFormError("Select an active registered supplier for this invoice.");
      return;
    }
    const invoice = {
      reference: String(form.get("reference")).trim(),
      supplierId: supplier.id,
      date: String(form.get("date")),
      orderId: String(form.get("orderId")) || null,
      lines: prepareLines(lines),
    };
    try {
      await erpApi.createInvoice(invoice);
      await refreshWorkspace();
      showNotice(`Invoice ${invoice.reference} was posted and its items were received into stock.`);
    } catch (error) {
      setFormError(error.message);
    }
  };

  const createJobcard = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const jobcard = {
      reference: String(form.get("reference")).trim(),
      title: String(form.get("title")).trim(),
      customer: String(form.get("customer")).trim(),
      categoryId: String(form.get("categoryId")),
      date: String(form.get("date")),
      status: "Open",
    };
    try {
      await erpApi.createJobcard(jobcard);
      await refreshWorkspace();
      showNotice(`Jobcard ${jobcard.reference} was created.`);
    } catch (error) {
      setFormError(error.message);
    }
  };

  const issueStock = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const itemId = String(form.get("itemId"));
    const jobId = String(form.get("jobId"));
    const quantity = Number(form.get("quantity"));
    const item = data.items.find((entry) => entry.id === itemId);
    const jobcard = data.jobcards.find((entry) => entry.id === jobId);
    if (!item || !jobcard || !Number.isFinite(quantity) || quantity <= 0) {
      setFormError("Select a jobcard and inventory item, then enter a valid quantity.");
      return;
    }
    const available = (quantities.get(itemId) ?? 0) - (item.reserved ?? 0);
    if (quantity > available) {
      setFormError(`Only ${available} ${item.unit} available. Reduce the issue quantity or receive more stock.`);
      return;
    }
    try {
      await erpApi.reserveJobcardMaterial(jobId, { itemId, quantity });
      await refreshWorkspace();
      setIssueJobId("");
      showNotice(`${quantity} ${item.unit} of ${item.name} reserved for ${jobcard.reference}. Stock will be deducted when the job is completed and closed.`);
    } catch (error) {
      setFormError(error.message);
    }
  };

  const addCategory = async (event) => {
    event.preventDefault();
    const name = newCategory.trim();
    if (!name) return;
    try {
      await erpApi.createCategory(name);
      await refreshWorkspace();
      setNewCategory("");
      setFormError("");
      setNotice(`Category "${name}" was added.`);
    } catch (error) {
      setFormError(error.message);
    }
  };

  const updateJobcardStatus = async (jobId, status) => {
    if (status === "Completed" && !window.confirm("Complete and close this jobcard? All reserved materials will be deducted from stock.")) return;
    try {
      await erpApi.updateJobcardStatus(jobId, status);
      await refreshWorkspace();
      setNotice(status === "Completed" ? "Jobcard closed and reserved stock deducted." : "Jobcard status updated.");
    } catch (error) {
      setFormError(error.message);
    }
  };

  const removeReservedMaterial = async (jobId, materialId) => {
    try {
      await erpApi.removeJobcardMaterial(jobId, materialId);
      await refreshWorkspace();
      setNotice("Reserved material removed from the jobcard.");
    } catch (error) {
      setFormError(error.message);
    }
  };

  const pageInfo = {
    overview: ["WORKSPACE", "Operations overview", "A live view of stock, purchasing, and production activity."],
    inventory: ["MM · MATERIALS MANAGEMENT", "Inventory", "Keep item records, stock levels, and movement history in one place."],
    inventoryReports: ["MM · MATERIALS MANAGEMENT", "Inventory reports", "Review stock valuation, receipts, issues, and item movement."],
    purchasing: ["PRM · PROCUREMENT MANAGEMENT", "Purchasing", "Manage purchase orders and post supplier invoices to receive stock."],
    procurementReports: ["PRM · PROCUREMENT MANAGEMENT", "Procurement reports", "Review monthly purchases, supplier invoices, and purchase orders."],
    accountsPayable: ["AP · ACCOUNTS PAYABLE", "Accounts payable", "Review supplier invoices, record payments, and keep ledger balances in sync."],
    suppliers: ["AP · ACCOUNTS PAYABLE", "Supplier accounts", "Maintain supplier codes, contacts, account status, and expected inventory items."],
    jobcards: ["PM · PRODUCTION MANAGEMENT", "Jobcards", "Organise work by category and record every inventory issue against a job."],
    productionReports: ["PM · PRODUCTION MANAGEMENT", "Production reports", "Review jobcard volumes, completion, categories, and material consumption."],
    finance: ["FM · FINANCIAL MANAGEMENT", "Financial management", "Review the ledger, financial statements, payables, receivables, and stock takes."],
    financialReports: ["FM · FINANCIAL MANAGEMENT", "Financial reporting", "Review the general ledger, trial balance, balance sheet, and profit and loss."],
    sales: ["SM · SALES MANAGEMENT", "Sales management", "Create customer invoices, track receivables, and review sales activity."],
    salesReports: ["SM · SALES MANAGEMENT", "Sales reports", "Review customer performance, monthly sales, and outstanding balances."],
    admin: ["SYSTEM ADMINISTRATION", "Admin dashboard", "Manage user accounts and configure module-level privileges."],
  }[view];

  if (view === "admin") return <AdminDashboard />;

  return (
    <main className="workspace">
      <aside className="side-rail">
        <div className="rail-label">WORKSPACE</div>
        <NavItem to="/" label="Overview" icon="⌂" active={view === "overview"} />
        <div className="rail-label rail-section">MANAGEMENT MODULES</div>
        {canView("MM") && <NavItem to="/MMpg" label="MM · Materials" icon="▦" active={view === "inventory"} badge={lowStock.length || null} />}
        {canView("PRM") && <>
          <div className="rail-label rail-section">PRM · PROCUREMENT MANAGEMENT</div>
          <NavItem to="/purchasing" label="Purchase documents" icon="↗" active={view === "purchasing"} badge={openOrders.length || null} />
        </>}
        {canView("AP") && <>
          <div className="rail-label rail-section">AP · ACCOUNTS PAYABLE</div>
          <NavItem to="/APpg" label="Accounts payable" icon="▣" active={view === "accountsPayable"} />
          <NavItem to="/APpg/suppliers" label="Supplier accounts" icon="♧" active={view === "suppliers"} nested />
        </>}
        {canView("PRM") && (initialUser.masterAdmin || initialUser.permissions?.PRM?.includes("reports")) && <>
          <div className="rail-label rail-section">PRM · REPORTING</div>
          <NavItem to="/purchasing/reports" label="Procurement reports" icon="▤" active={view === "procurementReports"} nested />
        </>}
        {canView("SM") && <NavItem to="/SMpg" label="SM · Sales" icon="◫" active={view === "sales"} />}
        {canView("FM") && <NavItem to="/FMpg" label="FM · Financial" icon="▥" active={view === "finance"} />}
        {canView("PM") && <>
          <div className="rail-label rail-section">PM · PRODUCTION MANAGEMENT</div>
          <NavItem to="/PMpg" label="Jobcards" icon="▤" active={view === "jobcards"} />
        </>}
        <div className="rail-footnote">
          <div className="rail-footnote-dot" />
          <span>Connected workspace<br /><small>SQLite · March–February FY</small></span>
        </div>
      </aside>

      <section className="workspace-content">
        <PageHeader eyebrow={pageInfo[0]} title={pageInfo[1]} description={pageInfo[2]} />
        {storageError && <div className="alert error" role="alert">{storageError}</div>}
        {notice && <div className="alert success" role="status">{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div>}
        {formError && <div className="alert error" role="alert">{formError}</div>}
        {loading && <div className="loading-state">Connecting to the ERP database…</div>}
        {!loading && requiredModule && !canView(requiredModule) && (
          !reportModule || !canReport(reportModule) ? <section className="panel"><div className="empty-state"><strong>Access not granted</strong><p>Your administrator has not granted you the required access to this management module.</p></div></section> : null
        )}
        {!loading && reportModule && canReport(reportModule) && view !== "financialReports" && (
          <ModuleReports module={reportModule} canViewPurchasing={canView("PRM")} canViewJobcards={canView("PM")} />
        )}

        {!loading && view === "overview" && (
          <Overview
            data={data}
            quantities={quantities}
            lowStock={lowStock}
            openOrders={openOrders}
            monthValue={monthValue}
            activeJobcards={activeJobcards}
            canViewInventory={canView("MM")}
            canViewPurchasing={canView("PRM")}
          />
        )}
        {!loading && view === "inventory" && canView("MM") && (
          <Inventory
            data={data}
            quantities={quantities}
            lowStock={lowStock}
            search={itemSearch}
            setSearch={setItemSearch}
            showForm={showForm}
            setShowForm={setShowForm}
              onCreateItem={createItem}
            financialYear={reportYear}
              canCreate={canCreate("MM")}
              canEdit={canEdit("MM")}
              canReport={initialUser.masterAdmin || initialUser.permissions?.MM?.includes("reports")}
              canViewPurchasing={canView("PRM")}
              canViewJobcards={canView("PM")}
          />
        )}
        {!loading && view === "purchasing" && canView("PRM") && (
          <Purchasing
            data={data}
            tab={purchaseTab}
            setTab={(tab) => { setPurchaseView(tab); setSelectedSupplierId(""); setSelectedInvoiceOrderId(""); }}
            showForm={showForm}
            setShowForm={setShowForm}
            onCreateOrder={createOrder}
            onCreateInvoice={createInvoice}
            selectedInvoiceId={invoiceId}
            selectedSupplierId={selectedSupplierId}
            setSelectedSupplierId={setSelectedSupplierId}
            selectedInvoiceOrderId={selectedInvoiceOrderId}
            setSelectedInvoiceOrderId={setSelectedInvoiceOrderId}
            canManageSuppliers={canView("AP")}
            canCreate={canCreate("PRM")}
            onDocumentSent={(message) => { setNotice(message); setFormError(""); }}
          />
        )}
        {!loading && view === "suppliers" && canView("AP") && (
          <SupplierManagement
            suppliers={data.suppliers}
            items={data.items}
            canCreate={canCreate("AP")}
            canEdit={canEdit("AP")}
            onChanged={refreshWorkspace}
          />
        )}
        {!loading && view === "accountsPayable" && canView("AP") && (
          <FinanceManagement canCreate={canCreate("AP")} canEdit={canEdit("AP")} initialTab="creditors" allowedTabs={["creditors"]} />
        )}
        {!loading && view === "jobcards" && canView("PM") && (
          <Jobcards
            data={data}
            quantities={quantities}
            selectedCategory={selectedCategory}
            setSelectedCategory={setSelectedCategory}
            showForm={showForm}
            setShowForm={setShowForm}
            onCreateJobcard={createJobcard}
            onStatusChange={updateJobcardStatus}
            onRemoveMaterial={removeReservedMaterial}
            selectedJobcardId={jobcardId}
            issueJobId={issueJobId}
            setIssueJobId={setIssueJobId}
            onIssueStock={issueStock}
            newCategory={newCategory}
            setNewCategory={setNewCategory}
            onAddCategory={addCategory}
            canCreate={canCreate("PM")}
            canEdit={canEdit("PM")}
          />
        )}
        {!loading && view === "finance" && canView("FM") && <FinanceManagement canCreate={canCreate("FM")} canEdit={canEdit("FM")} workspaceData={data} />}
        {!loading && view === "financialReports" && (canReport("FM") || canView("FM")) && <FinanceManagement key="financial-reports" reporting canCreate={false} canEdit={false} workspaceData={data} />}
        {!loading && view === "sales" && canView("SM") && <SalesManagement canCreate={canCreate("SM")} />}
      </section>
    </main>
  );
}

function NavItem({ to, label, icon, active, badge, nested = false }) {
  return (
    <Link className={`rail-link${active ? " active" : ""}${nested ? " rail-link-nested" : ""}`} to={to}>
      <span className="rail-icon" aria-hidden="true">{icon}</span>
      <span>{label}</span>
      {badge && <span className="rail-badge">{badge}</span>}
    </Link>
  );
}

function Overview({ data, quantities, lowStock, openOrders, monthValue, activeJobcards, canViewInventory, canViewPurchasing }) {
  const recentMovements = [...data.movements].slice(0, 6);
  const recentInvoices = data.invoices.slice(0, 5);
  return (
    <>
      <div className="stats-grid">
        <StatCard label="Inventory items" value={data.items.length} note={`${lowStock.length} at or below reorder level`} tone="green" />
        <StatCard label="Purchase value · this month" value={formatValue(monthValue)} note="Posted supplier invoices" tone="blue" />
        <StatCard label="Open purchase orders" value={openOrders.length} note="Awaiting receipt / invoice" tone="orange" />
        <StatCard label="Active jobcards" value={activeJobcards.length} note={`${data.jobcards.length} jobcards in total`} tone="purple" />
      </div>

      <div className="overview-grid">
        <section className="panel">
          <div className="panel-heading">
            <div><h2>Stock watch</h2><p>Items at or below their reorder level</p></div>
            {canViewInventory && <Link className="subtle-link" to="/MMpg">View inventory <span>→</span></Link>}
          </div>
          {lowStock.length ? (
            <div className="table-scroll"><table>
              <thead><tr><th>Item</th><th>SKU</th><th>On hand</th><th>Reorder at</th></tr></thead>
              <tbody>{lowStock.slice(0, 5).map((item) => (
                <tr key={item.id}><td className="primary-cell">{item.name}</td><td>{item.sku}</td><td className="warning-text">{quantities.get(item.id) ?? 0} {item.unit}</td><td>{item.minStock} {item.unit}</td></tr>
              ))}</tbody>
            </table></div>
          ) : <EmptyState title="No stock alerts" text="Add items to inventory and set reorder levels to monitor shortages." />}
        </section>
        <section className="panel">
          <div className="panel-heading"><div><h2>Recent activity</h2><p>Latest stock receipts and jobcard issues</p></div></div>
          {recentMovements.length ? <MovementList movements={recentMovements} items={data.items} /> : <EmptyState title="No stock movements yet" text="Posted supplier invoices and jobcard issues will appear here." />}
        </section>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div><h2>Recent supplier invoices</h2><p>Posted invoices are added to stock and purchase reports</p></div>
          {canViewPurchasing && <Link className="subtle-link" to="/purchasing">Open purchasing <span>→</span></Link>}
        </div>
        {recentInvoices.length ? (
          <div className="table-scroll"><table>
            <thead><tr><th>Invoice</th><th>Supplier</th><th>Date</th><th>Items</th><th className="align-right">Value</th><th>Status</th></tr></thead>
            <tbody>{recentInvoices.map((invoice) => (
              <tr key={invoice.id}><td className="primary-cell">{invoice.reference}</td><td>{invoice.supplier}</td><td>{formatDate(invoice.date)}</td><td>{invoice.lines.length}</td><td className="align-right">{formatValue(invoice.total)}</td><td><span className="status-pill status-posted">{invoice.status}</span></td></tr>
            ))}</tbody>
          </table></div>
        ) : <EmptyState title="No invoices posted" text="Create a supplier invoice to record a purchase and receive stock." action={canViewPurchasing ? <Link className="button button-primary button-small" to="/purchasing">Create invoice</Link> : null} />}
      </section>
    </>
  );
}

function Inventory({ data, quantities, lowStock, search, setSearch, showForm, setShowForm, onCreateItem, financialYear, canCreate, canEdit, canReport, canViewPurchasing, canViewJobcards }) {
  const [selectedItem, setSelectedItem] = useState(null);
  const [detailsItem, setDetailsItem] = useState(null);
  const [detailsNotice, setDetailsNotice] = useState("");
  const [itemReport, setItemReport] = useState(null);
  const [reportError, setReportError] = useState("");
  const [reportYear, setReportYear] = useState(financialYear);
  const filteredItems = data.items.filter((item) => `${item.name} ${item.sku}`.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    if (!selectedItem) return undefined;
    let active = true;
    erpApi.getItemReport(selectedItem.id, reportYear)
      .then((report) => {
        if (active) setItemReport(report);
      })
      .catch((error) => {
        if (active) setReportError(error.message);
      });
    return () => { active = false; };
  }, [reportYear, selectedItem]);
  const isReportCurrent = itemReport?.item?.id === selectedItem?.id
    && itemReport?.financialYear?.startYear === Number(reportYear);
  const reportLoading = Boolean(selectedItem && !isReportCurrent && !reportError);

  return (
    <>
      <div className="stats-grid compact-stats">
        <StatCard label="Items tracked" value={data.items.length} note="Active inventory records" />
        <StatCard label="Items below reorder" value={lowStock.length} note="Review and replenish" tone="orange" />
        <StatCard label="Stock movements" value={data.movements.length} note="Receipts and jobcard issues" tone="blue" />
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div><h2>Inventory items</h2><p>On-hand balances update from posted invoices and jobcard issues.</p></div>
          {canCreate && <button className="button button-primary" type="button" onClick={() => setShowForm(showForm === "item" ? "" : "item")}>＋ New item</button>}
        </div>
        {detailsNotice && <div className="alert success inventory-details-notice" role="status">{detailsNotice}<button type="button" aria-label="Dismiss message" onClick={() => setDetailsNotice("")}>×</button></div>}
        {showForm === "item" && (
          <form className="form-card" onSubmit={onCreateItem}>
            <div className="form-title"><strong>Add inventory item</strong><span>Opening quantities are recorded through supplier invoices.</span></div>
            <div className="form-grid">
              <label className="field"><span>Item name</span><input name="name" required maxLength="100" placeholder="e.g. 3mm white acrylic" /></label>
              <label className="field"><span>SKU / item code</span><input name="sku" required maxLength="40" placeholder="e.g. MAT-003" /></label>
              <label className="field"><span>Unit of measure</span><input name="unit" required maxLength="20" defaultValue="pcs" placeholder="pcs, sheet, kg..." /></label>
              <label className="field"><span>Reorder level</span><input name="minStock" required type="number" min="0" step="any" defaultValue="0" /></label>
            </div>
            <FormActions onCancel={() => setShowForm("")} submit="Save item" />
          </form>
        )}
        <div className="table-toolbar">
          <label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="Search inventory" placeholder="Search name or SKU..." value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <span className="result-count">{filteredItems.length} items</span>
        </div>
        {filteredItems.length ? (
          <div className="table-scroll"><table>
            <thead><tr><th>SKU</th><th>Description</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Reorder at</th><th>Stock status</th><th>Item details</th><th>Item report</th></tr></thead>
            <tbody>{filteredItems.map((item) => {
              const stock = quantities.get(item.id) ?? 0;
              const reserved = item.reserved ?? 0;
              const available = stock - reserved;
              const low = stock <= Number(item.minStock);
              return <tr key={item.id}>
                <td className="primary-cell">{item.sku}</td>
                <td>{item.name}</td>
                <td>{stock} {item.unit}</td>
                <td>{reserved} {item.unit}</td>
                <td>{available} {item.unit}</td>
                <td>{item.minStock} {item.unit}</td>
                <td><span className={`status-pill ${low ? "status-low" : "status-posted"}`}>{low ? "Reorder" : "In stock"}</span></td>
                <td><button className="icon-button details-button" type="button" aria-label={`View ${item.sku} details`} title="Notes, supplier code, and picture" onClick={() => { setDetailsNotice(""); setDetailsItem({ ...item }); }}>ⓘ</button></td>
                <td>{canReport && <button className="icon-button report-button" type="button" aria-label={`View ${item.sku} financial year report`} title="View item financial year report" onClick={() => { setItemReport(null); setReportError(""); setReportYear(financialYear); setSelectedItem({ ...item }); }}>▤</button>}</td>
              </tr>;
            })}</tbody>
          </table></div>
        ) : <EmptyState title={search ? "No matching items" : "Your inventory is empty"} text={search ? "Try another name or SKU." : "Create an item, then post a supplier invoice to receive its first stock."} />}
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Stock movement history</h2><p>A traceable record of receipts and jobcard issues.</p></div></div>
        {data.movements.length ? <MovementList movements={data.movements.slice(0, 10)} items={data.items} /> : <EmptyState title="No movements recorded" text="Stock transactions will be listed here as they happen." />}
      </section>
      {selectedItem && (
        <ItemReport
          item={selectedItem}
          report={itemReport}
          year={reportYear}
          loading={reportLoading}
          error={reportError}
          canViewPurchasing={canViewPurchasing}
          canViewJobcards={canViewJobcards}
          onYearChange={(nextYear) => { setReportError(""); setItemReport(null); setReportYear(nextYear); }}
          onClose={() => setSelectedItem(null)}
        />
      )}
      {detailsItem && <InventoryItemDetails
        item={detailsItem}
        canEdit={canEdit}
        onClose={() => setDetailsItem(null)}
        onSaved={(message) => { setDetailsNotice(message); setDetailsItem(null); }}
      />}
    </>
  );
}

function ItemReport({ item, report, year, loading, error, onYearChange, onClose, canViewPurchasing, canViewJobcards }) {
  const months = report?.months ?? [];
  const years = Array.from({ length: 7 }, (_, index) => Number(year) - 5 + index);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="item-report-modal" role="dialog" aria-modal="true" aria-labelledby="item-report-title">
        <div className="report-modal-header">
          <div>
            <div className="eyebrow">INVENTORY MOVEMENT REPORT</div>
            <h2 id="item-report-title">{item.sku} · {item.name}</h2>
            <p>Financial year {year}–{Number(year) + 1} · March 1 to February 28/29</p>
          </div>
          <div className="report-modal-actions">
            <label className="field report-year-select"><span>Financial year</span><select value={year} onChange={(event) => onYearChange(event.target.value)}>{years.map((entry) => <option value={entry} key={entry}>{entry}–{entry + 1}</option>)}</select></label>
            <button className="icon-button report-close" type="button" aria-label="Close item report" onClick={onClose}>×</button>
          </div>
        </div>
        {loading && <div className="loading-state">Loading item report…</div>}
        {error && <div className="alert error" role="alert">{error}</div>}
        {!loading && report && (
          <>
            <div className="report-period-summary">
              <span>Current on hand <strong>{item.onHand} {item.unit}</strong></span>
              <span>Reserved for open jobs <strong>{item.reserved} {item.unit}</strong></span>
            </div>
            <div className="report-subheading"><div><h3>Monthly movement</h3><p>Quantities received and closed out to jobcards.</p></div></div>
            <div className="table-scroll report-table">
              <table>
                <thead><tr><th>Month</th><th>Brought in</th><th>Taken out</th></tr></thead>
                <tbody>{months.map((month) => (
                  <tr key={month.month}>
                    <td>{new Date(`${month.month}-01T00:00:00`).toLocaleString(undefined, { month: "long", year: "numeric" })}</td>
                    <td className="received-text">{month.broughtIn} {item.unit}</td>
                    <td className="warning-text">{month.takenOut} {item.unit}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="report-subheading"><div><h3>Movement detail</h3><p>Each receipt links to its supplier invoice; each deduction links to its jobcard.</p></div></div>
            {report.movements.length ? (
              <div className="table-scroll report-table">
                <table>
                  <thead><tr><th>Date</th><th>Movement</th><th>Quantity</th><th>Reference</th><th>Open record</th></tr></thead>
                  <tbody>{report.movements.map((movement) => {
                    const receipt = movement.quantity > 0;
                    const document = receipt ? movement.invoice : movement.jobcard;
                    const destination = receipt
                      ? `/purchasing?invoiceId=${movement.invoiceId}`
                      : `/PMpg?jobcardId=${movement.jobcardId}`;
                    const canOpenDocument = receipt ? canViewPurchasing : canViewJobcards;
                    return <tr key={movement.id}>
                      <td>{formatDate(movement.date)}</td>
                      <td>{receipt ? "Goods received" : "Jobcard deduction"}</td>
                      <td className={receipt ? "received-text" : "warning-text"}>{receipt ? "+" : "−"}{Math.abs(movement.quantity)} {item.unit}</td>
                      <td>{movement.reference}</td>
                      <td>{document && canOpenDocument ? <Link className="record-link" to={destination} onClick={onClose}>{receipt ? `Supplier invoice · ${document.reference}` : `Jobcard · ${document.reference}`}</Link> : document ? <span className="muted-text">{receipt ? "Supplier invoice" : "Jobcard"} · {document.reference} · access not granted</span> : <span className="muted-text">Source record unavailable</span>}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            ) : <EmptyState title="No movement in this financial year" text="Receipts and completed jobcard deductions will appear here line by line." />}
          </>
        )}
      </section>
    </div>
  );
}

function Purchasing({
  data, tab, setTab, showForm, setShowForm, onCreateOrder, onCreateInvoice, selectedInvoiceId,
  selectedSupplierId, setSelectedSupplierId, selectedInvoiceOrderId, setSelectedInvoiceOrderId,
  canManageSuppliers, canCreate, onDocumentSent,
}) {
  const [lines, setLines] = useState([emptyLine()]);
  const [reference, setReference] = useState("");
  const nextOrderRef = `PO-${new Date().getFullYear()}-${String(data.purchaseOrders.length + 1).padStart(3, "0")}`;
  const nextInvoiceRef = `INV-${new Date().getFullYear()}-${String(data.invoices.length + 1).padStart(3, "0")}`;
  const selectedInvoice = data.invoices.find((invoice) => invoice.id === selectedInvoiceId);
  const activeTab = selectedInvoiceId ? "invoices" : tab;
  const selectedSupplier = data.suppliers.find((supplier) => supplier.id === selectedSupplierId);
  const expectedItems = selectedSupplier?.itemIds.length
    ? data.items.filter((item) => selectedSupplier.itemIds.includes(item.id))
    : data.items;
  const linkableOrders = data.purchaseOrders.filter((order) => order.status !== "Received"
    && (!selectedSupplierId || (order.supplierId
      ? order.supplierId === selectedSupplierId
      : order.supplier.toLowerCase() === selectedSupplier?.name.toLowerCase())));
  return (
    <>
      {selectedInvoice && <InvoiceDetails invoice={selectedInvoice} items={data.items} />}
      <div className="stats-grid compact-stats">
        <StatCard label="Purchase orders" value={data.purchaseOrders.length} note={`${data.purchaseOrders.filter((order) => order.status === "Open").length} open`} />
        <StatCard label="Supplier invoices" value={data.invoices.length} note="Posted purchase records" tone="blue" />
        <StatCard label="Posted purchase value" value={formatValue(data.invoices.reduce((sum, invoice) => sum + invoice.total, 0))} note="All recorded invoices" tone="green" />
      </div>
      <section className="panel">
        <div className="panel-heading panel-heading-tabs">
          <div><h2>Procurement documents</h2><p>Purchase orders do not add stock. Posting a supplier invoice receives stock.</p></div>
          <div className="segmented-control" role="tablist" aria-label="Purchasing records">
            <button type="button" role="tab" aria-selected={activeTab === "orders"} className={activeTab === "orders" ? "selected" : ""} onClick={() => { setTab("orders"); setShowForm(""); }}>Purchase orders <span>{data.purchaseOrders.length}</span></button>
            <button type="button" role="tab" aria-selected={activeTab === "invoices"} className={activeTab === "invoices" ? "selected" : ""} onClick={() => { setTab("invoices"); setShowForm(""); }}>Supplier invoices <span>{data.invoices.length}</span></button>
          </div>
        </div>
        <div className="document-actions">
          <p>{activeTab === "orders" ? "Plan and track orders with suppliers." : "Post invoices to update on-hand stock and purchase reports."}</p>
          {canCreate && <button className="button button-primary" type="button" onClick={() => { setShowForm(showForm === activeTab ? "" : activeTab); setLines([emptyLine()]); setReference(activeTab === "orders" ? nextOrderRef : nextInvoiceRef); setSelectedSupplierId(""); setSelectedInvoiceOrderId(""); }}>＋ {activeTab === "orders" ? "New purchase order" : "New supplier invoice"}</button>}
        </div>
        {showForm === activeTab && (
          <form className="form-card" onSubmit={activeTab === "orders" ? onCreateOrder : onCreateInvoice}>
            <input type="hidden" name="__lines" value={JSON.stringify(lines)} />
            <div className="form-title"><strong>{activeTab === "orders" ? "Create purchase order" : "Post supplier invoice"}</strong><span>{activeTab === "orders" ? "The order will not change stock on hand." : "Posting receives the listed quantities into inventory."}</span></div>
            <div className="form-grid form-grid-three">
              <label className="field"><span>{activeTab === "orders" ? "PO reference" : "Invoice reference"}</span><input name="reference" required maxLength="60" value={reference} onChange={(event) => setReference(event.target.value)} /></label>
              <label className="field"><span>Supplier account</span><select name="supplierId" required value={selectedSupplierId} onChange={(event) => { setSelectedSupplierId(event.target.value); setSelectedInvoiceOrderId(""); }}><option value="">Choose a registered supplier</option>{data.suppliers.filter((supplier) => supplier.active).map((supplier) => <option value={supplier.id} key={supplier.id}>{supplier.code} · {supplier.name}</option>)}</select></label>
              <label className="field"><span>{activeTab === "orders" ? "Order date" : "Invoice date"}</span><input name="date" type="date" required defaultValue={today()} /></label>
              {activeTab === "invoices" && (
                <label className="field"><span>Link purchase order <small>Optional</small></span>
                  <select name="orderId" value={selectedInvoiceOrderId} onChange={(event) => {
                    setSelectedInvoiceOrderId(event.target.value);
                    const order = data.purchaseOrders.find((entry) => entry.id === event.target.value);
                    if (order) {
                      const orderSupplier = order.supplierId
                        ? data.suppliers.find((entry) => entry.id === order.supplierId)
                        : data.suppliers.find((entry) => entry.name.toLowerCase() === order.supplier.toLowerCase());
                      if (orderSupplier) setSelectedSupplierId(orderSupplier.id);
                    }
                  }}><option value="">No linked order</option>{linkableOrders.map((order) => <option value={order.id} key={order.id}>{order.reference} · {order.supplier} · {order.status}</option>)}</select>
                </label>
              )}
            </div>
            <div className="field-section-title">Line items</div>
            {!data.suppliers.some((supplier) => supplier.active) && <div className="inline-notice supplier-required-notice">Register an active supplier account before creating a purchase document. {canManageSuppliers ? <Link to="/APpg/suppliers">Manage supplier accounts →</Link> : <span>Ask an administrator to register a supplier account.</span>}</div>}
            {data.items.length ? (
              <>
                {selectedSupplier?.itemIds.length > 0 && <div className="supplier-catalog-hint">Showing inventory items in {selectedSupplier.code}’s expected catalog.</div>}
                <LinesEditor lines={lines} items={expectedItems} onChange={setLines} />
                <FormActions onCancel={() => setShowForm("")} submit={activeTab === "orders" ? "Create purchase order" : "Post invoice and receive stock"} />
              </>
            ) : <div className="inline-notice">Add an inventory item before creating a purchase document. <Link to="/MMpg">Go to inventory →</Link></div>}
          </form>
        )}
        {activeTab === "orders" ? <PurchaseOrders orders={data.purchaseOrders} canEmail={canCreate} onDocumentSent={onDocumentSent} /> : <Invoices invoices={data.invoices} canEmail={canCreate} onDocumentSent={onDocumentSent} />}
      </section>
    </>
  );
}

function formLines(form) {
  const serialized = new FormData(form).get("__lines");
  try {
    const lines = JSON.parse(serialized);
    return Array.isArray(lines) ? lines : [];
  } catch {
    return [];
  }
}

function PurchaseOrders({ orders, canEmail, onDocumentSent }) {
  return orders.length ? (
    <div className="table-scroll"><table>
      <thead><tr><th>PO reference</th><th>Supplier</th><th>Order date</th><th>Line items</th><th className="align-right">Order value</th><th>Status</th><th>Documents</th></tr></thead>
      <tbody>{orders.map((order) => <tr key={order.id}><td className="primary-cell">{order.reference}</td><td>{order.supplier}</td><td>{formatDate(order.date)}</td><td>{order.lines.length}</td><td className="align-right">{formatValue(order.total)}</td><td><span className={`status-pill ${order.status === "Received" ? "status-posted" : order.status === "Partially received" ? "status-partial" : "status-open"}`}>{order.status}</span></td><td><DocumentActions type="purchase-order" id={order.id} reference={order.reference} canEmail={canEmail} onSent={onDocumentSent} /></td></tr>)}</tbody>
    </table></div>
  ) : <EmptyState title="No purchase orders yet" text="Create a purchase order to plan upcoming supplier purchases." />;
}

function Invoices({ invoices, canEmail, onDocumentSent }) {
  return invoices.length ? (
    <div className="table-scroll"><table>
      <thead><tr><th>Invoice reference</th><th>Supplier</th><th>Invoice date</th><th>Items</th><th className="align-right">Invoice value</th><th>Status</th><th>Documents</th></tr></thead>
      <tbody>{invoices.map((invoice) => <tr key={invoice.id}><td className="primary-cell"><Link className="record-link" to={`/purchasing?invoiceId=${invoice.id}`}>{invoice.reference}</Link></td><td>{invoice.supplier}</td><td>{formatDate(invoice.date)}</td><td>{invoice.lines.length}</td><td className="align-right">{formatValue(invoice.total)}</td><td><span className="status-pill status-posted">{invoice.status}</span></td><td><DocumentActions type="supplier-invoice" id={invoice.id} reference={invoice.reference} canEmail={canEmail} onSent={onDocumentSent} /></td></tr>)}</tbody>
    </table></div>
  ) : <EmptyState title="No supplier invoices yet" text="Post an invoice to record the purchase and receive stock into inventory." />;
}

function InvoiceDetails({ invoice, items }) {
  return (
    <section className="panel document-detail-panel">
      <div className="panel-heading">
        <div><div className="eyebrow">SUPPLIER INVOICE</div><h2>{invoice.reference}</h2><p>{invoice.supplier} · {formatDate(invoice.date)}</p></div>
        <span className="status-pill status-posted">{invoice.status}</span>
      </div>
      <div className="table-scroll"><table>
        <thead><tr><th>SKU</th><th>Description</th><th>Quantity received</th><th>Unit cost</th><th className="align-right">Line total</th></tr></thead>
        <tbody>{invoice.lines.map((line, index) => {
          const item = items.find((entry) => entry.id === line.itemId);
          return <tr key={`${line.itemId}-${index}`}><td>{item?.sku ?? "—"}</td><td>{item?.name ?? "Removed item"}</td><td>{line.quantity} {item?.unit ?? ""}</td><td>{formatValue(line.unitCost)}</td><td className="align-right">{formatValue(line.total)}</td></tr>;
        })}</tbody>
        <tfoot><tr><th colSpan="4">Invoice total</th><th className="align-right">{formatValue(invoice.total)}</th></tr></tfoot>
      </table></div>
    </section>
  );
}

function Jobcards({
  data, quantities, selectedCategory, setSelectedCategory, showForm, setShowForm,
  onCreateJobcard, onStatusChange, onRemoveMaterial, selectedJobcardId, issueJobId, setIssueJobId, onIssueStock, newCategory, setNewCategory, onAddCategory, canCreate, canEdit,
}) {
  const [historyJobId, setHistoryJobId] = useState("");
  const filteredJobs = data.jobcards.filter((job) => selectedCategory === "all" || job.categoryId === selectedCategory);
  const issueMovements = data.movements.filter((movement) => movement.type === "Jobcard issue");
  const nextJobRef = `JC-${String(data.jobcards.length + 1).padStart(3, "0")}`;
  return (
    <>
      <div className="stats-grid compact-stats">
        <StatCard label="Jobcards" value={data.jobcards.length} note="Across all categories" />
        <StatCard label="Open jobs" value={data.jobcards.filter((job) => job.status !== "Completed").length} note="Work not yet completed" tone="blue" />
        <StatCard label="Stock issues" value={issueMovements.length} note="Items issued to jobs" tone="orange" />
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div><h2>Jobcard register</h2><p>Filter by category, issue materials, and review job-level stock usage.</p></div>
          {canCreate && <button className="button button-primary" type="button" onClick={() => { setShowForm(showForm === "job" ? "" : "job"); setIssueJobId(""); }}>＋ New jobcard</button>}
        </div>
        {showForm === "job" && (
          <form className="form-card" onSubmit={onCreateJobcard}>
            <div className="form-title"><strong>Create jobcard</strong><span>Choose an existing category or add a new one below.</span></div>
            <div className="form-grid form-grid-three">
              <label className="field"><span>Jobcard reference</span><input name="reference" required maxLength="60" defaultValue={nextJobRef} /></label>
              <label className="field"><span>Job title</span><input name="title" required maxLength="100" placeholder="Job or product description" /></label>
              <label className="field"><span>Customer</span><input name="customer" maxLength="100" placeholder="Customer name (optional)" /></label>
              <label className="field"><span>Category</span><select name="categoryId" required defaultValue={data.categories[0]?.id ?? ""}>{data.categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label>
              <label className="field"><span>Start date</span><input name="date" type="date" required defaultValue={today()} /></label>
            </div>
            <FormActions onCancel={() => setShowForm("")} submit="Create jobcard" />
          </form>
        )}
        <div className="table-toolbar">
          <label className="field category-filter"><span>Category</span><select value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}><option value="all">All categories</option>{data.categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label>
          <span className="result-count">{filteredJobs.length} jobcards</span>
        </div>
        {filteredJobs.length ? (
          <div className="table-scroll"><table>
            <thead><tr><th>Jobcard</th><th>Job / customer</th><th>Category</th><th>Start date</th><th>Status</th><th>Materials</th><th /></tr></thead>
            <tbody>{filteredJobs.map((job) => {
              const jobIssues = issueMovements.filter((movement) => movement.jobcardId === job.id);
              const isIssueOpen = issueJobId === job.id;
              const isHistoryOpen = historyJobId === job.id || selectedJobcardId === job.id;
              return <JobcardRows
                key={job.id}
                job={job}
                jobIssues={jobIssues}
                isIssueOpen={isIssueOpen}
                isHistoryOpen={isHistoryOpen}
                data={data}
                quantities={quantities}
                setIssueJobId={setIssueJobId}
                setHistoryJobId={setHistoryJobId}
                onIssueStock={onIssueStock}
                onStatusChange={onStatusChange}
                onRemoveMaterial={onRemoveMaterial}
                canEdit={canEdit}
              />;
            })}</tbody>
          </table></div>
        ) : <EmptyState title="No jobcards in this view" text="Create a jobcard to start tracking work and material usage." />}
      </section>
      <section className="panel categories-panel">
        <div className="panel-heading"><div><h2>Jobcard categories</h2><p>Categories are configurable and can be extended as your workflow changes.</p></div></div>
        <div className="category-chips">{data.categories.map((category) => <span className="category-chip" key={category.id}>{category.name}</span>)}</div>
        {canCreate && <form className="add-category-form" onSubmit={onAddCategory}>
          <label className="field"><span>Add category</span><input value={newCategory} onChange={(event) => setNewCategory(event.target.value)} maxLength="60" placeholder="e.g. custom_orders" required /></label>
          <button className="button button-secondary" type="submit">Add category</button>
        </form>}
      </section>
    </>
  );
}

function JobcardRows({ job, jobIssues, isIssueOpen, isHistoryOpen, data, quantities, setIssueJobId, setHistoryJobId, onIssueStock, onStatusChange, onRemoveMaterial, canEdit }) {
  const isClosed = job.status === "Completed";
  return (
    <>
      <tr>
        <td className="primary-cell"><Link className="record-link" to={`/PMpg?jobcardId=${job.id}`}>{job.reference}</Link></td>
        <td>{job.title}{job.customer && <span className="secondary-cell">{job.customer}</span>}</td>
        <td><span className="category-chip">{data.categories.find((category) => category.id === job.categoryId)?.name ?? "Uncategorised"}</span></td>
        <td>{formatDate(job.date)}</td>
        <td>
          {isClosed ? <span className="status-pill status-posted">Completed · closed</span> : canEdit ? <select className="job-status-select" aria-label={`Status for ${job.reference}`} value={job.status} onChange={(event) => onStatusChange(job.id, event.target.value)}><option>Open</option><option>In progress</option></select> : <span className="status-pill status-open">{job.status}</span>}
        </td>
        <td><button className="text-button" type="button" onClick={() => setHistoryJobId(isHistoryOpen ? "" : job.id)}>{job.materials.length} reserved · {jobIssues.length} deducted</button></td>
        <td className="job-actions">
          {!isClosed && canEdit && <button className="button button-secondary button-small" type="button" onClick={() => setIssueJobId(isIssueOpen ? "" : job.id)}>Add material</button>}
          {!isClosed && canEdit && <button className="button button-primary button-small" type="button" onClick={() => onStatusChange(job.id, "Completed")}>Complete & close</button>}
        </td>
      </tr>
      {isIssueOpen && canEdit && <tr className="expanded-row"><td colSpan="7">
        <form className="issue-form" onSubmit={onIssueStock}>
          <input type="hidden" name="jobId" value={job.id} />
          <label className="field"><span>Reserve inventory item</span><select name="itemId" required defaultValue=""><option value="">Select item</option>{data.items.map((item) => {
            const available = (quantities.get(item.id) ?? 0) - (item.reserved ?? 0);
            return <option value={item.id} key={item.id} disabled={available <= 0}>{item.sku} · {item.name} · {available} {item.unit} available</option>;
          })}</select></label>
          <label className="field"><span>Quantity for jobcard</span><input name="quantity" type="number" min="0.001" step="any" required /></label>
          <button className="button button-primary button-small" type="submit">Reserve for jobcard</button>
          <button className="text-button" type="button" onClick={() => setIssueJobId("")}>Cancel</button>
        </form>
      </td></tr>}
      {isHistoryOpen && <tr className="expanded-row"><td colSpan="7">
        {job.materials.length ? (
          <div className="job-material-list">{job.materials.map((material) => {
            const item = data.items.find((entry) => entry.id === material.itemId);
            const deducted = jobIssues.find((movement) => movement.itemId === material.itemId);
            return <div className="job-material-row" key={material.id}>
              <span><strong>{item?.sku ?? "Item"}</strong> · {item?.name ?? "Removed item"}</span>
              <span>{material.quantity} {item?.unit ?? ""}</span>
              <span className={`status-pill ${isClosed ? "status-posted" : "status-open"}`}>{isClosed ? `Deducted ${formatDate(deducted?.date)}` : "Reserved"}</span>
              {!isClosed && canEdit && <button className="text-button" type="button" onClick={() => onRemoveMaterial(job.id, material.id)}>Remove reservation</button>}
            </div>;
          })}</div>
        ) : <div className="inline-notice">No inventory is reserved on this jobcard.</div>}
      </td></tr>}
    </>
  );
}

function MovementList({ movements, items }) {
  return (
    <div className="movement-list">
      {movements.map((movement) => {
        const item = items.find((entry) => entry.id === movement.itemId);
        const receipt = movement.quantity > 0;
        return <div className="movement-row" key={movement.id}>
          <span className={`movement-sign ${receipt ? "received" : "issued"}`}>{receipt ? "↓" : "↑"}</span>
          <div className="movement-info"><strong>{item?.name ?? "Removed item"}</strong><span>{movement.type} · {movement.reference}</span></div>
          <span className={`movement-quantity ${receipt ? "received-text" : ""}`}>{receipt ? "+" : "−"}{Math.abs(movement.quantity)} {item?.unit ?? ""}</span>
          <time>{formatDate(movement.date)}</time>
        </div>;
      })}
    </div>
  );
}

function EmptyState({ title, text, action }) {
  return <div className="empty-state"><div className="empty-state-icon">▤</div><strong>{title}</strong><p>{text}</p>{action}</div>;
}

function FormActions({ onCancel, submit }) {
  return <div className="form-actions"><button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button><button className="button button-primary" type="submit">{submit}</button></div>;
}
