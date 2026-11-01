import { useCallback, useEffect, useState } from "react";
import { erpApi } from "./erpApi.js";
import DocumentActions from "./DocumentActions.jsx";

const today = () => new Date().toISOString().slice(0, 10);
const money = (value) => new Intl.NumberFormat("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0);
const newLine = () => ({ key: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, description: "", quantity: "1", unitPrice: "" });

export default function SalesManagement({ canCreate }) {
  const [invoices, setInvoices] = useState([]);
  const [lines, setLines] = useState([newLine()]);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const loadInvoices = useCallback(async () => {
    const result = await erpApi.getSalesInvoices();
    setInvoices(result.invoices);
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await erpApi.getSalesInvoices();
        if (active) setInvoices(result.invoices);
      } catch (loadError) {
        if (active) setError(loadError.message);
      }
    };
    load();
    return () => { active = false; };
  }, [loadInvoices]);

  const updateLine = (key, field, value) => setLines((current) => current.map((line) => line.key === key ? { ...line, [field]: value } : line));

  const submit = async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const invoice = {
        reference: String(form.get("reference")).trim(),
        customer: String(form.get("customer")).trim(),
        customerEmail: String(form.get("customerEmail")).trim(),
        date: String(form.get("date")),
        dueDate: String(form.get("dueDate")) || null,
        lines: lines.map((line) => ({
          description: line.description.trim(),
          quantity: Number(line.quantity),
          unitPrice: Number(line.unitPrice),
        })),
      };
      await erpApi.createSalesInvoice(invoice);
      await loadInvoices();
      formElement.reset();
      setLines([newLine()]);
      setShowForm(false);
      setNotice(`Sales invoice ${invoice.reference} posted to accounts receivable.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const total = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0), 0);

  return <>
    <div className="stats-grid compact-stats">
      <article className="stat-card"><div className="stat-label">Sales invoices</div><div className="stat-value">{invoices.length}</div><div className="stat-note">Posted customer invoices</div></article>
      <article className="stat-card tone-blue"><div className="stat-label">Invoiced value</div><div className="stat-value">{money(invoices.reduce((sum, invoice) => sum + invoice.total, 0))}</div><div className="stat-note">All recorded invoices</div></article>
      <article className="stat-card tone-orange"><div className="stat-label">Outstanding</div><div className="stat-value">{money(invoices.reduce((sum, invoice) => sum + invoice.total - invoice.paid_amount, 0))}</div><div className="stat-note">Open customer balances</div></article>
    </div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert success" role="status">{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div>}
    <section className="panel">
      <div className="panel-heading"><div><h2>Customer invoices</h2><p>Post sales revenue and accounts receivable to the general ledger.</p></div>{canCreate && <button className="button button-primary" type="button" onClick={() => setShowForm((shown) => !shown)}>＋ New invoice</button>}</div>
      {!canCreate && <div className="inline-notice">Your account has view-only access to sales management.</div>}
      {showForm && <form className="form-card" onSubmit={submit}>
        <div className="form-title"><strong>Create sales invoice</strong><span>Posting updates the customer balance and ledger.</span></div>
        <div className="form-grid form-grid-three">
          <label className="field"><span>Invoice reference</span><input name="reference" required maxLength="60" placeholder="e.g. SI-0001" /></label>
          <label className="field"><span>Customer</span><input name="customer" required maxLength="100" /></label>
          <label className="field"><span>Customer email</span><input name="customerEmail" type="email" maxLength="254" /></label>
          <label className="field"><span>Invoice date</span><input name="date" type="date" defaultValue={today()} required /></label>
          <label className="field"><span>Due date</span><input name="dueDate" type="date" /></label>
        </div>
        <div className="form-title sales-lines-heading"><strong>Invoice lines</strong></div>
        <div className="sales-line-list">{lines.map((line, index) => <div className="sales-line-row" key={line.key}>
          <label className="field"><span>Description</span><input required maxLength="200" value={line.description} onChange={(event) => updateLine(line.key, "description", event.target.value)} /></label>
          <label className="field"><span>Quantity</span><input required type="number" min="0.001" step="any" value={line.quantity} onChange={(event) => updateLine(line.key, "quantity", event.target.value)} /></label>
          <label className="field"><span>Unit price</span><input required type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => updateLine(line.key, "unitPrice", event.target.value)} /></label>
          <button className="icon-button" type="button" aria-label={`Remove invoice line ${index + 1}`} disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}>×</button>
        </div>)}</div>
        <button className="text-button" type="button" onClick={() => setLines((current) => [...current, newLine()])}>＋ Add invoice line</button>
        <div className="sales-total">Invoice total <strong>{money(total)}</strong></div>
        <div className="form-actions"><button className="button button-secondary" type="button" onClick={() => setShowForm(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={busy || total <= 0}>{busy ? "Posting…" : "Post invoice"}</button></div>
      </form>}
      {invoices.length ? <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Due</th><th className="align-right">Total</th><th className="align-right">Outstanding</th><th>Status</th><th>Documents</th></tr></thead>
        <tbody>{invoices.map((invoice) => <tr key={invoice.id}><td className="primary-cell">{invoice.reference}</td><td>{invoice.customer}</td><td>{invoice.date}</td><td>{invoice.due_date ?? "—"}</td><td className="align-right">{money(invoice.total)}</td><td className="align-right">{money(invoice.total - invoice.paid_amount)}</td><td><span className={`status-pill ${invoice.status === "Paid" ? "status-posted" : invoice.status === "Partially paid" ? "status-partial" : "status-open"}`}>{invoice.status}</span></td><td><DocumentActions type="sales-invoice" id={invoice.id} reference={invoice.reference} recipient={invoice.customer_email} canEmail={canCreate} onSent={setNotice} /></td></tr>)}</tbody>
      </table></div> : <div className="empty-state"><strong>No sales invoices yet</strong><p>Post a customer invoice to begin tracking sales and receivables.</p></div>}
    </section>
  </>;
}
