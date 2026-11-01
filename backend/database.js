import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const databasePath = resolve(process.env.SQLITE_PATH ?? "./data/mercurio.sqlite3");
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

export const db = new Database(databasePath);
chmodSync(databasePath, 0o600);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    master_admin INTEGER NOT NULL DEFAULT 0 CHECK (master_admin IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    force_password_change INTEGER NOT NULL DEFAULT 1 CHECK (force_password_change IN (0, 1)),
    permissions TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity_type, entity_id, created_at);

  CREATE TABLE IF NOT EXISTS jobcard_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inventory_items (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    min_stock REAL NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
    on_hand REAL NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
    reserved REAL NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
    average_cost REAL NOT NULL DEFAULT 0 CHECK (average_cost >= 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS inventory_sku_idx ON inventory_items(sku);
  CREATE TABLE IF NOT EXISTS inventory_item_details (
    item_id TEXT PRIMARY KEY REFERENCES inventory_items(id) ON DELETE CASCADE,
    supplier_code TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    image_data BLOB,
    image_mime_type TEXT,
    image_filename TEXT,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (
      (image_data IS NULL AND image_mime_type IS NULL AND image_filename IS NULL)
      OR (image_data IS NOT NULL AND image_mime_type IS NOT NULL AND image_filename IS NOT NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL COLLATE NOCASE,
    address TEXT NOT NULL DEFAULT '',
    contact_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS suppliers_name_idx ON suppliers(name);
  CREATE TABLE IF NOT EXISTS supplier_items (
    supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    PRIMARY KEY (supplier_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS purchase_orders (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE COLLATE NOCASE,
    supplier TEXT NOT NULL,
    supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
    date TEXT NOT NULL,
    total REAL NOT NULL CHECK (total >= 0),
    status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Partially received', 'Received')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS purchase_order_lines (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
    total REAL NOT NULL CHECK (total >= 0),
    received_quantity REAL NOT NULL DEFAULT 0 CHECK (received_quantity >= 0 AND received_quantity <= quantity)
  );

  CREATE TABLE IF NOT EXISTS supplier_invoices (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE COLLATE NOCASE,
    supplier TEXT NOT NULL,
    supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
    date TEXT NOT NULL,
    due_date TEXT,
    order_id TEXT REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    total REAL NOT NULL CHECK (total >= 0),
    paid_amount REAL NOT NULL DEFAULT 0 CHECK (paid_amount >= 0 AND paid_amount <= total),
    status TEXT NOT NULL DEFAULT 'Posted' CHECK (status IN ('Posted', 'Partially paid', 'Paid')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS supplier_invoice_due_idx ON supplier_invoices(due_date, status);
  CREATE TABLE IF NOT EXISTS supplier_invoice_lines (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
    item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
    total REAL NOT NULL CHECK (total >= 0)
  );

  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sales_invoices (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE COLLATE NOCASE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    date TEXT NOT NULL,
    due_date TEXT,
    total REAL NOT NULL CHECK (total >= 0),
    paid_amount REAL NOT NULL DEFAULT 0 CHECK (paid_amount >= 0 AND paid_amount <= total),
    status TEXT NOT NULL DEFAULT 'Posted' CHECK (status IN ('Posted', 'Partially paid', 'Paid')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS sales_invoice_due_idx ON sales_invoices(due_date, status);
  CREATE TABLE IF NOT EXISTS sales_invoice_lines (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
    description TEXT NOT NULL,
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit_price REAL NOT NULL CHECK (unit_price >= 0),
    total REAL NOT NULL CHECK (total >= 0)
  );

  CREATE TABLE IF NOT EXISTS jobcards (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE COLLATE NOCASE,
    title TEXT NOT NULL,
    customer TEXT NOT NULL DEFAULT '',
    category_id TEXT NOT NULL REFERENCES jobcard_categories(id) ON DELETE RESTRICT,
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'In progress', 'Completed')),
    closed_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS jobcards_status_idx ON jobcards(status, date);
  CREATE TABLE IF NOT EXISTS jobcard_materials (
    id TEXT PRIMARY KEY,
    jobcard_id TEXT NOT NULL REFERENCES jobcards(id) ON DELETE RESTRICT,
    item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL CHECK (quantity > 0),
    reserved_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL CHECK (quantity != 0),
    type TEXT NOT NULL CHECK (type IN ('Receipt', 'Jobcard issue', 'Stock adjustment')),
    date TEXT NOT NULL,
    reference TEXT NOT NULL,
    invoice_id TEXT REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
    jobcard_id TEXT REFERENCES jobcards(id) ON DELETE RESTRICT,
    stocktake_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS stock_movements_item_date_idx ON stock_movements(item_id, date, created_at);

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('Asset', 'Liability', 'Equity', 'Income', 'Expense')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    posted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_type, source_id)
  );
  CREATE INDEX IF NOT EXISTS journal_entries_date_idx ON journal_entries(date);
  CREATE TABLE IF NOT EXISTS journal_lines (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    debit REAL NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit REAL NOT NULL DEFAULT 0 CHECK (credit >= 0),
    CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
  );

  CREATE TABLE IF NOT EXISTS supplier_payments (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
    date TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    reference TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS customer_receipts (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
    date TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    reference TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stocktakes (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE COLLATE NOCASE,
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Posted' CHECK (status = 'Posted'),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS stocktake_lines (
    id TEXT PRIMARY KEY,
    stocktake_id TEXT NOT NULL REFERENCES stocktakes(id) ON DELETE RESTRICT,
    item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    system_quantity REAL NOT NULL,
    counted_quantity REAL NOT NULL CHECK (counted_quantity >= 0),
    variance REAL NOT NULL,
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0)
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    month TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, month),
    CHECK (month GLOB '????-??-01')
  );
  CREATE INDEX IF NOT EXISTS budgets_month_idx ON budgets(month);
`);

const purchaseOrderColumns = db.pragma("table_info(purchase_orders)");
if (!purchaseOrderColumns.some((column) => column.name === "supplier_id")) {
  db.exec("ALTER TABLE purchase_orders ADD COLUMN supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT");
}
const supplierInvoiceColumns = db.pragma("table_info(supplier_invoices)");
if (!supplierInvoiceColumns.some((column) => column.name === "supplier_id")) {
  db.exec("ALTER TABLE supplier_invoices ADD COLUMN supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT");
}

const defaultCategories = [
  "factory_stock",
  "monochrome_boards",
  "fullcolour_boards",
  "sed stock",
  "suitcases",
  "manufacturing",
  "queue_sys",
];
const insertCategory = db.prepare("INSERT OR IGNORE INTO jobcard_categories (id, name) VALUES (?, ?)");
for (const name of defaultCategories) insertCategory.run(cryptoId(), name);

const defaultAccounts = [
  ["1000", "Cash and bank", "Asset"],
  ["1100", "Accounts receivable", "Asset"],
  ["1200", "Inventory", "Asset"],
  ["2000", "Accounts payable", "Liability"],
  ["3000", "Owner equity", "Equity"],
  ["4000", "Sales revenue", "Income"],
  ["5000", "Cost of goods sold", "Expense"],
  ["5100", "Inventory adjustments", "Expense"],
  ["6000", "Operating expenses", "Expense"],
];
const insertAccount = db.prepare(
  "INSERT OR IGNORE INTO accounts (id, code, name, type) VALUES (?, ?, ?, ?)",
);
for (const [code, name, type] of defaultAccounts) insertAccount.run(cryptoId(), code, name, type);

function cryptoId() {
  return randomUUID();
}

export function newId() {
  return cryptoId();
}

export function audit(userId, action, entityType, entityId, details = {}) {
  db.prepare(`
    INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(newId(), userId ?? null, action, entityType, entityId ?? null, JSON.stringify(details));
}

export function postJournal({ reference, date, description, sourceType, sourceId, userId, lines }) {
  const debit = lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = lines.reduce((sum, line) => sum + line.credit, 0);
  if (Math.abs(debit - credit) > 0.00001 || debit <= 0) {
    throw new Error("Journal entry is not balanced.");
  }
  const entryId = newId();
  db.prepare(`
    INSERT INTO journal_entries (id, reference, date, description, source_type, source_id, posted_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(entryId, reference, date, description, sourceType, sourceId, userId ?? null);
  const insertLine = db.prepare(`
    INSERT INTO journal_lines (id, entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?, ?)
  `);
  for (const line of lines) {
    insertLine.run(newId(), entryId, line.accountId, line.debit, line.credit);
  }
  return entryId;
}

export function accountId(code) {
  const account = db.prepare("SELECT id FROM accounts WHERE code = ? AND active = 1").get(code);
  if (!account) throw new Error(`Required ledger account ${code} is missing.`);
  return account.id;
}

export function verifyJournalBalance(entryId) {
  const balance = db.prepare(`
    SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
    FROM journal_lines WHERE entry_id = ?
  `).get(entryId);
  return Math.abs(balance.debit - balance.credit) < 0.00001;
}
