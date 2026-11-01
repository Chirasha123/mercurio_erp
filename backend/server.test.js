import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.SQLITE_PATH = join(tmpdir(), `mercurio-test-${randomUUID()}.sqlite3`);
process.env.MASTER_ADMIN_EMAIL = "erp-admin@example.test";
process.env.MASTER_ADMIN_PASSWORD = "InitialBootstrap#123";

const [{ app }, auth, database] = await Promise.all([
  import("./server.js"),
  import("./auth.js"),
  import("./database.js"),
]);

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
let adminSession;

async function request(path, { method = "GET", session, body, csrf = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (session) {
    headers.Cookie = session.cookie;
    if (csrf && method !== "GET") headers["X-CSRF-Token"] = session.csrfToken;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  return { response, result };
}

async function login(email, password) {
  const { response, result } = await request("/auth/login", { method: "POST", body: { email, password }, csrf: false });
  assert.equal(response.status, 200, result.error);
  return {
    cookie: response.headers.get("set-cookie").split(";")[0],
    csrfToken: result.csrfToken,
    user: result.user,
  };
}

test("SQLite ERP authentication, RBAC, stock workflows, and ledger reports", async () => {
  await auth.initializeMasterAdmin();
  adminSession = await login("erp-admin@example.test", "InitialBootstrap#123");
  assert.equal(adminSession.user.forcePasswordChange, true);

  const passwordChange = await request("/auth/change-password", {
    method: "POST",
    session: adminSession,
    body: { currentPassword: "InitialBootstrap#123", newPassword: "SecureNewPassword#987" },
  });
  assert.equal(passwordChange.response.status, 200, passwordChange.result.error);
  adminSession = await login("erp-admin@example.test", "SecureNewPassword#987");
  assert.equal(adminSession.user.forcePasswordChange, false);

  const createdItem = await request("/items", {
    method: "POST",
    session: adminSession,
    body: { sku: "BOARD-001", name: "Test board", unit: "pcs", minStock: 2 },
  });
  assert.equal(createdItem.response.status, 201, createdItem.result.error);
  const itemId = createdItem.result.id;

  const supplier = await request("/suppliers", {
    method: "POST",
    session: adminSession,
    body: {
      code: "SUP-TEST-001", name: "Test supplier", address: "10 Test Road",
      contactName: "Alex Supplier", email: "orders@example.test", phone: "+27110000000",
      notes: "Standard delivery", itemIds: [itemId],
    },
  });
  assert.equal(supplier.response.status, 201, supplier.result.error);
  assert.equal(supplier.result.code, "SUP-TEST-001");
  assert.deepEqual(supplier.result.itemIds, [itemId]);
  const supplierUpdate = await request(`/suppliers/${supplier.result.id}`, {
    method: "PUT",
    session: adminSession,
    body: {
      ...supplier.result,
      notes: "Updated supplier delivery terms",
    },
  });
  assert.equal(supplierUpdate.response.status, 200, supplierUpdate.result.error);
  assert.equal(supplierUpdate.result.notes, "Updated supplier delivery terms");

  const savedDetails = await request(`/items/${itemId}/details`, {
    method: "PUT",
    session: adminSession,
    body: {
      supplierCode: "SUP-BOARD-03",
      notes: "Store flat and keep dry.",
      imageData: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64"),
      imageMimeType: "image/png",
      imageFilename: "board.png",
    },
  });
  assert.equal(savedDetails.response.status, 200, savedDetails.result.error);
  assert.equal(savedDetails.result.supplierCode, "SUP-BOARD-03");
  assert.equal(savedDetails.result.notes, "Store flat and keep dry.");
  assert.equal(savedDetails.result.hasImage, 1);
  const loadedDetails = await request(`/items/${itemId}/details`, { session: adminSession });
  assert.equal(loadedDetails.response.status, 200);
  assert.equal(loadedDetails.result.supplierCode, "SUP-BOARD-03");
  assert.equal(loadedDetails.result.notes, "Store flat and keep dry.");
  const imageResponse = await fetch(`${baseUrl}/items/${itemId}/image`, {
    headers: { Cookie: adminSession.cookie },
  });
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get("content-type"), /image\/png/);
  assert.match(imageResponse.headers.get("cache-control"), /no-cache/);
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));

  const badImage = await request(`/items/${itemId}/details`, {
    method: "PUT",
    session: adminSession,
    body: {
      supplierCode: "SUP-BOARD-03", notes: "",
      imageData: Buffer.from("not an image").toString("base64"),
      imageMimeType: "image/png", imageFilename: "fake.png",
    },
  });
  assert.equal(badImage.response.status, 422);

  const purchaseOrder = await request("/purchase-orders", {
    method: "POST",
    session: adminSession,
    body: {
      reference: "PO-TEST-001", supplierId: supplier.result.id, date: "2026-03-14",
      lines: [{ itemId, quantity: 10, unitCost: 5 }],
    },
  });
  assert.equal(purchaseOrder.response.status, 201, purchaseOrder.result.error);
  assert.equal(purchaseOrder.result.supplierId, supplier.result.id);
  assert.equal(purchaseOrder.result.supplier, "Test supplier");

  const inactiveSupplier = await request("/suppliers", {
    method: "POST",
    session: adminSession,
    body: { code: "SUP-INACTIVE", name: "Inactive supplier", itemIds: [itemId], active: false },
  });
  assert.equal(inactiveSupplier.response.status, 201, inactiveSupplier.result.error);
  const inactiveSupplierOrder = await request("/purchase-orders", {
    method: "POST",
    session: adminSession,
    body: {
      reference: "PO-INACTIVE-SUPPLIER", supplierId: inactiveSupplier.result.id, date: "2026-03-14",
      lines: [{ itemId, quantity: 1, unitCost: 5 }],
    },
  });
  assert.equal(inactiveSupplierOrder.response.status, 404);

  const unknownSupplierOrder = await request("/purchase-orders", {
    method: "POST",
    session: adminSession,
    body: {
      reference: "PO-UNKNOWN-SUPPLIER", supplierId: randomUUID(), date: "2026-03-14",
      lines: [{ itemId, quantity: 1, unitCost: 5 }],
    },
  });
  assert.equal(unknownSupplierOrder.response.status, 404);

  const receipt = await request("/invoices", {
    method: "POST",
    session: adminSession,
    body: {
      reference: "SUP-TEST-001", supplierId: supplier.result.id, date: "2026-03-15",
      dueDate: "2026-04-15", orderId: purchaseOrder.result.id, lines: [{ itemId, quantity: 10, unitCost: 5 }],
    },
  });
  assert.equal(receipt.response.status, 201, receipt.result.error);
  assert.equal(receipt.result.supplierId, supplier.result.id);
  assert.equal(receipt.result.supplier, "Test supplier");
  assert.equal(database.db.prepare("SELECT supplier_id FROM supplier_invoices WHERE id = ?").get(receipt.result.id).supplier_id, supplier.result.id);
  assert.equal(database.db.prepare("SELECT order_id FROM supplier_invoices WHERE id = ?").get(receipt.result.id).order_id, purchaseOrder.result.id);

  for (const [type, id] of [
    ["purchase-order", purchaseOrder.result.id],
    ["supplier-invoice", receipt.result.id],
  ]) {
    const pdfResponse = await fetch(`${baseUrl}/documents/${type}/${id}/pdf`, {
      headers: { Cookie: adminSession.cookie },
    });
    assert.equal(pdfResponse.status, 200);
    assert.match(pdfResponse.headers.get("content-type"), /application\/pdf/);
    const pdfContent = Buffer.from(await pdfResponse.arrayBuffer()).toString("ascii", 0, 5);
    assert.equal(pdfContent, "%PDF-");
  }

  const smtpEnvironment = Object.fromEntries(["SMTP_HOST", "SMTP_FROM", "SMTP_USER", "SMTP_PASS"].map((key) => [key, process.env[key]]));
  try {
    for (const key of Object.keys(smtpEnvironment)) process.env[key] = "";
    const emailWithoutSmtp = await request(`/documents/supplier-invoice/${receipt.result.id}/email`, {
      method: "POST",
      session: adminSession,
      body: { to: "recipient@example.test" },
    });
    assert.equal(emailWithoutSmtp.response.status, 503);
    assert.match(emailWithoutSmtp.result.error, /Email is not set up yet/);
  } finally {
    for (const [key, value] of Object.entries(smtpEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const workspace = await request("/workspace", { session: adminSession });
  assert.equal(workspace.response.status, 200, workspace.result.error);
  assert.equal(workspace.result.items.find((item) => item.id === itemId).onHand, 10);
  assert.equal(workspace.result.suppliers.find((entry) => entry.id === supplier.result.id).itemIds[0], itemId);
  const categoryId = workspace.result.categories[0].id;

  const job = await request("/jobcards", {
    method: "POST",
    session: adminSession,
    body: { reference: "JC-TEST-001", title: "Test job", customer: "", categoryId, date: "2026-03-16" },
  });
  assert.equal(job.response.status, 201, job.result.error);
  const reservation = await request(`/jobcards/${job.result.id}/materials`, {
    method: "POST",
    session: adminSession,
    body: { itemId, quantity: 3 },
  });
  assert.equal(reservation.response.status, 201, reservation.result.error);
  const closeJob = await request(`/jobcards/${job.result.id}/status`, {
    method: "PATCH",
    session: adminSession,
    body: { status: "Completed" },
  });
  assert.equal(closeJob.response.status, 200, closeJob.result.error);

  const itemReport = await request(`/items/${itemId}/report?year=2026`, { session: adminSession });
  assert.equal(itemReport.response.status, 200, itemReport.result.error);
  assert.equal(itemReport.result.months.reduce((sum, month) => sum + month.broughtIn, 0), 10);
  assert.equal(itemReport.result.months.reduce((sum, month) => sum + month.takenOut, 0), 3);
  assert.equal(itemReport.result.movements.length, 2);
  assert.ok(itemReport.result.movements.some((movement) => movement.invoice?.reference === "SUP-TEST-001"));
  assert.ok(itemReport.result.movements.some((movement) => movement.jobcard?.reference === "JC-TEST-001"));

  const supplierPayment = await request(`/finance/creditors/${receipt.result.id}/payments`, {
    method: "POST",
    session: adminSession,
    body: { date: "2026-04-01", amount: 20, reference: "PAY-TEST-001" },
  });
  assert.equal(supplierPayment.response.status, 201, supplierPayment.result.error);
  const payableLedgerBalance = database.db.prepare(`
    SELECT SUM(lines.credit - lines.debit) AS balance FROM journal_lines lines
    JOIN accounts ON accounts.id = lines.account_id
    WHERE accounts.code = '2000'
  `).get().balance;
  assert.equal(payableLedgerBalance, 30);

  const salesInvoice = await request("/sales/invoices", {
    method: "POST",
    session: adminSession,
    body: {
      reference: "SALE-TEST-001", customer: "Test customer", customerEmail: "",
      date: "2026-04-02", dueDate: "2026-05-02",
      lines: [{ description: "Test sale", quantity: 1, unitPrice: 100 }],
    },
  });
  assert.equal(salesInvoice.response.status, 201, salesInvoice.result.error);
  const customerReceipt = await request(`/finance/debtors/${salesInvoice.result.id}/receipts`, {
    method: "POST",
    session: adminSession,
    body: { date: "2026-04-03", amount: 25, reference: "REC-TEST-001" },
  });
  assert.equal(customerReceipt.response.status, 201, customerReceipt.result.error);

  const stocktake = await request("/finance/stocktakes", {
    method: "POST",
    session: adminSession,
    body: { reference: "ST-TEST-001", date: "2026-04-04", lines: [{ itemId, countedQuantity: 8 }] },
  });
  assert.equal(stocktake.response.status, 201, stocktake.result.error);

  const finance = await request("/finance/overview?year=2026", { session: adminSession });
  assert.equal(finance.response.status, 200, finance.result.error);
  assert.equal(finance.result.profitAndLoss.income, 100);
  assert.equal(finance.result.profitAndLoss.netProfit, 90);
  assert.equal(finance.result.creditors.outstanding, 30);
  assert.equal(finance.result.debtors.outstanding, 75);
  assert.equal(finance.result.inventory.value, 40);
  assert.ok(Math.abs(finance.result.balanceSheet.assets - finance.result.balanceSheet.liabilities - finance.result.balanceSheet.equity) < 0.00001);
  const trialDebits = finance.result.accounts.reduce((sum, account) => sum + account.debits, 0);
  const trialCredits = finance.result.accounts.reduce((sum, account) => sum + account.credits, 0);
  assert.ok(Math.abs(trialDebits - trialCredits) < 0.00001);

  const financialReport = await request("/finance/reporting?year=2026", { session: adminSession });
  assert.equal(financialReport.response.status, 200, financialReport.result.error);
  const inventoryReport = await request("/reports/inventory?year=2026", { session: adminSession });
  assert.equal(inventoryReport.response.status, 200, inventoryReport.result.error);
  assert.equal(inventoryReport.result.totals.broughtIn, 10);
  assert.equal(inventoryReport.result.totals.takenOut, 3);
  assert.equal(inventoryReport.result.totals.adjustment, 1);
  const procurementReport = await request("/reports/procurement?year=2026", { session: adminSession });
  assert.equal(procurementReport.response.status, 200, procurementReport.result.error);
  assert.equal(procurementReport.result.totals.purchaseValue, 50);
  const salesReport = await request("/reports/sales?year=2026", { session: adminSession });
  assert.equal(salesReport.response.status, 200, salesReport.result.error);
  assert.equal(salesReport.result.totals.invoiced, 100);
  const productionReport = await request("/reports/production?year=2026", { session: adminSession });
  assert.equal(productionReport.response.status, 200, productionReport.result.error);
  assert.equal(productionReport.result.totals.unitsIssued, 3);

  const budgets = await request("/finance/budgets?year=2026", { session: adminSession });
  assert.equal(budgets.response.status, 200, budgets.result.error);
  const expenseAccount = budgets.result.accounts.find((account) => account.type === "Expense");
  assert.ok(expenseAccount);
  const saveBudget = await request("/finance/budgets", {
    method: "PUT",
    session: adminSession,
    body: {
      year: 2026,
      lines: [{ accountId: expenseAccount.id, month: "2026-03-01", amount: 250 }],
    },
  });
  assert.equal(saveBudget.response.status, 200, saveBudget.result.error);
  const savedBudget = await request("/finance/budgets?year=2026", { session: adminSession });
  assert.equal(savedBudget.result.budgets.find((entry) => entry.accountId === expenseAccount.id)?.amount, 250);
  const ledger = await request(`/finance/ledger?year=2026&accountId=all&page=1`, { session: adminSession });
  assert.equal(ledger.response.status, 200, ledger.result.error);
  assert.ok(ledger.result.total >= 6);

  const user = await request("/admin/users", {
    method: "POST",
    session: adminSession,
    body: { email: "limited@example.test", temporaryPassword: "Temporary#123456" },
  });
  assert.equal(user.response.status, 201, user.result.error);
  const grant = await request(`/admin/users/${user.result.user.id}/permissions`, {
    method: "PATCH",
    session: adminSession,
    body: { permissions: { FM: ["view"] } },
  });
  assert.equal(grant.response.status, 200, grant.result.error);
  let limitedSession = await login("limited@example.test", "Temporary#123456");
  assert.equal(limitedSession.user.forcePasswordChange, true);
  const limitedPasswordChange = await request("/auth/change-password", {
    method: "POST",
    session: limitedSession,
    body: { currentPassword: "Temporary#123456", newPassword: "LimitedUserPassword#456" },
  });
  assert.equal(limitedPasswordChange.response.status, 200, limitedPasswordChange.result.error);
  limitedSession = await login("limited@example.test", "LimitedUserPassword#456");
  assert.equal((await request("/finance/overview?year=2026", { session: limitedSession })).response.status, 200);
  assert.equal((await request("/finance/reporting?year=2026", { session: limitedSession })).response.status, 403);
  assert.equal((await request("/reports/inventory?year=2026", { session: limitedSession })).response.status, 403);
  assert.equal((await request(`/items/${itemId}/details`, { session: limitedSession })).response.status, 403);
  assert.equal((await fetch(`${baseUrl}/documents/supplier-invoice/${receipt.result.id}/pdf`, {
    headers: { Cookie: limitedSession.cookie },
  })).status, 403);
  const forbidden = await request("/items", {
    method: "POST",
    session: limitedSession,
    body: { sku: "DENIED", name: "Denied", unit: "pcs", minStock: 0 },
  });
  assert.equal(forbidden.response.status, 403);
  const forbiddenSupplierCreate = await request("/suppliers", {
    method: "POST",
    session: limitedSession,
    body: { code: "SUP-DENIED", name: "Denied supplier" },
  });
  assert.equal(forbiddenSupplierCreate.response.status, 403);
  const forbiddenSupplierEdit = await request(`/suppliers/${supplier.result.id}`, {
    method: "PUT",
    session: limitedSession,
    body: { code: "SUP-TEST-001", name: "Test supplier", itemIds: [] },
  });
  assert.equal(forbiddenSupplierEdit.response.status, 403);
  const deniedDetailsEdit = await request(`/items/${itemId}/details`, {
    method: "PUT",
    session: limitedSession,
    body: { supplierCode: "UNAUTHORIZED", notes: "" },
  });
  assert.equal(deniedDetailsEdit.response.status, 403);

  const payableUser = await request("/admin/users", {
    method: "POST",
    session: adminSession,
    body: { email: "payables@example.test", temporaryPassword: "Payables#Temporary123" },
  });
  assert.equal(payableUser.response.status, 201, payableUser.result.error);
  const payableGrant = await request(`/admin/users/${payableUser.result.user.id}/permissions`, {
    method: "PATCH",
    session: adminSession,
    body: { permissions: { AP: ["view", "create"] } },
  });
  assert.equal(payableGrant.response.status, 200, payableGrant.result.error);
  let payableSession = await login("payables@example.test", "Payables#Temporary123");
  const payablePasswordChange = await request("/auth/change-password", {
    method: "POST",
    session: payableSession,
    body: { currentPassword: "Payables#Temporary123", newPassword: "Payables#Changed456" },
  });
  assert.equal(payablePasswordChange.response.status, 200, payablePasswordChange.result.error);
  payableSession = await login("payables@example.test", "Payables#Changed456");
  const payableWorkspace = await request("/workspace", { session: payableSession });
  assert.equal(payableWorkspace.response.status, 200);
  assert.deepEqual(payableWorkspace.result.user.permissions.AP, ["view", "create"]);
  assert.ok(payableWorkspace.result.suppliers.some((entry) => entry.id === supplier.result.id));
  assert.ok(payableWorkspace.result.items.some((entry) => entry.id === itemId));
  assert.equal((await request("/finance/creditors", { session: payableSession })).response.status, 200);
  assert.equal((await request("/finance/overview?year=2026", { session: payableSession })).response.status, 403);
  const payableSupplier = await request("/suppliers", {
    method: "POST",
    session: payableSession,
    body: { code: "SUP-AP-NEW", name: "AP-only supplier", itemIds: [itemId] },
  });
  assert.equal(payableSupplier.response.status, 201, payableSupplier.result.error);
  const payableCannotCreateOrder = await request("/purchase-orders", {
    method: "POST",
    session: payableSession,
    body: { reference: "PO-AP-DENIED", supplierId: supplier.result.id, date: "2026-03-14", lines: [{ itemId, quantity: 1, unitCost: 5 }] },
  });
  assert.equal(payableCannotCreateOrder.response.status, 403);
  const finalSupplierPayment = await request(`/finance/creditors/${receipt.result.id}/payments`, {
    method: "POST",
    session: payableSession,
    body: { date: "2026-04-02", amount: 30, reference: "PAY-TEST-002" },
  });
  assert.equal(finalSupplierPayment.response.status, 201, finalSupplierPayment.result.error);
  const reconciledCreditors = await request("/finance/creditors", { session: payableSession });
  assert.equal(reconciledCreditors.result.reconciled, true);
  assert.equal(reconciledCreditors.result.accountBalance, 0);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  database.db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { unlinkSync(`${process.env.SQLITE_PATH}${suffix}`); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
});
