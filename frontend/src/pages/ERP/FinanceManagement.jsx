import { Fragment, useCallback, useEffect, useState } from "react";
import { erpApi } from "./erpApi.js";

const money = (value) => new Intl.NumberFormat("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0);
const today = () => new Date().toISOString().slice(0, 10);
const currentYear = new Date().getMonth() >= 2 ? new Date().getFullYear() : new Date().getFullYear() - 1;
const years = Array.from({ length: 7 }, (_, index) => String(currentYear - index));
const tabs = [
  ["ledger", "General ledger"],
  ["creditors", "Creditors"],
  ["debtors", "Debtors"],
  ["budgets", "Budgets"],
  ["stocktake", "Stock take"],
];

const financialMonths = (year) => Array.from({ length: 12 }, (_, index) => {
  const date = new Date(Date.UTC(Number(year), 2 + index, 1));
  return date.toISOString().slice(0, 10);
});

export default function FinanceManagement({ canCreate, canEdit, reporting = false, initialTab, allowedTabs }) {
  const [tab, setTab] = useState(initialTab ?? (reporting ? "reporting" : "ledger"));
  const [year, setYear] = useState(String(currentYear));
  const [overview, setOverview] = useState(null);
  const [budgetData, setBudgetData] = useState({ accounts: [], budgets: [], actuals: [] });
  const [budgetAccountId, setBudgetAccountId] = useState("");
  const [ledgerAccountId, setLedgerAccountId] = useState("all");
  const [creditors, setCreditors] = useState({ invoices: [], payments: [], accountBalance: 0, invoiceBalance: 0, reconciled: true });
  const [debtors, setDebtors] = useState({ invoices: [], receipts: [] });
  const [stocktakeData, setStocktakeData] = useState({ stocktakes: [], items: [] });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedStocktake, setExpandedStocktake] = useState("");
  const visibleTabs = allowedTabs ? tabs.filter(([id]) => allowedTabs.includes(id)) : tabs;

  const loadOverview = useCallback(async () => setOverview(await erpApi.getFinanceOverview(year)), [year]);
  const loadReporting = useCallback(async () => setOverview(await erpApi.getFinancialReporting(year)), [year]);
  const loadBudgets = useCallback(async () => setBudgetData(await erpApi.getBudgets(year)), [year]);
  const loadCreditors = useCallback(async () => setCreditors(await erpApi.getCreditors()), []);
  const loadDebtors = useCallback(async () => setDebtors(await erpApi.getDebtors()), []);
  const loadStocktakes = useCallback(async () => setStocktakeData(await erpApi.getStocktakes()), []);

  useEffect(() => {
    let active = true;
    const load = reporting || tab === "reporting" ? loadReporting
      : tab === "ledger" ? loadOverview
        : tab === "budgets" ? loadBudgets
          : tab === "creditors" ? loadCreditors
            : tab === "debtors" ? loadDebtors
              : tab === "stocktake" ? loadStocktakes : loadOverview;
    load().catch((loadError) => { if (active) setError(loadError.message); });
    return () => { active = false; };
  }, [tab, reporting, loadCreditors, loadDebtors, loadOverview, loadReporting, loadBudgets, loadStocktakes]);

  const runAction = async (action, message) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(message);
    } catch (actionError) {
      setError(actionError.message);
      setBusy(false);
      return false;
    }
    try {
      if (tab === "creditors") await loadCreditors();
      if (tab === "debtors") await loadDebtors();
      if (tab === "budgets") await loadBudgets();
      if (tab === "stocktake") await loadStocktakes();
      if (!allowedTabs || allowedTabs.includes("ledger")) await loadOverview();
    } catch (refreshError) {
      setError(`The transaction was saved, but the latest data could not be refreshed: ${refreshError.message}`);
    } finally {
      setBusy(false);
    }
    return true;
  };

  const submitPayment = (invoice, customer) => async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payment = {
      date: String(form.get("date")),
      amount: Number(form.get("amount")),
      reference: String(form.get("reference")).trim(),
    };
    const action = customer
      ? () => erpApi.createCustomerReceipt(invoice.id, payment)
      : () => erpApi.createSupplierPayment(invoice.id, payment);
    await runAction(action, customer ? "Customer receipt posted." : "Supplier payment posted.");
  };

  const submitStocktake = async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const lines = stocktakeData.items.map((item) => ({
      itemId: item.id,
      countedQuantity: Number(form.get(`item-${item.id}`)),
    }));
    const posted = await runAction(
      () => erpApi.createStocktake({ reference: String(form.get("reference")).trim(), date: String(form.get("date")), lines }),
      "Stock take posted and inventory balances adjusted.",
    );
    if (posted) formElement.reset();
  };

  if (reporting) return <>
    <div className="finance-toolbar"><div className="reporting-title"><strong>Financial reporting</strong><span>Core financial statements and ledger reports for the selected year.</span></div>
      <label className="field finance-year"><span>Financial year</span><select value={year} onChange={(event) => { setError(""); setYear(event.target.value); }}>{years.map((entry) => <option key={entry} value={entry}>{entry}–{Number(entry) + 1}</option>)}</select></label>
    </div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {overview ? <Overview report={overview} /> : <div className="loading-state">Loading financial reports…</div>}
  </>;
  return (
    <>
      <div className="finance-toolbar">
        {visibleTabs.length > 1 && <div className="segmented-control finance-tabs" role="tablist" aria-label="Financial management sections">
          {visibleTabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "selected" : ""} onClick={() => { setTab(id); setError(""); setNotice(""); }}>{label}</button>)}
        </div>}
        {(!allowedTabs || allowedTabs.includes("ledger")) && <label className="field finance-year"><span>Financial year</span><select value={year} onChange={(event) => { setError(""); setYear(event.target.value); }}>{years.map((entry) => <option key={entry} value={entry}>{entry}–{Number(entry) + 1}</option>)}</select></label>}
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert success" role="status">{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div>}
      {tab === "ledger" && (overview ? <GeneralLedger year={year} accountId={ledgerAccountId} onAccountChange={setLedgerAccountId} accounts={overview.accounts} /> : <div className="loading-state">Loading general ledger…</div>)}
      {tab === "creditors" && <OpenInvoices
        title="Supplier invoices and payments"
        description="Posted invoices update inventory and the accounts-payable control account; payments reduce both the supplier balance and the general ledger."
        invoices={creditors.invoices}
        accountBalance={creditors.accountBalance}
        invoiceBalance={creditors.invoiceBalance}
        reconciled={creditors.reconciled}
        canCreate={canCreate}
        busy={busy}
        customer={false}
        onSubmit={submitPayment}
        empty="There are no unpaid supplier invoices."
      />}
      {tab === "debtors" && <OpenInvoices
        title="Accounts receivable"
        description="Customer invoices and outstanding balances."
        invoices={debtors.invoices}
        canCreate={canCreate}
        busy={busy}
        customer
        onSubmit={submitPayment}
        empty="There are no unpaid customer invoices."
      />}
      {tab === "budgets" && <BudgetManagement
        data={budgetData}
        year={year}
        accountId={budgetAccountId || budgetData.accounts[0]?.id || ""}
        onAccountChange={setBudgetAccountId}
        canEdit={canEdit}
        busy={busy}
        onSave={(lines) => runAction(() => erpApi.saveBudgets({ year: Number(year), lines }), "Budget amounts saved for the selected financial year.")}
      />}
      {tab === "stocktake" && <section className="panel">
        <div className="panel-heading"><div><h2>Physical stock take</h2><p>Enter counted quantities. Posting records variances and updates on-hand stock in one transaction.</p></div></div>
        {!canCreate && <div className="inline-notice">Your account has view-only access to stock takes.</div>}
        {canCreate && <form className="form-card" onSubmit={submitStocktake}>
          <div className="form-grid">
            <label className="field"><span>Stock take reference</span><input name="reference" required maxLength="60" placeholder="e.g. ST-2026-001" /></label>
            <label className="field"><span>Count date</span><input name="date" type="date" defaultValue={today()} required /></label>
          </div>
          <div className="table-scroll stocktake-table"><table>
            <thead><tr><th>SKU</th><th>Description</th><th>System quantity</th><th>Counted quantity</th></tr></thead>
            <tbody>{stocktakeData.items.map((item) => <tr key={item.id}>
              <td className="primary-cell">{item.sku}</td><td>{item.name}</td><td>{item.systemQuantity} {item.unit}</td>
              <td><input aria-label={`Counted quantity for ${item.sku}`} className="compact-input" name={`item-${item.id}`} type="number" min="0" step="any" defaultValue={item.systemQuantity} required /></td>
            </tr>)}</tbody>
          </table></div>
          <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !stocktakeData.items.length}>{busy ? "Posting…" : "Post stock take"}</button></div>
        </form>}
        <div className="panel-subheading"><h3>Recent stock takes</h3></div>
        {stocktakeData.stocktakes.length ? <div className="table-scroll"><table>
          <thead><tr><th>Reference</th><th>Date</th><th>Status</th><th>Lines</th><th /></tr></thead>
          <tbody>{stocktakeData.stocktakes.map((entry) => <Fragment key={entry.id}>
            <tr key={entry.id}><td className="primary-cell">{entry.reference}</td><td>{entry.date}</td><td><span className="status-pill status-posted">{entry.status}</span></td><td>{entry.lines.length}</td><td><button className="text-button" type="button" onClick={() => setExpandedStocktake(expandedStocktake === entry.id ? "" : entry.id)}>{expandedStocktake === entry.id ? "Hide details" : "View details"}</button></td></tr>
            {expandedStocktake === entry.id && <tr key={`${entry.id}-lines`}><td colSpan="5"><div className="table-scroll"><table><thead><tr><th>SKU</th><th>Description</th><th>System quantity</th><th>Counted</th><th>Variance</th><th>Variance value</th></tr></thead><tbody>
              {entry.lines.map((line) => <tr key={line.id}><td className="primary-cell">{line.sku}</td><td>{line.name}</td><td>{line.system_quantity} {line.unit}</td><td>{line.counted_quantity} {line.unit}</td><td className={line.variance < 0 ? "warning-text" : "received-text"}>{line.variance > 0 ? "+" : ""}{line.variance} {line.unit}</td><td>{money(line.variance * line.unit_cost)}</td></tr>)}
            </tbody></table></div></td></tr>}
          </Fragment>)}</tbody>
        </table></div> : <p className="muted-copy">No stock takes have been posted.</p>}
      </section>}
    </>
  );
}

function GeneralLedger({ year, accountId, onAccountChange, accounts }) {
  const [ledger, setLedger] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    erpApi.getLedger(year, accountId, page)
      .then((result) => { if (active) setLedger(result); })
      .catch((loadError) => { if (active) setError(loadError.message); });
    return () => { active = false; };
  }, [year, accountId, page]);

  return <>
    <section className="panel"><div className="panel-heading panel-heading-tabs">
      <div><h2>General ledger</h2><p>Posted journal transactions within the selected financial year.</p></div>
      <label className="field ledger-account-filter"><span>Account</span><select value={accountId} onChange={(event) => { onAccountChange(event.target.value); setPage(1); }}><option value="all">All accounts</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.code} · {account.name}</option>)}</select></label>
    </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {!ledger && !error && <div className="loading-state">Loading ledger entries…</div>}
      {ledger && (ledger.entries.length ? <>
        <div className="ledger-range">{ledger.total} journal entries · page {ledger.page} of {Math.max(ledger.pages, 1)}</div>
        <div className="table-scroll"><table><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th>Account</th><th>Posted by</th><th className="align-right">Debit</th><th className="align-right">Credit</th></tr></thead>
          <tbody>{ledger.entries.flatMap((entry) => entry.lines
            .filter((line) => accountId === "all" || line.accountId === accountId)
            .map((line) => <tr key={`${entry.id}-${line.accountId}`}><td>{entry.date}</td><td className="primary-cell">{entry.reference}</td><td>{entry.description}</td><td>{line.code} · {line.name}</td><td>{entry.posted_by_email ?? "System"}</td><td className="align-right">{money(line.debit)}</td><td className="align-right">{money(line.credit)}</td></tr>))}</tbody>
        </table></div>
        <div className="ledger-pagination"><button className="button button-secondary button-small" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page} of {Math.max(ledger.pages, 1)}</span><button className="button button-secondary button-small" type="button" disabled={page >= ledger.pages} onClick={() => setPage((value) => value + 1)}>Next</button></div>
      </> : <div className="empty-state"><strong>No general ledger entries for this period.</strong></div>)}
    </section>
  </>;
}

function BudgetManagement({ data, year, accountId, onAccountChange, canEdit, busy, onSave }) {
  const months = financialMonths(year);
  const selectedAccount = data.accounts.find((account) => account.id === accountId);
  const budgetByMonth = new Map(data.budgets.filter((line) => line.accountId === accountId).map((line) => [line.month, line.amount]));
  const actualByMonth = new Map(data.actuals.filter((line) => line.accountId === accountId).map((line) => [`${line.month}-01`, line.actual]));
  const annualBudget = months.reduce((sum, month) => sum + (budgetByMonth.get(month) ?? 0), 0);
  const annualActual = months.reduce((sum, month) => sum + (actualByMonth.get(month) ?? 0), 0);

  const submit = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave(months.map((month) => ({
      accountId,
      month,
      amount: Number(form.get(month)),
    })));
  };

  return <>
    <div className="finance-summary-grid budget-summary">
      <section className="panel"><div className="panel-heading"><div><h2>Annual budget</h2><p>{selectedAccount?.name ?? "Select an account"} · FY {year}–{Number(year) + 1}</p></div></div><strong className="budget-total">{money(annualBudget)}</strong></section>
      <section className="panel"><div className="panel-heading"><div><h2>Year-to-date actual</h2><p>Posted ledger transactions for this account.</p></div></div><strong className="budget-total">{money(annualActual)}</strong></section>
    </div>
    <section className="panel"><div className="panel-heading panel-heading-tabs">
      <div><h2>Monthly budget and actual</h2><p>Enter planned amounts by income or expense account, then compare against ledger actuals.</p></div>
      <label className="field ledger-account-filter"><span>Budget account</span><select value={accountId} onChange={(event) => onAccountChange(event.target.value)}>{data.accounts.map((account) => <option value={account.id} key={account.id}>{account.code} · {account.name} ({account.type})</option>)}</select></label>
    </div>
      {!canEdit && <div className="inline-notice">Your account has view-only access to budgets.</div>}
      {selectedAccount && <form onSubmit={submit}>
        <div className="table-scroll"><table><thead><tr><th>Month</th><th className="align-right">Budget</th><th className="align-right">Actual</th><th className="align-right">Variance</th></tr></thead>
          <tbody>{months.map((month) => {
            const budget = budgetByMonth.get(month) ?? 0;
            const actual = actualByMonth.get(month) ?? 0;
            const favorable = selectedAccount.type === "Income" ? actual - budget : budget - actual;
            return <tr key={month}><td>{new Date(`${month}T00:00:00`).toLocaleString(undefined, { month: "long", year: "numeric" })}</td>
              <td className="align-right">{canEdit ? <input className="compact-input budget-input" aria-label={`${selectedAccount.name} budget for ${month}`} name={month} type="number" min="0" step="0.01" defaultValue={budget} /> : money(budget)}</td>
              <td className="align-right">{money(actual)}</td><td className={`align-right ${favorable < 0 ? "warning-text" : "received-text"}`}>{money(favorable)}</td></tr>;
          })}</tbody>
          <tfoot><tr><th>Financial year total</th><th className="align-right">{money(annualBudget)}</th><th className="align-right">{money(annualActual)}</th><th className="align-right">{money(selectedAccount.type === "Income" ? annualActual - annualBudget : annualBudget - annualActual)}</th></tr></tfoot>
        </table></div>
        {canEdit && <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save budget"}</button></div>}
      </form>}
      {!data.accounts.length && <div className="empty-state"><strong>No budgetable ledger accounts.</strong><p>Active income and expense accounts will appear here.</p></div>}
    </section>
  </>;
}

function Overview({ report }) {
  const { profitAndLoss, balanceSheet, creditors, debtors, inventory, accounts, monthly } = report;
  const trialDebit = accounts.reduce((sum, account) => sum + account.debits, 0);
  const trialCredit = accounts.reduce((sum, account) => sum + account.credits, 0);
  return <>
    <div className="stats-grid finance-stats">
      <Stat label="Revenue" value={money(profitAndLoss.income)} note={`Financial year ${report.year}–${report.year + 1}`} />
      <Stat label="Expenses" value={money(profitAndLoss.expenses)} note="Posted financial activity" tone="orange" />
      <Stat label="Net profit" value={money(profitAndLoss.netProfit)} note="Revenue less expenses" tone="blue" />
      <Stat label="Inventory value" value={money(inventory.value)} note={`${inventory.items} active items`} tone="purple" />
    </div>
    <div className="finance-summary-grid">
      <section className="panel"><div className="panel-heading"><div><h2>Balance sheet</h2><p>As at {report.financialYear.end}</p></div></div>
        <SummaryLine label="Assets" value={balanceSheet.assets} />
        <SummaryLine label="Liabilities" value={balanceSheet.liabilities} />
        <SummaryLine label="Equity and retained earnings" value={balanceSheet.equity} />
        <SummaryLine label="Balance check" value={balanceSheet.assets - balanceSheet.liabilities - balanceSheet.equity} strong />
      </section>
      <section className="panel"><div className="panel-heading"><div><h2>Working capital</h2><p>Outstanding account balances</p></div></div>
        <SummaryLine label="Creditors outstanding" value={creditors.outstanding} />
        <SummaryLine label="Open supplier invoices" value={creditors.count} numeric />
        <SummaryLine label="Debtors outstanding" value={debtors.outstanding} />
        <SummaryLine label="Open customer invoices" value={debtors.count} numeric />
      </section>
    </div>
    <section className="panel">
      <div className="panel-heading"><div><h2>Trial balance</h2><p>Cumulative posted ledger balances through financial year-end.</p></div><span className={`status-pill ${Math.abs(trialDebit - trialCredit) < .01 ? "status-posted" : "status-low"}`}>{Math.abs(trialDebit - trialCredit) < .01 ? "Balanced" : "Out of balance"}</span></div>
      <div className="table-scroll"><table><thead><tr><th>Account</th><th>Name</th><th>Type</th><th className="align-right">Debits</th><th className="align-right">Credits</th><th className="align-right">Balance</th></tr></thead>
        <tbody>{accounts.map((account) => <tr key={account.id}><td className="primary-cell">{account.code}</td><td>{account.name}</td><td>{account.type}</td><td className="align-right">{money(account.debits)}</td><td className="align-right">{money(account.credits)}</td><td className="align-right">{money(account.balance)}</td></tr>)}</tbody>
        <tfoot><tr><th colSpan="3">Total</th><th className="align-right">{money(trialDebit)}</th><th className="align-right">{money(trialCredit)}</th><th /></tr></tfoot>
      </table></div>
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Monthly profit and loss</h2><p>Income, expenses, and operating result by month.</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>Month</th><th className="align-right">Income</th><th className="align-right">Expenses</th><th className="align-right">Net</th></tr></thead>
        <tbody>{monthly.map((month) => <tr key={month.month}><td>{new Date(`${month.month}-01T00:00:00`).toLocaleString(undefined, { month: "long", year: "numeric" })}</td><td className="align-right">{money(month.income)}</td><td className="align-right">{money(month.expenses)}</td><td className="align-right">{money(month.profit)}</td></tr>)}</tbody>
      </table></div>
    </section>
    <section className="panel"><div className="panel-heading"><div><h2>Journal register</h2><p>Latest posted transactions for the selected financial year.</p></div></div>
      {report.journalEntries.length ? <div className="table-scroll"><table><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th>Posted by</th><th className="align-right">Debit</th><th className="align-right">Credit</th></tr></thead>
        <tbody>{report.journalEntries.map((entry) => {
          const debit = entry.lines.reduce((sum, line) => sum + line.debit, 0);
          const credit = entry.lines.reduce((sum, line) => sum + line.credit, 0);
          return <tr key={entry.id}><td>{entry.date}</td><td className="primary-cell">{entry.reference}</td><td>{entry.description}</td><td>{entry.posted_by_email ?? "System"}</td><td className="align-right">{money(debit)}</td><td className="align-right">{money(credit)}</td></tr>;
        })}</tbody>
      </table></div> : <p className="muted-copy">No journal entries in this financial year.</p>}
    </section>
  </>;
}

function OpenInvoices({ title, description, invoices, accountBalance, invoiceBalance, reconciled, canCreate, busy, customer, onSubmit, empty }) {
  return <>
    {!customer && <div className="stats-grid compact-stats ap-control-stats">
      <Stat label="Unpaid invoice balance" value={money(invoiceBalance)} note={`${invoices.length} open supplier invoices`} tone="blue" />
      <Stat label="AP control account · GL" value={money(accountBalance)} note="Credit balance in account 2000" tone="green" />
      <Stat label="Invoice-to-ledger check" value={reconciled ? "Balanced" : "Review"} note={reconciled ? "Open invoices agree with the general ledger." : "Control account differs from supplier invoices."} tone={reconciled ? "green" : "orange"} />
    </div>}
    <section className="panel"><div className="panel-heading"><div><h2>{title}</h2><p>{description}</p></div></div>
    {invoices.length ? <div className="table-scroll"><table>
      <thead><tr><th>Invoice</th><th>{customer ? "Customer" : "Supplier"}</th><th>Date / due</th><th className="align-right">Total</th><th className="align-right">Outstanding</th><th>Status</th>{canCreate && <th>Record {customer ? "receipt" : "payment"}</th>}</tr></thead>
      <tbody>{invoices.map((invoice) => <tr key={invoice.id}>
        <td className="primary-cell">{invoice.reference}</td><td>{customer ? invoice.customer : <>{invoice.supplier}{invoice.supplier_code && <span className="secondary-cell">Code: {invoice.supplier_code}</span>}</>}</td>
        <td>{invoice.date}{invoice.due_date && <span className="secondary-cell">Due {invoice.due_date}</span>}</td>
        <td className="align-right">{money(invoice.total)}</td><td className="align-right">{money(invoice.total - invoice.paid_amount)}</td>
        <td><span className={`status-pill ${invoice.status === "Partially paid" ? "status-partial" : "status-open"}`}>{invoice.status}</span></td>
        {canCreate && <td><form className="payment-inline-form" onSubmit={onSubmit(invoice, customer)}>
          <input name="date" aria-label="Payment date" type="date" defaultValue={today()} required />
          <input name="amount" aria-label="Payment amount" type="number" min="0.01" max={invoice.total - invoice.paid_amount} step="0.01" placeholder="Amount" required />
          <input name="reference" aria-label="Payment reference" maxLength="80" placeholder="Reference" required />
          <button className="button button-secondary button-small" disabled={busy}>{customer ? "Receive" : "Pay"}</button>
        </form></td>}
      </tr>)}</tbody>
    </table></div> : <div className="empty-state"><strong>{empty}</strong></div>}
    </section>
  </>;
}

function SummaryLine({ label, value, numeric = false, strong = false }) {
  return <div className={`finance-summary-line${strong ? " strong" : ""}`}><span>{label}</span><strong>{numeric ? value : money(value)}</strong></div>;
}

function Stat({ label, value, note, tone }) {
  return <article className={`stat-card${tone ? ` tone-${tone}` : ""}`}><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-note">{note}</div></article>;
}
