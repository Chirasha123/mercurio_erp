let csrfToken = "";

export function setCsrfToken(token) {
  csrfToken = token ?? "";
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        ...options.headers,
      },
      credentials: "same-origin",
    });
  } catch (error) {
    throw new Error(`Could not connect to the ERP server. Check that the backend is running. (${error.message})`, { cause: error });
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error ?? `ERP request failed with status ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export const erpApi = {
  getSession: () => request("/auth/me"),
  login: (credentials) => request("/auth/login", { method: "POST", body: JSON.stringify(credentials) }),
  logout: () => request("/auth/logout", { method: "POST" }),
  changePassword: (passwords) => request("/auth/change-password", { method: "POST", body: JSON.stringify(passwords) }),
  getAdminUsers: () => request("/admin/users"),
  getAudit: () => request("/audit"),
  createUser: (user) => request("/admin/users", { method: "POST", body: JSON.stringify(user) }),
  updatePermissions: (userId, permissions) => request(`/admin/users/${userId}/permissions`, {
    method: "PATCH", body: JSON.stringify({ permissions }),
  }),
  setUserActive: (userId, active) => request(`/admin/users/${userId}/active`, {
    method: "PATCH", body: JSON.stringify({ active }),
  }),
  getWorkspace: () => request("/workspace"),
  createSupplier: (supplier) => request("/suppliers", { method: "POST", body: JSON.stringify(supplier) }),
  updateSupplier: (supplierId, supplier) => request(`/suppliers/${supplierId}`, {
    method: "PUT", body: JSON.stringify(supplier),
  }),
  getItemReport: (itemId, year) => request(`/items/${itemId}/report?year=${year}`),
  getItemDetails: (itemId) => request(`/items/${itemId}/details`),
  saveItemDetails: (itemId, details) => request(`/items/${itemId}/details`, {
    method: "PUT", body: JSON.stringify(details),
  }),
  getInventoryReport: (year) => request(`/reports/inventory?year=${year}`),
  getProcurementReport: (year) => request(`/reports/procurement?year=${year}`),
  getSalesReport: (year) => request(`/reports/sales?year=${year}`),
  getProductionReport: (year) => request(`/reports/production?year=${year}`),
  getFinanceOverview: (year) => request(`/finance/overview?year=${year}`),
  getFinancialReporting: (year) => request(`/finance/reporting?year=${year}`),
  getLedger: (year, accountId, page) => request(`/finance/ledger?year=${year}&accountId=${accountId}&page=${page}`),
  getBudgets: (year) => request(`/finance/budgets?year=${year}`),
  saveBudgets: (budgets) => request("/finance/budgets", { method: "PUT", body: JSON.stringify(budgets) }),
  getCreditors: () => request("/finance/creditors"),
  getDebtors: () => request("/finance/debtors"),
  getStocktakes: () => request("/finance/stocktakes"),
  getSalesInvoices: () => request("/sales/invoices"),
  emailDocument: (type, id, to) => request(`/documents/${type}/${id}/email`, {
    method: "POST", body: JSON.stringify({ to }),
  }),
  createItem: (item) => request("/items", { method: "POST", body: JSON.stringify(item) }),
  createOrder: (order) => request("/purchase-orders", { method: "POST", body: JSON.stringify(order) }),
  createInvoice: (invoice) => request("/invoices", { method: "POST", body: JSON.stringify(invoice) }),
  createJobcard: (jobcard) => request("/jobcards", { method: "POST", body: JSON.stringify(jobcard) }),
  reserveJobcardMaterial: (jobId, material) => request(`/jobcards/${jobId}/materials`, {
    method: "POST",
    body: JSON.stringify(material),
  }),
  removeJobcardMaterial: (jobId, materialId) => request(`/jobcards/${jobId}/materials/${materialId}`, {
    method: "DELETE",
  }),
  updateJobcardStatus: (jobId, status) => request(`/jobcards/${jobId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  }),
  createCategory: (name) => request("/categories", {
    method: "POST",
    body: JSON.stringify({ name }),
  }),
  createSalesInvoice: (invoice) => request("/sales/invoices", { method: "POST", body: JSON.stringify(invoice) }),
  createSupplierPayment: (invoiceId, payment) => request(`/finance/creditors/${invoiceId}/payments`, {
    method: "POST", body: JSON.stringify(payment),
  }),
  createCustomerReceipt: (invoiceId, receipt) => request(`/finance/debtors/${invoiceId}/receipts`, {
    method: "POST", body: JSON.stringify(receipt),
  }),
  createStocktake: (stocktake) => request("/finance/stocktakes", {
    method: "POST", body: JSON.stringify(stocktake),
  }),
};
