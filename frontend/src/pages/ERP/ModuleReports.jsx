import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { erpApi } from "./erpApi.js";

const money = (value) => new Intl.NumberFormat("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0);
const currentYear = new Date().getMonth() >= 2 ? new Date().getFullYear() : new Date().getFullYear() - 1;
const yearOptions = Array.from({ length: 7 }, (_, index) => String(currentYear - index));
const definitions = {
  MM: { title: "Inventory reports", description: "Stock valuation, receipts, issues, and inventory movement for the selected financial year.", load: (year) => erpApi.getInventoryReport(year) },
  PRM: { title: "Procurement reports", description: "Posted supplier purchases, purchase orders, and monthly procurement activity.", load: (year) => erpApi.getProcurementReport(year) },
  SM: { title: "Sales reports", description: "Customer invoice value, receipts, outstanding balances, and monthly sales performance.", load: (year) => erpApi.getSalesReport(year) },
  PM: { title: "Production reports", description: "Jobcard volumes, completion status, categories, and material consumption.", load: (year) => erpApi.getProductionReport(year) },
};

export default function ModuleReports({ module, canViewPurchasing = false, canViewJobcards = false }) {
  const [year, setYear] = useState(String(currentYear));
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState("");
  const definition = definitions[module];

  useEffect(() => {
    let active = true;
    definition.load(year)
      .then((result) => { if (active) setLoaded({ year, report: result }); })
      .catch((loadError) => { if (active) setError(loadError.message); });
    return () => { active = false; };
  }, [definition, year]);
  const report = loaded?.year === year ? loaded.report : null;

  return <>
    <div className="report-controls">
      <p>Financial year runs from March through February.</p>
      <label className="field"><span>Financial year</span><select value={year} onChange={(event) => { setError(""); setYear(event.target.value); }}>{yearOptions.map((option) => <option value={option} key={option}>{option}–{Number(option) + 1}</option>)}</select></label>
    </div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {!report && !error && <div className="loading-state">Loading {definition.title.toLowerCase()}…</div>}
    {report && module === "MM" && <InventoryReport report={report} year={year} canViewPurchasing={canViewPurchasing} canViewJobcards={canViewJobcards} />}
    {report && module === "PRM" && <ProcurementReport report={report} year={year} />}
    {report && module === "SM" && <SalesReport report={report} year={year} />}
    {report && module === "PM" && <ProductionReport report={report} year={year} />}
  </>;
}

function InventoryReport({ report, year, canViewPurchasing, canViewJobcards }) {
  return <>
    <Stats stats={[
      ["Items tracked", report.totals.itemCount, "Active inventory records"],
      ["Stock valuation", money(report.totals.stockValue), "Current on-hand at average cost"],
      ["Receipts", report.totals.broughtIn, "Units received this financial year"],
      ["Issues", report.totals.takenOut, "Units issued or adjusted out"],
    ]} />
    <MonthlyReport rows={report.monthly} firstLabel="Month" columns={[["broughtIn", "Received"], ["takenOut", "Issued"], ["adjustment", "Net adjustments"]]} unit="units" />
    <section className="panel"><div className="panel-heading"><div><h2>Inventory position</h2><p>Current on-hand, reserved quantity, reorder level, and valuation.</p></div></div>
      {report.items.length ? <div className="table-scroll"><table><thead><tr><th>SKU</th><th>Description</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Reorder at</th><th className="align-right">Value</th></tr></thead>
        <tbody>{report.items.map((item) => <tr key={item.id}><td className="primary-cell">{item.sku}</td><td>{item.name}</td><td>{item.onHand} {item.unit}</td><td>{item.reserved} {item.unit}</td><td>{item.onHand - item.reserved} {item.unit}</td><td>{item.minStock} {item.unit}</td><td className="align-right">{money(item.stockValue)}</td></tr>)}</tbody>
      </table></div> : <Empty text="No inventory items are active." />}
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Stock movement register</h2><p>Every receipt and deduction listed line by line for FY {year}–{Number(year) + 1}.</p></div></div>
      {report.movements.length ? <div className="table-scroll"><table><thead><tr><th>Date</th><th>SKU</th><th>Movement</th><th>Quantity</th><th>Source document</th></tr></thead>
        <tbody>{report.movements.map((movement) => {
          const receipt = movement.type === "Receipt";
          const issue = movement.type === "Jobcard issue";
          const allowed = receipt ? canViewPurchasing : issue ? canViewJobcards : false;
          const link = receipt ? `/purchasing?invoiceId=${movement.invoiceId}` : `/PMpg?jobcardId=${movement.jobcardId}`;
          const sourceRef = receipt ? movement.invoiceReference : issue ? movement.jobcardReference : movement.reference;
          return <tr key={movement.id}><td>{movement.date}</td><td className="primary-cell">{movement.sku}</td><td>{movement.type}</td><td className={movement.quantity > 0 ? "received-text" : "warning-text"}>{movement.quantity > 0 ? "+" : ""}{movement.quantity} {movement.unit}</td>
            <td>{sourceRef && allowed ? <Link className="record-link" to={link}>{sourceRef}</Link> : <span>{sourceRef ?? movement.reference}{receipt || issue ? " · access not granted" : ""}</span>}</td></tr>;
        })}</tbody></table></div> : <Empty text="No stock movements in this financial year." />}
    </section>
  </>;
}

function ProcurementReport({ report, year }) {
  return <>
    <Stats stats={[
      ["Purchase value", money(report.totals.purchaseValue), `${report.totals.invoiceCount} supplier invoices`],
      ["Purchase orders", report.totals.orderCount, "Orders dated in selected year"],
      ["Order value", money(report.totals.orderValue), "Value before supplier invoices"],
    ]} />
    <MonthlyReport rows={report.monthly} firstLabel="Month" columns={[["purchaseValue", "Posted purchases"], ["invoiceCount", "Invoices"]]} currencyKey="purchaseValue" />
    <section className="panel"><div className="panel-heading"><div><h2>Supplier invoices</h2><p>Posted supplier invoices in FY {year}–{Number(year) + 1}.</p></div></div>
      {report.invoices.length ? <div className="table-scroll"><table><thead><tr><th>Reference</th><th>Supplier</th><th>Date</th><th>Lines</th><th className="align-right">Value</th><th>Status</th></tr></thead>
        <tbody>{report.invoices.map((invoice) => <tr key={invoice.id}><td className="primary-cell">{invoice.reference}</td><td>{invoice.supplier}</td><td>{invoice.date}</td><td>{invoice.line_count}</td><td className="align-right">{money(invoice.total)}</td><td>{invoice.status}</td></tr>)}</tbody></table></div> : <Empty text="No supplier invoices in this financial year." />}
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Purchase order register</h2><p>Orders placed in the selected financial year.</p></div></div>
      {report.orders.length ? <div className="table-scroll"><table><thead><tr><th>Order</th><th>Supplier</th><th>Date</th><th>Lines</th><th className="align-right">Value</th><th>Status</th></tr></thead>
        <tbody>{report.orders.map((order) => <tr key={order.id}><td className="primary-cell">{order.reference}</td><td>{order.supplier}</td><td>{order.date}</td><td>{order.line_count}</td><td className="align-right">{money(order.total)}</td><td>{order.status}</td></tr>)}</tbody></table></div> : <Empty text="No purchase orders in this financial year." />}
    </section>
  </>;
}

function SalesReport({ report, year }) {
  return <>
    <Stats stats={[
      ["Sales invoiced", money(report.totals.invoiced), `${report.totals.invoiceCount} customer invoices`],
      ["Receipts", money(report.totals.received), "Payments received"],
      ["Outstanding", money(report.totals.outstanding), "Open receivables"],
    ]} />
    <MonthlyReport rows={report.monthly} firstLabel="Month" columns={[["invoiced", "Invoiced"], ["invoiceCount", "Invoices"]]} currencyKey="invoiced" />
    <section className="panel"><div className="panel-heading"><div><h2>Customer performance</h2><p>Invoice totals, receipts, and outstanding balances in FY {year}–{Number(year) + 1}.</p></div></div>
      {report.customerTotals.length ? <div className="table-scroll"><table><thead><tr><th>Customer</th><th>Invoices</th><th className="align-right">Invoiced</th><th className="align-right">Received</th><th className="align-right">Outstanding</th></tr></thead>
        <tbody>{report.customerTotals.map((customer) => <tr key={customer.id}><td className="primary-cell">{customer.name}</td><td>{customer.invoiceCount}</td><td className="align-right">{money(customer.invoiced)}</td><td className="align-right">{money(customer.received)}</td><td className="align-right">{money(customer.outstanding)}</td></tr>)}</tbody></table></div> : <Empty text="No customer invoices in this financial year." />}
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Sales invoice register</h2><p>Customer invoices dated in the selected financial year.</p></div></div>
      {report.invoices.length ? <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th className="align-right">Total</th><th className="align-right">Received</th><th>Status</th></tr></thead>
        <tbody>{report.invoices.map((invoice) => <tr key={invoice.id}><td className="primary-cell">{invoice.reference}</td><td>{invoice.customer}</td><td>{invoice.date}</td><td className="align-right">{money(invoice.total)}</td><td className="align-right">{money(invoice.paid_amount)}</td><td>{invoice.status}</td></tr>)}</tbody></table></div> : <Empty text="No sales invoices in this financial year." />}
    </section>
  </>;
}

function ProductionReport({ report, year }) {
  return <>
    <Stats stats={[
      ["Jobcards", report.totals.jobCount, `FY ${year}–${Number(year) + 1}`],
      ["Completed", report.totals.completed, "Closed jobcards"],
      ["Open", report.totals.open, "Work in progress"],
      ["Material issued", report.totals.unitsIssued, `${report.totals.materialLines} issue lines`],
    ]} />
    <section className="panel"><div className="panel-heading"><div><h2>Category performance</h2><p>Open and completed jobcards by category.</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>Category</th><th>Total</th><th>Completed</th><th>Open</th></tr></thead><tbody>
        {report.categoryTotals.map((category) => <tr key={category.category}><td className="primary-cell">{category.category}</td><td>{category.jobCount}</td><td>{category.completed}</td><td>{category.open}</td></tr>)}
      </tbody></table></div>
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Jobcard register</h2><p>Jobcards opened during the selected financial year.</p></div></div>
      {report.jobcards.length ? <div className="table-scroll"><table><thead><tr><th>Jobcard</th><th>Job</th><th>Customer</th><th>Category</th><th>Opened</th><th>Closed</th><th>Status</th></tr></thead>
        <tbody>{report.jobcards.map((job) => <tr key={job.id}><td className="primary-cell">{job.reference}</td><td>{job.title}</td><td>{job.customer || "—"}</td><td>{job.category}</td><td>{job.date}</td><td>{job.closedAt ?? "—"}</td><td>{job.status}</td></tr>)}</tbody></table></div> : <Empty text="No jobcards were opened in this financial year." />}
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Material issue register</h2><p>Inventory deductions on jobcard close-out.</p></div></div>
      {report.issues.length ? <div className="table-scroll"><table><thead><tr><th>Date</th><th>Jobcard</th><th>SKU</th><th>Item</th><th>Quantity</th></tr></thead>
        <tbody>{report.issues.map((issue) => <tr key={issue.id}><td>{issue.date}</td><td className="primary-cell">{issue.jobcardReference ?? issue.reference}</td><td>{issue.sku}</td><td>{issue.itemName}</td><td className="warning-text">{Math.abs(issue.quantity)} {issue.unit}</td></tr>)}</tbody></table></div> : <Empty text="No materials were issued to production in this financial year." />}
    </section>
  </>;
}

function MonthlyReport({ rows, firstLabel, columns, currencyKey, unit }) {
  return <section className="panel"><div className="panel-heading"><div><h2>Monthly summary</h2><p>Activity by financial-year month.</p></div></div>
    <div className="table-scroll"><table><thead><tr><th>{firstLabel}</th>{columns.map(([, label]) => <th key={label} className="align-right">{label}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.month}><td>{new Date(`${row.month}-01T00:00:00`).toLocaleString(undefined, { month: "long", year: "numeric" })}</td>
        {columns.map(([key]) => <td className="align-right" key={key}>{currencyKey === key ? money(row[key]) : row[key]}{unit && key !== currencyKey ? ` ${unit}` : ""}</td>)}
      </tr>)}</tbody>
    </table></div>
  </section>;
}

function Stats({ stats }) {
  return <div className={`stats-grid ${stats.length === 4 ? "" : "compact-stats"}`}>{stats.map(([label, value, note], index) => <article className={`stat-card ${["", "tone-blue", "tone-orange", "tone-purple"][index]}`} key={label}><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-note">{note}</div></article>)}</div>;
}

function Empty({ text }) {
  return <div className="empty-state"><strong>{text}</strong></div>;
}
