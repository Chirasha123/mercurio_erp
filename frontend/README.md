# Mercurio ERP workspace

Mercurio is a React/Vite ERP prototype backed by an Express API and SQLite. Its
navigation is organized into MM (Materials Management), PRM (Procurement
Management), SM (Sales Management), FM (Financial Management), and PM
(Production Management), with Jobcards nested under PM.

## Run locally

1. Install backend dependencies and configure the first administrator in the
   backend process environment:

   ```sh
   cd backend
   npm install
   export MASTER_ADMIN_EMAIL="admin@example.com"
   export MASTER_ADMIN_PASSWORD="use-a-unique-secret-of-at-least-12-characters"
   npm run dev
   ```

   The environment values are needed only the first time an empty database
   starts. The bootstrap password is hashed in SQLite, and the administrator
   must replace it at first sign-in. Do not commit credentials or put them in
   frontend code. The database is created at `backend/data/mercurio.sqlite3`
   by default; set `SQLITE_PATH` to choose another location.

2. In a second terminal, install and start the frontend:

   ```sh
   cd frontend
   npm install
   npm run dev
   ```

The Vite development server proxies `/api` requests to the backend on port
3001. Run backend checks from `backend/` with `npm test`; run a production
frontend build from `frontend/` with `npm run build`.

## Modules and workflows

- **MM:** inventory items, reorder levels, stock balances, and an
  **Inventory Reports** submenu with financial-year stock valuation, monthly
  receipts/issues, and a line-by-line source-linked movement register.
- **PRM:** purchase orders and supplier invoices. Purchase orders do not change
  stock; posting an invoice receives stock, records its movement, and journals
  inventory against accounts payable. **Procurement Reports** summarizes
  supplier invoices, purchase orders, and monthly purchase value. Purchase
  orders and supplier invoices can be opened as generated PDFs for printing or
  emailed as PDF attachments to an address entered at send time.
- **PM:** configurable jobcard categories and material reservations. Stock is
  reserved while work is open and deducted only when the jobcard is completed
  and closed. **Jobcard Reports** provides category, status, and material-issue
  registers.
- **SM:** customer invoices and accounts-receivable balances. Sales invoices
  can be printed as PDFs or emailed to the customer's saved email address (which
  can be changed for each send). **Sales Reports** summarizes customer
  performance, invoices, receipts, and outstanding amounts.
- **FM:** general ledger, accounts payable/receivable, monthly budgets compared
  with posted actuals, and stock takes. The nested **Financial Reporting**
  section includes the trial balance, balance sheet, profit and loss, monthly
  statements, working capital, and journal register. Budgets are maintained per
  income or expense account across the March–February financial year.
- **Admin:** master-admin user creation, per-module permissions, account
  activation, and recent audit history. New accounts start with limited
  Materials Management view access and must change their temporary password.

## Security and deployment notes

The API uses scrypt password hashes, expiring server-side sessions, HttpOnly
cookies, CSRF tokens, rate limiting, and module/action permission checks.
Configure production HTTPS and set `SESSION_COOKIE_SECURE=true`; set
`CORS_ORIGINS` to only the deployed frontend origins. Restrict access to the
SQLite file and use a tested backup/restore process that accounts for SQLite
WAL files. To enable document email, configure `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, and `SMTP_FROM` in the backend environment. Set `SMTP_USER` and
`SMTP_PASS` together when the mail server requires authentication. The app
does not send email until SMTP settings are provided; keep SMTP credentials
server-side and never add them to frontend settings.

For Gmail, first enable 2-Step Verification and create a Google **App
Password**. Copy `backend/.env.example` to `backend/.env`, then set
`SMTP_USER` and `SMTP_FROM` to the sending Gmail address and `SMTP_PASS` to
that App Password. The example uses Gmail's SMTP host and port. Restart the
backend after saving the file. Use the App Password, not your normal Google
password, and never share it in chat or commit `backend/.env`. The generated
PDF is a Mercurio copy of the purchase record; it does not include an uploaded
scan or original supplier document.

This is an operational foundation, not a fully certified or production-ready
accounting system. Before relying on it for statutory books, have an
accountant validate the chart of accounts, tax/VAT handling, accounting
periods, opening balances, and report calculations. Tax configuration,
currency handling, bank reconciliation, payroll, period locking, and attaching
original supplier documents are not implemented. Financial amounts currently
use plain numbers without a configured currency or tax rules.
