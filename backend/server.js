import "dotenv/config";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import { z } from "zod";
import {
  authenticate, changeUserPassword, createSession, createUserRecord, destroySession,
  initializeMasterAdmin, modulePermissions, requireCsrf, requireMasterAdmin,
  requireAnyPermission, requirePermission, serializeUser, setUserActive, updateUserPermissions, verifyPassword,
} from "./auth.js";
import { accountId, audit, db, newId, postJournal } from "./database.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);
const idSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Invalid date.");
const lineSchema = z.object({
  itemId: idSchema, quantity: z.number().finite().positive(), unitCost: z.number().finite().nonnegative(),
});
const purchaseSchema = z.object({
  reference: z.string().trim().min(1).max(60), supplierId: idSchema,
  date: dateSchema, lines: z.array(lineSchema).min(1).max(100),
});
const invoiceSchema = z.object({
  reference: z.string().trim().min(1).max(60), supplierId: idSchema,
  date: dateSchema, lines: z.array(lineSchema).min(1).max(100),
  orderId: idSchema.nullable().optional(), dueDate: dateSchema.nullable().optional(),
});
const salesInvoiceSchema = z.object({
  reference: z.string().trim().min(1).max(60), customer: z.string().trim().min(1).max(100),
  customerEmail: z.string().trim().email().max(254).or(z.literal("")).default(""),
  date: dateSchema, dueDate: dateSchema.nullable().optional(),
  lines: z.array(z.object({
    description: z.string().trim().min(1).max(200),
    quantity: z.number().finite().positive(),
    unitPrice: z.number().finite().nonnegative(),
  })).min(1).max(100),
});
const budgetsSchema = z.object({
  year: z.number().int().min(2000).max(2200),
  lines: z.array(z.object({
    accountId: idSchema, month: z.string().regex(/^\d{4}-\d{2}-01$/), amount: z.number().finite().nonnegative(),
  })).min(1).max(1200),
}).superRefine(({ year, lines }, ctx) => {
  const keys = new Set();
  for (const [index, line] of lines.entries()) {
    const month = Number(line.month.slice(5, 7));
    const expectedYear = month >= 3 && month <= 12 ? year : year + 1;
    if (month < 1 || month > 12 || Number(line.month.slice(0, 4)) !== expectedYear) {
      ctx.addIssue({ code: "custom", path: ["lines", index, "month"], message: "Budget month must be within the selected March–February year." });
    }
    const key = `${line.accountId}:${line.month}`;
    if (keys.has(key)) ctx.addIssue({ code: "custom", path: ["lines", index], message: "Duplicate account budget month." });
    keys.add(key);
  }
});
const categorySchema = z.object({ name: z.string().trim().min(1).max(60) });
const itemSchema = z.object({
  sku: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(100),
  unit: z.string().trim().min(1).max(20), minStock: z.number().finite().nonnegative(),
});
const supplierSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(1000).default(""),
  contactName: z.string().trim().max(100).default(""),
  email: z.string().trim().email().max(254).or(z.literal("")).default(""),
  phone: z.string().trim().max(40).default(""),
  notes: z.string().trim().max(2000).default(""),
  itemIds: z.array(idSchema).max(500).default([]),
  active: z.boolean().default(true),
});
const itemDetailsSchema = z.object({
  supplierCode: z.string().trim().max(100),
  notes: z.string().trim().max(4000),
  imageData: z.string().max(2_800_000).nullable().optional(),
  imageMimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).nullable().optional(),
  imageFilename: z.string().trim().max(120).nullable().optional(),
  removeImage: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  const hasData = Boolean(value.imageData);
  const hasType = Boolean(value.imageMimeType);
  const hasFilename = Boolean(value.imageFilename);
  if ((hasData || hasType || hasFilename) && !(hasData && hasType && hasFilename)) {
    ctx.addIssue({ code: "custom", message: "Image data, type, and filename must all be supplied together." });
  }
  if (value.removeImage && hasData) {
    ctx.addIssue({ code: "custom", message: "Choose either a replacement image or image removal, not both." });
  }
});
const stocktakeSchema = z.object({
  reference: z.string().trim().min(1).max(60), date: dateSchema,
  lines: z.array(z.object({ itemId: idSchema, countedQuantity: z.number().finite().nonnegative() })).min(1).max(5000),
});
const paymentSchema = z.object({ date: dateSchema, amount: z.number().finite().positive(), reference: z.string().trim().min(1).max(80) });
const appError = (status, message) => Object.assign(new Error(message), { status });
const amountOf = (lines) => lines.reduce((sum, line) => sum + line.quantity * (line.unitCost ?? line.unitPrice), 0);
const yearRange = (year) => ({
  start: `${year}-03-01`,
  end: `${year + 1}-03-01`,
  lastDay: new Date(Date.UTC(year + 1, 2, 0)).toISOString().slice(0, 10),
});
const withAsync = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function record(statement, params, label) {
  const result = statement.get(...params);
  if (!result) throw appError(404, `${label} not found.`);
  return result;
}

function validateItems(lines) {
  const ids = [...new Set(lines.map((line) => line.itemId))];
  const items = ids.length ? db.prepare(`SELECT * FROM inventory_items WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) : [];
  if (items.length !== ids.length || items.some((item) => !item.active)) throw appError(422, "One or more inventory items are unavailable.");
  return new Map(items.map((item) => [item.id, item]));
}

function validateSupplierItems(supplierId, lines) {
  const expectedItems = db.prepare("SELECT item_id FROM supplier_items WHERE supplier_id = ?").all(supplierId);
  if (!expectedItems.length) return;
  const expectedIds = new Set(expectedItems.map((item) => item.item_id));
  if (lines.some((line) => !expectedIds.has(line.itemId))) {
    throw appError(422, "One or more line items are not listed in this supplier's expected inventory catalog.");
  }
}

function invoiceLines(invoiceId) {
  return db.prepare(`
    SELECT lines.*, items.sku, items.name AS itemName, items.unit
    FROM supplier_invoice_lines lines JOIN inventory_items items ON items.id = lines.item_id
    WHERE lines.invoice_id = ? ORDER BY items.sku
  `).all(invoiceId);
}

function journalPair(debitCode, creditCode, total) {
  return [
    { accountId: accountId(debitCode), debit: total, credit: 0 },
    { accountId: accountId(creditCode), debit: 0, credit: total },
  ];
}

app.disable("x-powered-by");
app.use(helmet());
const origins = (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174")
  .split(",").map((value) => value.trim()).filter(Boolean);
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || origins.includes(origin)) return callback(null, true);
    return callback(appError(403, "This origin is not allowed."));
  },
}));
app.use(express.json({ limit: "3mb" }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: "draft-7", legacyHeaders: false }));
app.get("/api/health", (req, res) => res.json({ status: "ok", database: "sqlite" }));

app.post("/api/auth/login", rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: "draft-7" }), (req, res) => {
  const input = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) }).parse(req.body);
  const user = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(input.email);
  const matches = verifyPassword(input.password, user?.password_hash, user?.password_salt);
  if (!user || !matches || !user.active) {
    audit(null, "login_failed", "user", user?.id ?? null, { email: input.email.toLowerCase() });
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  const result = createSession(user, res);
  audit(user.id, "login", "user", user.id);
  return res.json(result);
});

app.use("/api", authenticate, requireCsrf);
app.use("/api", (req, res, next) => {
  const allowedDuringPasswordRotation = ["/auth/me", "/auth/logout", "/auth/change-password"];
  if (req.user.force_password_change && !allowedDuringPasswordRotation.includes(req.path)) {
    return res.status(403).json({ error: "Change your temporary password before using the ERP." });
  }
  return next();
});
app.get("/api/auth/me", (req, res) => res.json({ user: serializeUser(req.user), csrfToken: req.session.csrfToken }));
app.post("/api/auth/logout", (req, res) => {
  destroySession(req, res);
  res.json({ message: "Signed out." });
});
app.post("/api/auth/change-password", (req, res) => {
  const input = z.object({
    currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12).max(200),
  }).parse(req.body);
  const currentUser = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!verifyPassword(input.currentPassword, currentUser.password_hash, currentUser.password_salt)) {
    throw appError(422, "Current password is incorrect.");
  }
  changeUserPassword(req.user.id, input.newPassword, false);
  audit(req.user.id, "change_password", "user", req.user.id);
  res.json({ message: "Password changed. Sign in again with your new password." });
});

app.get("/api/admin/users", requireMasterAdmin, (req, res) => {
  const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all().map(serializeUser);
  res.json({ users, modulePermissions });
});
app.post("/api/admin/users", requireMasterAdmin, (req, res) => {
  const input = z.object({
    email: z.string().trim().email().max(254), temporaryPassword: z.string().min(12).max(200),
  }).parse(req.body);
  const user = createUserRecord({
    email: input.email, password: input.temporaryPassword, permissions: { MM: ["view"] }, forcePasswordChange: true,
  });
  audit(req.user.id, "create", "user", user.id, { email: user.email });
  res.status(201).json({ user: serializeUser(user) });
});
app.patch("/api/admin/users/:id/permissions", requireMasterAdmin, (req, res) => {
  const id = idSchema.parse(req.params.id);
  const user = record(db.prepare("SELECT * FROM users WHERE id = ?"), [id], "User");
  if (user.master_admin) throw appError(422, "Master administrator permissions cannot be changed.");
  const schema = z.record(z.string(), z.array(z.string())).refine((value) => Object.entries(value).every(([module, actions]) => (
    Object.hasOwn(modulePermissions, module) && actions.every((action) => modulePermissions[module].includes(action))
  )), "Invalid permission.");
  const permissions = schema.parse(req.body.permissions);
  updateUserPermissions(id, permissions);
  audit(req.user.id, "update_permissions", "user", id);
  res.json({ user: serializeUser(record(db.prepare("SELECT * FROM users WHERE id = ?"), [id], "User")) });
});
app.patch("/api/admin/users/:id/active", requireMasterAdmin, (req, res) => {
  const id = idSchema.parse(req.params.id);
  const user = record(db.prepare("SELECT * FROM users WHERE id = ?"), [id], "User");
  if (user.master_admin) throw appError(422, "The master administrator cannot be disabled.");
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  setUserActive(id, active);
  if (!active) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  audit(req.user.id, active ? "activate" : "deactivate", "user", id);
  res.json({ user: serializeUser(record(db.prepare("SELECT * FROM users WHERE id = ?"), [id], "User")) });
});

app.get("/api/workspace", (req, res) => {
  const can = (module) => req.user.master_admin || req.user.permissions[module]?.includes("view");
  const categories = can("PM") ? db.prepare("SELECT id, name, created_at AS createdAt FROM jobcard_categories ORDER BY name").all() : [];
  const items = can("MM") || can("PM") || can("FM") || can("PRM") || can("AP")
    ? db.prepare("SELECT id, sku, name, unit, min_stock AS minStock, on_hand AS onHand, reserved, average_cost AS averageCost, active FROM inventory_items WHERE active = 1 ORDER BY sku").all() : [];
  const suppliers = can("PRM") || can("AP") ? db.prepare("SELECT id, code, name, address, contact_name AS contactName, email, phone, notes, active, created_at AS createdAt, updated_at AS updatedAt FROM suppliers ORDER BY name").all().map((supplier) => ({
    ...supplier,
    active: Boolean(supplier.active),
    itemIds: db.prepare("SELECT item_id FROM supplier_items WHERE supplier_id = ? ORDER BY item_id").all(supplier.id).map((row) => row.item_id),
  })) : [];
  const purchaseOrders = can("PRM") || can("FM") ? db.prepare("SELECT * FROM purchase_orders ORDER BY date DESC, created_at DESC").all() : [];
  const invoices = can("PRM") || can("FM") ? db.prepare("SELECT * FROM supplier_invoices ORDER BY date DESC, created_at DESC").all() : [];
  for (const order of purchaseOrders) {
    order.supplierId = order.supplier_id;
    order.lines = db.prepare("SELECT id, item_id AS itemId, quantity, unit_cost AS unitCost, total, received_quantity AS receivedQuantity FROM purchase_order_lines WHERE order_id = ?").all(order.id);
  }
  for (const invoice of invoices) {
    invoice.lines = invoiceLines(invoice.id).map((line) => ({
      id: line.id, itemId: line.item_id, quantity: line.quantity, unitCost: line.unit_cost, total: line.total,
    }));
    invoice.orderId = invoice.order_id;
    invoice.dueDate = invoice.due_date;
  }
  const jobcards = can("PM") ? db.prepare(`
    SELECT jobs.*, categories.name AS categoryName FROM jobcards jobs
    JOIN jobcard_categories categories ON categories.id = jobs.category_id ORDER BY jobs.created_at DESC
  `).all().map((job) => ({
    ...job,
    categoryId: job.category_id,
    materials: db.prepare("SELECT id, item_id AS itemId, quantity, reserved_at AS reservedAt FROM jobcard_materials WHERE jobcard_id = ?").all(job.id),
  })) : [];
  const movements = can("MM") || can("FM") ? db.prepare("SELECT * FROM stock_movements ORDER BY date DESC, created_at DESC LIMIT 5000").all().map((move) => ({
    ...move, itemId: move.item_id, invoiceId: move.invoice_id, jobcardId: move.jobcard_id, stocktakeId: move.stocktake_id,
  })) : [];
  res.json({ categories, items, suppliers, purchaseOrders, invoices, jobcards, movements, user: serializeUser(req.user) });
});

app.post("/api/items", requirePermission("MM", "create"), (req, res) => {
  const input = itemSchema.parse(req.body);
  const item = { id: newId(), sku: input.sku.toUpperCase(), name: input.name, unit: input.unit, min_stock: input.minStock };
  db.prepare("INSERT INTO inventory_items (id, sku, name, unit, min_stock) VALUES (@id, @sku, @name, @unit, @min_stock)").run(item);
  audit(req.user.id, "create", "inventory_item", item.id, { sku: item.sku });
  res.status(201).json({ ...item, minStock: item.min_stock, onHand: 0, reserved: 0, averageCost: 0 });
});
app.post("/api/suppliers", requirePermission("AP", "create"), (req, res) => {
  const input = supplierSchema.parse(req.body);
  const items = validateItems(input.itemIds.map((itemId) => ({ itemId })));
  if (items.size !== input.itemIds.length) throw appError(422, "Select each expected inventory item only once.");
  const id = newId();
  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO suppliers (id, code, name, address, contact_name, email, phone, notes, active, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.code, input.name, input.address, input.contactName, input.email, input.phone, input.notes, Number(input.active), req.user.id);
    const insertItem = db.prepare("INSERT INTO supplier_items (supplier_id, item_id) VALUES (?, ?)");
    input.itemIds.forEach((itemId) => insertItem.run(id, itemId));
    audit(req.user.id, "create", "supplier", id, { code: input.code, expectedItemCount: input.itemIds.length });
  });
  save();
  res.status(201).json({ id, ...input });
});
app.put("/api/suppliers/:id", requirePermission("AP", "edit"), (req, res) => {
  const id = idSchema.parse(req.params.id);
  record(db.prepare("SELECT id FROM suppliers WHERE id = ?"), [id], "Supplier");
  const input = supplierSchema.parse(req.body);
  const items = validateItems(input.itemIds.map((itemId) => ({ itemId })));
  if (items.size !== input.itemIds.length) throw appError(422, "Select each expected inventory item only once.");
  const save = db.transaction(() => {
    db.prepare(`
      UPDATE suppliers SET code = ?, name = ?, address = ?, contact_name = ?, email = ?,
        phone = ?, notes = ?, active = ?, updated_at = datetime('now') WHERE id = ?
    `).run(input.code, input.name, input.address, input.contactName, input.email, input.phone, input.notes, Number(input.active), id);
    db.prepare("DELETE FROM supplier_items WHERE supplier_id = ?").run(id);
    const insertItem = db.prepare("INSERT INTO supplier_items (supplier_id, item_id) VALUES (?, ?)");
    input.itemIds.forEach((itemId) => insertItem.run(id, itemId));
    audit(req.user.id, "update", "supplier", id, { code: input.code, expectedItemCount: input.itemIds.length, active: input.active });
  });
  save();
  res.json({ id, ...input });
});
app.get("/api/items/:id/details", requirePermission("MM", "view"), (req, res) => {
  const itemId = idSchema.parse(req.params.id);
  record(db.prepare("SELECT id FROM inventory_items WHERE id = ?"), [itemId], "Inventory item");
  const details = db.prepare(`
    SELECT supplier_code AS supplierCode, notes, image_mime_type AS imageMimeType,
      image_filename AS imageFilename, image_data IS NOT NULL AS hasImage, updated_at AS updatedAt
    FROM inventory_item_details WHERE item_id = ?
  `).get(itemId);
  res.json(details ?? { supplierCode: "", notes: "", imageMimeType: null, imageFilename: null, hasImage: false, updatedAt: null });
});
app.get("/api/items/:id/image", requirePermission("MM", "view"), (req, res) => {
  const itemId = idSchema.parse(req.params.id);
  const image = db.prepare("SELECT image_data, image_mime_type, image_filename FROM inventory_item_details WHERE item_id = ?").get(itemId);
  if (!image?.image_data) throw appError(404, "This inventory item has no picture.");
  const filename = image.image_filename.replace(/[\r\n"]/g, "_");
  res.type(image.image_mime_type)
    .set("X-Content-Type-Options", "nosniff")
    .set("Content-Disposition", `inline; filename="${filename}"`)
    .set("Cache-Control", "private, no-cache, must-revalidate")
    .send(image.image_data);
});
app.put("/api/items/:id/details", requirePermission("MM", "edit"), (req, res) => {
  const itemId = idSchema.parse(req.params.id);
  record(db.prepare("SELECT id FROM inventory_items WHERE id = ?"), [itemId], "Inventory item");
  const input = itemDetailsSchema.parse(req.body);
  let imageBuffer = null;
  if (input.imageData) {
    const encoded = input.imageData.replace(/^data:image\/(?:jpeg|png|webp);base64,/, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw appError(422, "The selected picture is not valid base64 image data.");
    }
    imageBuffer = Buffer.from(encoded, "base64");
    if (imageBuffer.length === 0 || imageBuffer.length > 2 * 1024 * 1024) {
      throw appError(422, "Pictures must be smaller than 2 MB.");
    }
    const validSignature = input.imageMimeType === "image/jpeg"
      ? imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 && imageBuffer[2] === 0xff
      : input.imageMimeType === "image/png"
        ? imageBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : input.imageMimeType === "image/webp"
          ? imageBuffer.toString("ascii", 0, 4) === "RIFF" && imageBuffer.toString("ascii", 8, 12) === "WEBP"
          : false;
    if (!validSignature) throw appError(422, "The picture contents do not match its file type.");
  }
  db.prepare(`
    INSERT INTO inventory_item_details
      (item_id, supplier_code, notes, image_data, image_mime_type, image_filename, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET
      supplier_code = excluded.supplier_code,
      notes = excluded.notes,
      image_data = CASE
        WHEN ? THEN NULL
        WHEN excluded.image_data IS NOT NULL THEN excluded.image_data
        ELSE inventory_item_details.image_data END,
      image_mime_type = CASE
        WHEN ? THEN NULL
        WHEN excluded.image_mime_type IS NOT NULL THEN excluded.image_mime_type
        ELSE inventory_item_details.image_mime_type END,
      image_filename = CASE
        WHEN ? THEN NULL
        WHEN excluded.image_filename IS NOT NULL THEN excluded.image_filename
        ELSE inventory_item_details.image_filename END,
      updated_by = excluded.updated_by, updated_at = datetime('now')
  `).run(
    itemId, input.supplierCode, input.notes, imageBuffer,
    imageBuffer ? input.imageMimeType : null, imageBuffer ? input.imageFilename : null,
    req.user.id, Number(input.removeImage), Number(input.removeImage), Number(input.removeImage),
  );
  audit(req.user.id, "update", "inventory_item_details", itemId, {
    supplierCodeUpdated: true, imageChanged: Boolean(imageBuffer || input.removeImage),
  });
  const details = db.prepare(`
    SELECT supplier_code AS supplierCode, notes, image_mime_type AS imageMimeType,
      image_filename AS imageFilename, image_data IS NOT NULL AS hasImage, updated_at AS updatedAt
    FROM inventory_item_details WHERE item_id = ?
  `).get(itemId);
  res.json(details);
});
app.post("/api/categories", requirePermission("PM", "create"), (req, res) => {
  const { name } = categorySchema.parse(req.body);
  const category = { id: newId(), name };
  db.prepare("INSERT INTO jobcard_categories (id, name) VALUES (?, ?)").run(category.id, name);
  audit(req.user.id, "create", "jobcard_category", category.id);
  res.status(201).json(category);
});
app.post("/api/purchase-orders", requirePermission("PRM", "create"), (req, res) => {
  const input = purchaseSchema.parse(req.body);
  const supplier = record(db.prepare("SELECT * FROM suppliers WHERE id = ? AND active = 1"), [input.supplierId], "Active supplier");
  validateItems(input.lines);
  validateSupplierItems(supplier.id, input.lines);
  const id = newId();
  const total = amountOf(input.lines);
  const save = db.transaction(() => {
    db.prepare("INSERT INTO purchase_orders (id, reference, supplier, supplier_id, date, total, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.reference, supplier.name, supplier.id, input.date, total, req.user.id);
    const insert = db.prepare("INSERT INTO purchase_order_lines (id, order_id, item_id, quantity, unit_cost, total) VALUES (?, ?, ?, ?, ?, ?)");
    input.lines.forEach((line) => insert.run(newId(), id, line.itemId, line.quantity, line.unitCost, line.quantity * line.unitCost));
    audit(req.user.id, "create", "purchase_order", id, { reference: input.reference, supplierId: supplier.id, total });
  });
  save();
  res.status(201).json({ id, reference: input.reference, supplierId: supplier.id, supplier: supplier.name, date: input.date, lines: input.lines, total, status: "Open" });
});
app.post("/api/invoices", requirePermission("PRM", "create"), (req, res) => {
  const input = invoiceSchema.parse(req.body);
  const supplier = record(db.prepare("SELECT * FROM suppliers WHERE id = ? AND active = 1"), [input.supplierId], "Active supplier");
  validateItems(input.lines);
  validateSupplierItems(supplier.id, input.lines);
  const id = newId();
  const total = amountOf(input.lines);
  const save = db.transaction(() => {
    if (input.orderId) {
      const order = record(db.prepare("SELECT * FROM purchase_orders WHERE id = ?"), [input.orderId], "Purchase order");
      const matchesSupplier = order.supplier_id
        ? order.supplier_id === supplier.id
        : order.supplier.trim().toLowerCase() === supplier.name.trim().toLowerCase();
      if (!matchesSupplier) throw appError(422, "Supplier must match the linked purchase order.");
      const ordered = db.prepare("SELECT item_id, SUM(quantity - received_quantity) AS remaining FROM purchase_order_lines WHERE order_id = ? GROUP BY item_id").all(order.id);
      const remainingByItem = new Map(ordered.map((line) => [line.item_id, line.remaining]));
      for (const line of input.lines) {
        const remaining = remainingByItem.get(line.itemId) ?? 0;
        if (line.quantity > remaining + 0.00001) throw appError(422, "Invoice quantity exceeds linked order quantity.");
        remainingByItem.set(line.itemId, remaining - line.quantity);
      }
      const updateOrderLines = db.prepare("SELECT * FROM purchase_order_lines WHERE order_id = ? AND item_id = ? ORDER BY id");
      for (const itemId of new Set(input.lines.map((line) => line.itemId))) {
        let toAllocate = input.lines.filter((line) => line.itemId === itemId).reduce((sum, line) => sum + line.quantity, 0);
        for (const orderLine of updateOrderLines.all(order.id, itemId)) {
          const allocation = Math.min(orderLine.quantity - orderLine.received_quantity, toAllocate);
          if (allocation > 0) db.prepare("UPDATE purchase_order_lines SET received_quantity = ? WHERE id = ?").run(orderLine.received_quantity + allocation, orderLine.id);
          toAllocate -= allocation;
          if (toAllocate <= 0.00001) break;
        }
      }
      const totalLines = db.prepare("SELECT COUNT(*) AS count FROM purchase_order_lines WHERE order_id = ?").get(order.id).count;
      const receivedLines = db.prepare("SELECT COUNT(*) AS count FROM purchase_order_lines WHERE order_id = ? AND received_quantity >= quantity - 0.00001").get(order.id).count;
      const hasReceived = db.prepare("SELECT COUNT(*) AS count FROM purchase_order_lines WHERE order_id = ? AND received_quantity > 0").get(order.id).count;
      db.prepare("UPDATE purchase_orders SET status = ? WHERE id = ?")
        .run(receivedLines === totalLines ? "Received" : hasReceived ? "Partially received" : "Open", order.id);
    }
    db.prepare(`INSERT INTO supplier_invoices
      (id, reference, supplier, supplier_id, date, due_date, order_id, total, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.reference, supplier.name, supplier.id, input.date, input.dueDate ?? null, input.orderId ?? null, total, req.user.id);
    const addLine = db.prepare("INSERT INTO supplier_invoice_lines (id, invoice_id, item_id, quantity, unit_cost, total) VALUES (?, ?, ?, ?, ?, ?)");
    const move = db.prepare("INSERT INTO stock_movements (id, item_id, quantity, type, date, reference, invoice_id) VALUES (?, ?, ?, 'Receipt', ?, ?, ?)");
    const update = db.prepare(`UPDATE inventory_items SET average_cost =
      CASE WHEN on_hand + ? > 0 THEN ((on_hand * average_cost) + (? * ?)) / (on_hand + ?) ELSE ? END,
      on_hand = on_hand + ?, updated_at = datetime('now') WHERE id = ?`);
    const journalLines = [];
    for (const line of input.lines) {
      const lineTotal = line.quantity * line.unitCost;
      addLine.run(newId(), id, line.itemId, line.quantity, line.unitCost, lineTotal);
      move.run(newId(), line.itemId, line.quantity, input.date, input.reference, id);
      update.run(line.quantity, line.quantity, line.unitCost, line.quantity, line.unitCost, line.quantity, line.itemId);
      if (lineTotal > 0) journalLines.push({ accountId: accountId("1200"), debit: lineTotal, credit: 0 });
    }
    if (total > 0) {
      journalLines.push({ accountId: accountId("2000"), debit: 0, credit: total });
      postJournal({ reference: input.reference, date: input.date, description: `Supplier invoice ${input.reference}`,
        sourceType: "supplier_invoice", sourceId: id, userId: req.user.id, lines: journalLines });
    }
    audit(req.user.id, "post", "supplier_invoice", id, { reference: input.reference, total });
  });
  save();
  res.status(201).json({ id, reference: input.reference, supplierId: supplier.id, supplier: supplier.name, date: input.date, dueDate: input.dueDate ?? null, orderId: input.orderId ?? null, total, status: "Posted" });
});

app.post("/api/jobcards", requirePermission("PM", "create"), (req, res) => {
  const input = z.object({
    reference: z.string().trim().min(1).max(60), title: z.string().trim().min(1).max(100),
    customer: z.string().trim().max(100).default(""), categoryId: idSchema, date: dateSchema,
  }).parse(req.body);
  record(db.prepare("SELECT id FROM jobcard_categories WHERE id = ?"), [input.categoryId], "Category");
  const id = newId();
  db.prepare("INSERT INTO jobcards (id, reference, title, customer, category_id, date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.reference, input.title, input.customer, input.categoryId, input.date, req.user.id);
  audit(req.user.id, "create", "jobcard", id, { reference: input.reference });
  res.status(201).json({ id, ...input, status: "Open", materials: [] });
});
app.post("/api/jobcards/:id/materials", requirePermission("PM", "edit"), (req, res) => {
  const jobId = idSchema.parse(req.params.id);
  const input = z.object({ itemId: idSchema, quantity: z.number().finite().positive() }).parse(req.body);
  const job = record(db.prepare("SELECT * FROM jobcards WHERE id = ?"), [jobId], "Jobcard");
  if (job.status === "Completed") throw appError(422, "Completed jobcards cannot reserve more stock.");
  const item = record(db.prepare("SELECT * FROM inventory_items WHERE id = ? AND active = 1"), [input.itemId], "Inventory item");
  if (item.on_hand - item.reserved < input.quantity - 0.00001) throw appError(422, "Insufficient available stock.");
  const materialId = newId();
  const save = db.transaction(() => {
    db.prepare("INSERT INTO jobcard_materials (id, jobcard_id, item_id, quantity) VALUES (?, ?, ?, ?)").run(materialId, jobId, input.itemId, input.quantity);
    db.prepare("UPDATE inventory_items SET reserved = reserved + ? WHERE id = ?").run(input.quantity, input.itemId);
    db.prepare("UPDATE jobcards SET status = 'In progress' WHERE id = ? AND status = 'Open'").run(jobId);
  });
  save();
  res.status(201).json({ id: materialId, jobcardId: jobId, ...input });
});
app.delete("/api/jobcards/:id/materials/:materialId", requirePermission("PM", "edit"), (req, res) => {
  const jobId = idSchema.parse(req.params.id);
  const materialId = idSchema.parse(req.params.materialId);
  const material = record(db.prepare("SELECT * FROM jobcard_materials WHERE id = ? AND jobcard_id = ?"), [materialId, jobId], "Reserved material");
  const job = record(db.prepare("SELECT * FROM jobcards WHERE id = ?"), [jobId], "Jobcard");
  if (job.status === "Completed") throw appError(422, "Completed jobcard material cannot be changed.");
  const save = db.transaction(() => {
    db.prepare("UPDATE inventory_items SET reserved = reserved - ? WHERE id = ?").run(material.quantity, material.item_id);
    db.prepare("DELETE FROM jobcard_materials WHERE id = ?").run(materialId);
  });
  save();
  res.json({ removed: true });
});
app.patch("/api/jobcards/:id/status", requirePermission("PM", "edit"), (req, res) => {
  const id = idSchema.parse(req.params.id);
  const { status } = z.object({ status: z.enum(["Open", "In progress", "Completed"]) }).parse(req.body);
  const job = record(db.prepare("SELECT * FROM jobcards WHERE id = ?"), [id], "Jobcard");
  if (job.status === "Completed" && status !== "Completed") throw appError(422, "Completed jobcards cannot be reopened.");
  if (status !== "Completed") {
    db.prepare("UPDATE jobcards SET status = ? WHERE id = ?").run(status, id);
    return res.json({ id, status });
  }
  if (job.status !== "Completed") {
    const materials = db.prepare(`
      SELECT materials.*, items.average_cost FROM jobcard_materials materials
      JOIN inventory_items items ON items.id = materials.item_id WHERE materials.jobcard_id = ?
    `).all(id);
    const save = db.transaction(() => {
      for (const material of materials) {
        db.prepare("UPDATE inventory_items SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = datetime('now') WHERE id = ?")
          .run(material.quantity, material.quantity, material.item_id);
        db.prepare(`INSERT INTO stock_movements
          (id, item_id, quantity, type, date, reference, jobcard_id)
          VALUES (?, ?, ?, 'Jobcard issue', ?, ?, ?)`)
          .run(newId(), material.item_id, -material.quantity, new Date().toISOString().slice(0, 10), job.reference, id);
      }
      const value = materials.reduce((sum, material) => sum + material.quantity * material.average_cost, 0);
      if (value > 0) postJournal({ reference: job.reference, date: new Date().toISOString().slice(0, 10),
        description: `Materials issued to jobcard ${job.reference}`, sourceType: "jobcard_close", sourceId: id,
        userId: req.user.id, lines: journalPair("5000", "1200", value) });
      db.prepare("UPDATE jobcards SET status = 'Completed', closed_at = datetime('now') WHERE id = ?").run(id);
    });
    save();
  }
  res.json({ id, status: "Completed" });
});

app.get("/api/items/:id/report", requirePermission("MM", "reports"), (req, res) => {
  const itemId = idSchema.parse(req.params.id);
  const year = z.coerce.number().int().min(2000).max(2200).parse(req.query.year);
  const { start, end } = yearRange(year);
  const item = record(db.prepare("SELECT * FROM inventory_items WHERE id = ?"), [itemId], "Inventory item");
  const movements = db.prepare(`
    SELECT movement.*, invoice.reference AS invoice_reference, job.reference AS jobcard_reference
    FROM stock_movements movement
    LEFT JOIN supplier_invoices invoice ON invoice.id = movement.invoice_id
    LEFT JOIN jobcards job ON job.id = movement.jobcard_id
    WHERE movement.item_id = ? AND movement.date >= ? AND movement.date < ?
    ORDER BY movement.date, movement.created_at
  `).all(itemId, start, end).map((move) => ({
    id: move.id, date: move.date, quantity: move.quantity, type: move.type, reference: move.reference,
    invoice: move.invoice_id ? { id: move.invoice_id, reference: move.invoice_reference } : null,
    jobcard: move.jobcard_id ? { id: move.jobcard_id, reference: move.jobcard_reference } : null,
  }));
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = new Date(Date.UTC(year, 2 + index, 1)).toISOString().slice(0, 7);
    const selected = movements.filter((move) => move.date.startsWith(month));
    return {
      month,
      broughtIn: selected.filter((move) => move.type === "Receipt").reduce((sum, move) => sum + move.quantity, 0),
      takenOut: selected.filter((move) => move.type === "Jobcard issue").reduce((sum, move) => sum + Math.abs(move.quantity), 0),
      adjustment: selected.filter((move) => move.type === "Stock adjustment").reduce((sum, move) => sum + move.quantity, 0),
    };
  });
  res.json({ year, item: { id: item.id, sku: item.sku, name: item.name, unit: item.unit }, months, movements });
});

function requireFinanceOverview(req, res) {
  const year = z.coerce.number().int().min(2000).max(2200).parse(req.query.year);
  const { start, end, lastDay } = yearRange(year);
  const accounts = db.prepare(`
    SELECT accounts.id, accounts.code, accounts.name, accounts.type,
      COALESCE(SUM(CASE WHEN entries.date < ? THEN lines.debit ELSE 0 END), 0) AS debits,
      COALESCE(SUM(CASE WHEN entries.date < ? THEN lines.credit ELSE 0 END), 0) AS credits
    FROM accounts LEFT JOIN journal_lines lines ON lines.account_id = accounts.id
    LEFT JOIN journal_entries entries ON entries.id = lines.entry_id
    GROUP BY accounts.id ORDER BY accounts.code
  `).all(end, end).map((account) => ({
    ...account,
    balance: ["Asset", "Expense"].includes(account.type)
      ? account.debits - account.credits : account.credits - account.debits,
  }));
  const accountTotals = Object.fromEntries(accounts.map((account) => [account.code, account.balance]));
  const profitAndLossTotals = db.prepare(`
    SELECT accounts.type,
      SUM(CASE WHEN accounts.type = 'Income' THEN lines.credit - lines.debit ELSE lines.debit - lines.credit END) AS amount
    FROM journal_entries entries JOIN journal_lines lines ON lines.entry_id = entries.id
    JOIN accounts ON accounts.id = lines.account_id
    WHERE entries.date >= ? AND entries.date < ? AND accounts.type IN ('Income', 'Expense')
    GROUP BY accounts.type
  `).all(start, end);
  const income = profitAndLossTotals.find((row) => row.type === "Income")?.amount ?? 0;
  const expenses = profitAndLossTotals.find((row) => row.type === "Expense")?.amount ?? 0;
  const netProfit = income - expenses;
  const inventoryValue = db.prepare("SELECT COALESCE(SUM(on_hand * average_cost), 0) AS value, COUNT(*) AS items FROM inventory_items WHERE active = 1").get();
  const creditors = db.prepare("SELECT COALESCE(SUM(total - paid_amount), 0) AS outstanding, COUNT(*) AS count FROM supplier_invoices WHERE status != 'Paid'").get();
  const debtors = db.prepare("SELECT COALESCE(SUM(total - paid_amount), 0) AS outstanding, COUNT(*) AS count FROM sales_invoices WHERE status != 'Paid'").get();
  const monthly = Array.from({ length: 12 }, (_, index) => {
    const month = new Date(Date.UTC(year, 2 + index, 1)).toISOString().slice(0, 7);
    const rows = db.prepare(`
      SELECT accounts.type,
        SUM(CASE WHEN accounts.type = 'Income' THEN lines.credit - lines.debit ELSE lines.debit - lines.credit END) AS amount
      FROM journal_entries entries JOIN journal_lines lines ON lines.entry_id = entries.id
      JOIN accounts ON accounts.id = lines.account_id
      WHERE substr(entries.date, 1, 7) = ? AND accounts.type IN ('Income', 'Expense')
      GROUP BY accounts.type
    `).all(month);
    const incomeValue = rows.find((row) => row.type === "Income")?.amount ?? 0;
    const expenseValue = rows.find((row) => row.type === "Expense")?.amount ?? 0;
    return { month, income: incomeValue, expenses: expenseValue, profit: incomeValue - expenseValue };
  });
  const journalEntries = db.prepare(`
    SELECT entries.*, users.email AS posted_by_email FROM journal_entries entries
    LEFT JOIN users ON users.id = entries.posted_by WHERE entries.date >= ? AND entries.date < ?
    ORDER BY entries.date DESC, entries.created_at DESC LIMIT 200
  `).all(start, end).map((entry) => ({
    ...entry,
    lines: db.prepare(`
      SELECT accounts.id AS accountId, accounts.code, accounts.name, accounts.type, lines.debit, lines.credit
      FROM journal_lines lines JOIN accounts ON accounts.id = lines.account_id
      WHERE lines.entry_id = ? ORDER BY accounts.code
    `).all(entry.id),
  }));
  const assets = (accountTotals["1000"] ?? 0) + (accountTotals["1100"] ?? 0) + inventoryValue.value;
  const liabilities = accountTotals["2000"] ?? 0;
  const equity = (accountTotals["3000"] ?? 0) + netProfit;
  const report = {
    year,
    financialYear: { start, end: lastDay },
    profitAndLoss: { income, expenses, netProfit },
    balanceSheet: { assets, liabilities, equity },
    creditors: { ...creditors },
    debtors: { ...debtors },
    inventory: { value: inventoryValue.value, items: inventoryValue.items },
    accounts, monthly, journalEntries,
  };
  res.json(report);
}
app.get("/api/finance/overview", requirePermission("FM", "view"), requireFinanceOverview);
app.get("/api/finance/reporting", requirePermission("FM", "reports"), requireFinanceOverview);

app.get("/api/finance/ledger", requirePermission("FM", "view"), (req, res) => {
  const year = z.coerce.number().int().min(2000).max(2200).parse(req.query.year);
  const page = z.coerce.number().int().min(1).default(1).parse(req.query.page ?? 1);
  const account = req.query.accountId === "all" ? null : idSchema.parse(req.query.accountId);
  const { start, end } = yearRange(year);
  const params = account ? [start, end, account] : [start, end];
  const filter = account ? "AND lines.account_id = ?" : "";
  const total = db.prepare(`
    SELECT COUNT(DISTINCT entries.id) AS count FROM journal_entries entries
    JOIN journal_lines lines ON lines.entry_id = entries.id
    WHERE entries.date >= ? AND entries.date < ? ${filter}
  `).get(...params).count;
  const entries = db.prepare(`
    SELECT DISTINCT entries.*, users.email AS posted_by_email FROM journal_entries entries
    JOIN journal_lines lines ON lines.entry_id = entries.id LEFT JOIN users ON users.id = entries.posted_by
    WHERE entries.date >= ? AND entries.date < ? ${filter}
    ORDER BY entries.date DESC, entries.created_at DESC LIMIT 50 OFFSET ?
  `).all(...params, (page - 1) * 50).map((entry) => ({
    ...entry,
    lines: db.prepare(`
      SELECT accounts.id AS accountId, accounts.code, accounts.name, accounts.type, lines.debit, lines.credit
      FROM journal_lines lines JOIN accounts ON accounts.id = lines.account_id WHERE lines.entry_id = ?
      ORDER BY accounts.code
    `).all(entry.id),
  }));
  res.json({ year, page, pages: Math.ceil(total / 50), total, entries });
});

app.get("/api/finance/budgets", requirePermission("FM", "view"), (req, res) => {
  const year = z.coerce.number().int().min(2000).max(2200).parse(req.query.year);
  const { start, end } = yearRange(year);
  const accounts = db.prepare("SELECT id, code, name, type FROM accounts WHERE active = 1 AND type IN ('Income', 'Expense') ORDER BY code").all();
  const budgets = db.prepare(`
    SELECT budgets.id, budgets.account_id AS accountId, accounts.code, accounts.name,
      accounts.type, budgets.month, budgets.amount FROM budgets
    JOIN accounts ON accounts.id = budgets.account_id WHERE budgets.month >= ? AND budgets.month < ?
    ORDER BY accounts.code, budgets.month
  `).all(start, end);
  const actuals = db.prepare(`
    SELECT lines.account_id AS accountId, substr(entries.date, 1, 7) AS month,
      SUM(CASE WHEN accounts.type = 'Income' THEN lines.credit - lines.debit ELSE lines.debit - lines.credit END) AS actual
    FROM journal_entries entries JOIN journal_lines lines ON lines.entry_id = entries.id
    JOIN accounts ON accounts.id = lines.account_id WHERE entries.date >= ? AND entries.date < ?
      AND accounts.type IN ('Income', 'Expense') GROUP BY lines.account_id, substr(entries.date, 1, 7)
  `).all(start, end);
  res.json({ year, accounts, budgets, actuals });
});
app.put("/api/finance/budgets", requirePermission("FM", "edit"), (req, res) => {
  const input = budgetsSchema.parse(req.body);
  const valid = new Set(db.prepare("SELECT id FROM accounts WHERE active = 1 AND type IN ('Income', 'Expense')").all().map((row) => row.id));
  if (input.lines.some((line) => !valid.has(line.accountId))) throw appError(422, "Budgets require active income or expense accounts.");
  const save = db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO budgets (id, account_id, month, amount, created_by)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, month) DO UPDATE SET
      amount = excluded.amount, created_by = excluded.created_by, updated_at = datetime('now')
    `);
    input.lines.forEach((line) => insert.run(newId(), line.accountId, line.month, line.amount, req.user.id));
    audit(req.user.id, "update", "budget", String(input.year), { lineCount: input.lines.length });
  });
  save();
  res.json({ year: input.year, saved: input.lines.length });
});

app.get("/api/finance/creditors", requireAnyPermission(["FM", "AP"], "view"), (req, res) => {
  const invoices = db.prepare(`
    SELECT invoices.*, suppliers.code AS supplier_code, COALESCE(SUM(payments.amount), 0) AS recorded_payments FROM supplier_invoices invoices
    LEFT JOIN supplier_payments payments ON payments.invoice_id = invoices.id
    LEFT JOIN suppliers ON suppliers.id = invoices.supplier_id
    WHERE invoices.status != 'Paid' GROUP BY invoices.id ORDER BY invoices.due_date, invoices.date
  `).all();
  const payments = db.prepare(`
    SELECT payments.*, invoices.reference AS invoice_reference, invoices.supplier FROM supplier_payments payments
    JOIN supplier_invoices invoices ON invoices.id = payments.invoice_id ORDER BY payments.date DESC LIMIT 200
  `).all();
  const accountBalance = db.prepare(`
    SELECT COALESCE(SUM(lines.credit - lines.debit), 0) AS balance
    FROM journal_lines lines JOIN accounts ON accounts.id = lines.account_id
    WHERE accounts.code = '2000'
  `).get().balance;
  const invoiceBalance = invoices.reduce((sum, invoice) => sum + invoice.total - invoice.paid_amount, 0);
  res.json({
    invoices, payments, accountBalance, invoiceBalance,
    reconciled: Math.abs(accountBalance - invoiceBalance) < 0.01,
  });
});
app.get("/api/finance/debtors", requirePermission("FM", "view"), (req, res) => {
  const invoices = db.prepare(`
    SELECT sales.*, customers.name AS customer, customers.email AS customer_email FROM sales_invoices sales
    JOIN customers ON customers.id = sales.customer_id WHERE sales.status != 'Paid' ORDER BY sales.due_date, sales.date
  `).all();
  const receipts = db.prepare(`
    SELECT receipts.*, sales.reference AS invoice_reference, customers.name AS customer FROM customer_receipts receipts
    JOIN sales_invoices sales ON sales.id = receipts.invoice_id JOIN customers ON customers.id = sales.customer_id
    ORDER BY receipts.date DESC LIMIT 200
  `).all();
  res.json({ invoices, receipts });
});

function postInvoicePayment({ invoice, input, userId, customer }) {
  const balance = invoice.total - invoice.paid_amount;
  if (input.amount > balance + 0.00001) throw appError(422, "Payment exceeds the invoice's outstanding balance.");
  const id = newId();
  const table = customer ? "customer_receipts" : "supplier_payments";
  const sourceType = customer ? "customer_receipt" : "supplier_payment";
  const paid = invoice.paid_amount + input.amount;
  const status = paid >= invoice.total - 0.00001 ? "Paid" : "Partially paid";
  const save = db.transaction(() => {
    db.prepare(`INSERT INTO ${table} (id, invoice_id, date, amount, reference, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, invoice.id, input.date, input.amount, input.reference, userId);
    const invoiceTable = customer ? "sales_invoices" : "supplier_invoices";
    db.prepare(`UPDATE ${invoiceTable} SET paid_amount = ?, status = ? WHERE id = ?`).run(paid, status, invoice.id);
    postJournal({
      reference: input.reference, date: input.date,
      description: customer ? `Customer receipt ${input.reference}` : `Supplier payment ${input.reference}`,
      sourceType, sourceId: id, userId,
      lines: customer ? journalPair("1000", "1100", input.amount) : journalPair("2000", "1000", input.amount),
    });
    audit(userId, customer ? "receive" : "pay", sourceType, id, { amount: input.amount, reference: input.reference });
  });
  save();
  return { id, invoiceId: invoice.id, date: input.date, amount: input.amount, reference: input.reference, status };
}
app.post("/api/finance/creditors/:invoiceId/payments", requireAnyPermission(["FM", "AP"], "create"), (req, res) => {
  const id = idSchema.parse(req.params.invoiceId);
  const invoice = record(db.prepare("SELECT * FROM supplier_invoices WHERE id = ?"), [id], "Supplier invoice");
  res.status(201).json(postInvoicePayment({ invoice, input: paymentSchema.parse(req.body), userId: req.user.id, customer: false }));
});
app.post("/api/finance/debtors/:invoiceId/receipts", requirePermission("FM", "create"), (req, res) => {
  const id = idSchema.parse(req.params.invoiceId);
  const invoice = record(db.prepare("SELECT * FROM sales_invoices WHERE id = ?"), [id], "Sales invoice");
  res.status(201).json(postInvoicePayment({ invoice, input: paymentSchema.parse(req.body), userId: req.user.id, customer: true }));
});

app.get("/api/finance/stocktakes", requirePermission("FM", "view"), (req, res) => {
  const stocktakes = db.prepare("SELECT * FROM stocktakes ORDER BY date DESC, created_at DESC LIMIT 100").all().map((take) => ({
    ...take,
    lines: db.prepare(`
      SELECT lines.*, items.sku, items.name, items.unit FROM stocktake_lines lines
      JOIN inventory_items items ON items.id = lines.item_id WHERE lines.stocktake_id = ? ORDER BY items.sku
    `).all(take.id),
  }));
  const items = db.prepare("SELECT id, sku, name, unit, on_hand AS systemQuantity FROM inventory_items WHERE active = 1 ORDER BY sku").all();
  res.json({ stocktakes, items });
});
app.post("/api/finance/stocktakes", requirePermission("FM", "create"), (req, res) => {
  const input = stocktakeSchema.parse(req.body);
  const items = validateItems(input.lines.map((line) => ({ itemId: line.itemId })));
  const id = newId();
  const save = db.transaction(() => {
    db.prepare("INSERT INTO stocktakes (id, reference, date, created_by) VALUES (?, ?, ?, ?)").run(id, input.reference, input.date, req.user.id);
    const insertLine = db.prepare(`INSERT INTO stocktake_lines
      (id, stocktake_id, item_id, system_quantity, counted_quantity, variance, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const movement = db.prepare(`INSERT INTO stock_movements (id, item_id, quantity, type, date, reference, stocktake_id)
      VALUES (?, ?, ?, 'Stock adjustment', ?, ?, ?)`);
    let adjustmentValue = 0;
    for (const line of input.lines) {
      const item = items.get(line.itemId);
      if (line.countedQuantity < item.reserved - 0.00001) {
        throw appError(422, `Counted stock for ${item.sku} is below the quantity reserved for open jobcards.`);
      }
      const variance = line.countedQuantity - item.on_hand;
      insertLine.run(newId(), id, line.itemId, item.on_hand, line.countedQuantity, variance, item.average_cost);
      if (Math.abs(variance) < 0.00001) continue;
      db.prepare("UPDATE inventory_items SET on_hand = ?, reserved = MIN(reserved, ?), updated_at = datetime('now') WHERE id = ?")
        .run(line.countedQuantity, line.countedQuantity, line.itemId);
      movement.run(newId(), line.itemId, variance, input.date, input.reference, id);
      adjustmentValue += variance * item.average_cost;
    }
    if (Math.abs(adjustmentValue) > 0.00001) {
      postJournal({
        reference: input.reference, date: input.date, description: `Stock take ${input.reference}`,
        sourceType: "stocktake", sourceId: id, userId: req.user.id,
        lines: adjustmentValue > 0
          ? [{ accountId: accountId("1200"), debit: adjustmentValue, credit: 0 }, { accountId: accountId("5100"), debit: 0, credit: adjustmentValue }]
          : [{ accountId: accountId("5100"), debit: Math.abs(adjustmentValue), credit: 0 }, { accountId: accountId("1200"), debit: 0, credit: Math.abs(adjustmentValue) }],
      });
    }
    audit(req.user.id, "post", "stocktake", id, { reference: input.reference, adjustmentValue });
  });
  save();
  res.status(201).json({ id, reference: input.reference, date: input.date, status: "Posted" });
});

app.post("/api/sales/invoices", requirePermission("SM", "create"), (req, res) => {
  const input = salesInvoiceSchema.parse(req.body);
  const id = newId();
  const total = amountOf(input.lines.map((line) => ({ ...line, unitCost: line.unitPrice })));
  const save = db.transaction(() => {
    let customer = db.prepare("SELECT * FROM customers WHERE name = ? COLLATE NOCASE").get(input.customer);
    if (!customer) {
      customer = { id: newId(), name: input.customer, email: input.customerEmail };
      db.prepare("INSERT INTO customers (id, name, email) VALUES (?, ?, ?)").run(customer.id, customer.name, customer.email);
    } else if (input.customerEmail) {
      db.prepare("UPDATE customers SET email = ? WHERE id = ?").run(input.customerEmail, customer.id);
      customer.email = input.customerEmail;
    }
    db.prepare("INSERT INTO sales_invoices (id, reference, customer_id, date, due_date, total, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.reference, customer.id, input.date, input.dueDate ?? null, total, req.user.id);
    const addLine = db.prepare("INSERT INTO sales_invoice_lines (id, invoice_id, description, quantity, unit_price, total) VALUES (?, ?, ?, ?, ?, ?)");
    input.lines.forEach((line) => addLine.run(newId(), id, line.description, line.quantity, line.unitPrice, line.quantity * line.unitPrice));
    if (total > 0) postJournal({ reference: input.reference, date: input.date, description: `Sales invoice ${input.reference}`,
      sourceType: "sales_invoice", sourceId: id, userId: req.user.id, lines: journalPair("1100", "4000", total) });
    audit(req.user.id, "post", "sales_invoice", id, { reference: input.reference, total });
  });
  save();
  res.status(201).json({ id, reference: input.reference, customer: input.customer, date: input.date, dueDate: input.dueDate ?? null, total, paidAmount: 0, status: "Posted" });
});
app.get("/api/sales/invoices", requirePermission("SM", "view"), (req, res) => {
  const invoices = db.prepare(`
    SELECT sales.*, customers.name AS customer, customers.email AS customer_email
    FROM sales_invoices sales JOIN customers ON customers.id = sales.customer_id
    ORDER BY sales.date DESC, sales.created_at DESC LIMIT 500
  `).all().map((invoice) => ({
    ...invoice,
    lines: db.prepare("SELECT description, quantity, unit_price AS unitPrice, total FROM sales_invoice_lines WHERE invoice_id = ? ORDER BY rowid").all(invoice.id),
  }));
  res.json({ invoices });
});

function getInventoryReport(year) {
  const { start, end } = yearRange(year);
  const items = db.prepare(`
    SELECT id, sku, name, unit, on_hand AS onHand, reserved, min_stock AS minStock,
      average_cost * on_hand AS stockValue FROM inventory_items WHERE active = 1 ORDER BY sku
  `).all();
  const movements = db.prepare(`
    SELECT moves.*, items.sku, items.name AS itemName, items.unit,
      invoices.reference AS invoiceReference, jobs.reference AS jobcardReference
    FROM stock_movements moves JOIN inventory_items items ON items.id = moves.item_id
    LEFT JOIN supplier_invoices invoices ON invoices.id = moves.invoice_id
    LEFT JOIN jobcards jobs ON jobs.id = moves.jobcard_id
    WHERE moves.date >= ? AND moves.date < ? ORDER BY moves.date, moves.created_at
  `).all(start, end).map((move) => ({
    id: move.id, date: move.date, itemId: move.item_id, sku: move.sku, itemName: move.itemName,
    unit: move.unit, quantity: move.quantity, type: move.type, reference: move.reference,
    invoiceId: move.invoice_id, invoiceReference: move.invoiceReference,
    jobcardId: move.jobcard_id, jobcardReference: move.jobcardReference,
  }));
  const monthly = Array.from({ length: 12 }, (_, index) => {
    const month = new Date(Date.UTC(year, 2 + index, 1)).toISOString().slice(0, 7);
    const selected = movements.filter((move) => move.date.startsWith(month));
    return {
      month,
      broughtIn: selected.filter((move) => move.type === "Receipt").reduce((sum, move) => sum + move.quantity, 0),
      takenOut: selected.filter((move) => move.type === "Jobcard issue").reduce((sum, move) => sum + Math.abs(move.quantity), 0),
      adjustment: selected.filter((move) => move.type === "Stock adjustment").reduce((sum, move) => sum + move.quantity, 0),
    };
  });
  return {
    year, items, movements, monthly,
    totals: {
      itemCount: items.length,
      stockValue: items.reduce((sum, item) => sum + item.stockValue, 0),
      broughtIn: movements.filter((move) => move.type === "Receipt").reduce((sum, move) => sum + move.quantity, 0),
      takenOut: movements.filter((move) => move.type === "Jobcard issue").reduce((sum, move) => sum + Math.abs(move.quantity), 0),
      adjustment: movements.filter((move) => move.type === "Stock adjustment").reduce((sum, move) => sum + move.quantity, 0),
    },
  };
}
app.get("/api/reports/inventory", requirePermission("MM", "reports"), (req, res) => {
  const year = z.coerce.number().int().min(2000).max(2200).parse(req.query.year);
  res.json(getInventoryReport(year));
});
app.get("/api/reports/procurement", requirePermission("PRM", "reports"), (req, res) => {
  const year = z.coerce.number().int().min(2000).max(2200).parse(req.query.year);
  const { start, end } = yearRange(year);
  const invoices = db.prepare(`
    SELECT invoices.*, (SELECT COUNT(*) FROM supplier_invoice_lines WHERE invoice_id = invoices.id) AS line_count
    FROM supplier_invoices invoices WHERE date >= ? AND date < ? ORDER BY date, reference
  `).all(start, end);
  const orders = db.prepare(`
    SELECT orders.*, (SELECT COUNT(*) FROM purchase_order_lines WHERE order_id = orders.id) AS line_count
    FROM purchase_orders orders WHERE date >= ? AND date < ? ORDER BY date, reference
  `).all(start, end);
  const monthly = Array.from({ length: 12 }, (_, index) => {
    const month = new Date(Date.UTC(year, 2 + index, 1)).toISOString().slice(0, 7);
    const selected = invoices.filter((invoice) => invoice.date.startsWith(month));
    return { month, purchaseValue: selected.reduce((sum, invoice) => sum + invoice.total, 0), invoiceCount: selected.length };
  });
  res.json({
    year, invoices, orders, monthly,
    totals: {
      purchaseValue: invoices.reduce((sum, invoice) => sum + invoice.total, 0),
      invoiceCount: invoices.length, orderCount: orders.length,
      orderValue: orders.reduce((sum, order) => sum + order.total, 0),
    },
  });
});
app.get("/api/reports/sales", requirePermission("SM", "reports"), (req, res) => {
  const year = z.coerce.number().int().min(2000).max(2200).parse(req.query.year);
  const { start, end } = yearRange(year);
  const invoices = db.prepare(`
    SELECT sales.*, customers.name AS customer, customers.email AS customer_email
    FROM sales_invoices sales JOIN customers ON customers.id = sales.customer_id
    WHERE sales.date >= ? AND sales.date < ? ORDER BY sales.date, sales.reference
  `).all(start, end);
  const receipts = db.prepare(`
    SELECT receipts.*, sales.reference AS invoice_reference FROM customer_receipts receipts
    JOIN sales_invoices sales ON sales.id = receipts.invoice_id WHERE receipts.date >= ? AND receipts.date < ?
  `).all(start, end);
  const monthly = Array.from({ length: 12 }, (_, index) => {
    const month = new Date(Date.UTC(year, 2 + index, 1)).toISOString().slice(0, 7);
    const sales = invoices.filter((invoice) => invoice.date.startsWith(month));
    const received = receipts.filter((receipt) => receipt.date.startsWith(month));
    return {
      month, invoiced: sales.reduce((sum, invoice) => sum + invoice.total, 0),
      received: received.reduce((sum, receipt) => sum + receipt.amount, 0),
      outstanding: sales.reduce((sum, invoice) => sum + invoice.total - invoice.paid_amount, 0),
    };
  });
  const customerTotals = db.prepare(`
    SELECT customers.id, customers.name, SUM(sales.total) AS invoiced, SUM(sales.paid_amount) AS received,
      SUM(sales.total - sales.paid_amount) AS outstanding
    FROM sales_invoices sales JOIN customers ON customers.id = sales.customer_id
    WHERE sales.date >= ? AND sales.date < ? GROUP BY customers.id ORDER BY invoiced DESC
  `).all(start, end);
  res.json({
    year, invoices, monthly, customerTotals,
    totals: {
      invoiced: invoices.reduce((sum, invoice) => sum + invoice.total, 0),
      received: receipts.reduce((sum, receipt) => sum + receipt.amount, 0),
      outstanding: invoices.reduce((sum, invoice) => sum + invoice.total - invoice.paid_amount, 0),
      invoiceCount: invoices.length,
    },
  });
});
app.get("/api/reports/production", requirePermission("PM", "reports"), (req, res) => {
  const year = z.coerce.number().int().min(2000).max(2200).parse(req.query.year);
  const { start, end } = yearRange(year);
  const jobcards = db.prepare(`
    SELECT jobs.*, categories.name AS category FROM jobcards jobs
    JOIN jobcard_categories categories ON categories.id = jobs.category_id
    WHERE jobs.date >= ? AND jobs.date < ? ORDER BY jobs.date, jobs.reference
  `).all(start, end);
  const issues = db.prepare(`
    SELECT moves.*, items.sku, items.name AS itemName, items.unit, jobs.reference AS jobcardReference,
      categories.name AS category FROM stock_movements moves JOIN inventory_items items ON items.id = moves.item_id
    JOIN jobcards jobs ON jobs.id = moves.jobcard_id JOIN jobcard_categories categories ON categories.id = jobs.category_id
    WHERE moves.type = 'Jobcard issue' AND moves.date >= ? AND moves.date < ? ORDER BY moves.date, items.sku
  `).all(start, end);
  const categories = db.prepare(`
    SELECT categories.id, categories.name, COUNT(jobs.id) AS jobCount
    FROM jobcard_categories categories LEFT JOIN jobcards jobs ON jobs.category_id = categories.id
      AND jobs.date >= ? AND jobs.date < ? GROUP BY categories.id ORDER BY categories.name
  `).all(start, end);
  res.json({
    year, jobcards, issues, categories,
    totals: {
      jobCount: jobcards.length,
      completed: jobcards.filter((job) => job.status === "Completed").length,
      open: jobcards.filter((job) => job.status !== "Completed").length,
      unitsIssued: issues.reduce((sum, issue) => sum + Math.abs(issue.quantity), 0),
    },
  });
});

app.get("/api/documents/:type/:id/pdf", documentPermission("view"), withAsync(async (req, res) => {
  const doc = loadDocument(req.params.type, idSchema.parse(req.params.id));
  const pdf = await makePdf(doc);
  const filename = `${doc.type}-${doc.reference.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
  res.type("application/pdf").set("Content-Disposition", `inline; filename="${filename}"`).send(pdf);
}));
app.post("/api/documents/:type/:id/email", rateLimit({ windowMs: 60_000, limit: 10 }), documentPermission("create"), withAsync(async (req, res) => {
  const { to } = z.object({ to: z.string().trim().email().max(254) }).parse(req.body);
  const smtpHost = process.env.SMTP_HOST;
  const smtpFrom = z.string().email().safeParse(process.env.SMTP_FROM ?? "");
  const smtpPort = Number(process.env.SMTP_PORT ?? 587);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpFrom.success || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw appError(503, "Email is not set up yet. Configure Gmail SMTP in backend/.env and restart the backend.");
  }
  if (Boolean(smtpUser) !== Boolean(smtpPass)) throw appError(503, "Email authentication is incomplete. Configure both SMTP_USER and SMTP_PASS.");
  const doc = loadDocument(req.params.type, idSchema.parse(req.params.id));
  const pdf = await makePdf(doc);
  const filename = `${doc.type}-${doc.reference.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
  const transport = nodemailer.createTransport({
    host: smtpHost, port: smtpPort, secure: process.env.SMTP_SECURE === "true",
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    ...(smtpUser ? { auth: { user: smtpUser, pass: smtpPass } } : {}),
  });
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM, to, subject: `${doc.title}: ${doc.reference}`,
      text: `Attached is ${doc.title.toLowerCase()} ${doc.reference} for ${doc.party}.`,
      attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
    });
  } catch (error) {
    console.error("Document email delivery failed", { code: error.code, command: error.command });
    throw appError(502, "Email delivery failed. Check the email server settings and try again.");
  }
  audit(req.user.id, "email", doc.type.replaceAll("-", "_"), doc.id, { to, reference: doc.reference });
  res.status(202).json({ sent: true, to, reference: doc.reference });
}));

function documentPermission(action) {
  return (req, res, next) => {
    const type = z.enum(["purchase-order", "supplier-invoice", "sales-invoice"]).safeParse(req.params.type);
    if (!type.success) return next(appError(404, "Document type not found."));
    return requirePermission(type.data === "sales-invoice" ? "SM" : "PRM", action)(req, res, next);
  };
}

function loadDocument(type, id) {
  if (type === "purchase-order") {
    const order = record(db.prepare("SELECT * FROM purchase_orders WHERE id = ?"), [id], "Purchase order");
    const lines = db.prepare(`
      SELECT items.sku, items.name AS description, items.unit, lines.quantity, lines.unit_cost AS unitCost, lines.total
      FROM purchase_order_lines lines JOIN inventory_items items ON items.id = lines.item_id
      WHERE lines.order_id = ? ORDER BY items.sku
    `).all(id);
    return { id, type, title: "PURCHASE ORDER", reference: order.reference, party: order.supplier, partyLabel: "Supplier", date: order.date, dueDate: null, status: order.status, total: order.total, lines };
  }
  if (type === "supplier-invoice") {
    const invoice = record(db.prepare(`
      SELECT invoices.*, orders.reference AS order_reference FROM supplier_invoices invoices
      LEFT JOIN purchase_orders orders ON orders.id = invoices.order_id WHERE invoices.id = ?
    `), [id], "Supplier invoice");
    const lines = invoiceLines(id).map((line) => ({
      sku: line.sku, description: line.itemName, unit: line.unit, quantity: line.quantity,
      unitCost: line.unit_cost, total: line.total,
    }));
    return { id, type, title: "SUPPLIER INVOICE", reference: invoice.reference, party: invoice.supplier, partyLabel: "Supplier", date: invoice.date, dueDate: invoice.due_date, orderReference: invoice.order_reference, status: invoice.status, total: invoice.total, lines };
  }
  if (type === "sales-invoice") {
    const invoice = record(db.prepare(`
      SELECT sales.*, customers.name AS customer, customers.email AS customer_email FROM sales_invoices sales
      JOIN customers ON customers.id = sales.customer_id WHERE sales.id = ?
    `), [id], "Sales invoice");
    const lines = db.prepare("SELECT '' AS sku, description, '' AS unit, quantity, unit_price AS unitCost, total FROM sales_invoice_lines WHERE invoice_id = ? ORDER BY rowid").all(id);
    return { id, type, title: "SALES INVOICE", reference: invoice.reference, party: invoice.customer, partyLabel: "Customer", recipient: invoice.customer_email, date: invoice.date, dueDate: invoice.due_date, status: invoice.status, total: invoice.total, lines };
  }
  throw appError(404, "Document type not found.");
}

function makePdf(doc) {
  const pdf = new PDFDocument({ size: "A4", margin: 48, info: { Title: `${doc.title} ${doc.reference}` } });
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    pdf.on("data", (chunk) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  const right = pdf.page.width - 48;
  const drawHeader = () => {
    const y = pdf.y;
    pdf.font("Helvetica-Bold").fontSize(8).fillColor("#43515b");
    pdf.text("SKU", 48, y, { width: 52 });
    pdf.text("DESCRIPTION", 108, y, { width: 220 });
    pdf.text("QTY", 337, y, { width: 45, align: "right" });
    pdf.text("UNIT COST", 386, y, { width: 70, align: "right" });
    pdf.text("TOTAL", 461, y, { width: 86, align: "right" });
    pdf.moveTo(48, y + 15).lineTo(right, y + 15).strokeColor("#dce3e7").stroke();
    pdf.y = y + 22;
  };
  pdf.font("Helvetica-Bold").fontSize(10).fillColor("#387d69").text("MERCURIO ERP", 48, 48);
  pdf.font("Helvetica-Bold").fontSize(20).fillColor("#202a35").text(doc.title, 48, 72);
  pdf.font("Helvetica").fontSize(10).fillColor("#485560");
  pdf.text(`Reference: ${doc.reference}`, 48, 112);
  pdf.text(`${doc.partyLabel}: ${doc.party}`, 48, 129);
  pdf.text(`Date: ${doc.date}`, 48, 146);
  pdf.text(`Status: ${doc.status}`, 325, 112);
  if (doc.dueDate) pdf.text(`Due date: ${doc.dueDate}`, 325, 129);
  if (doc.orderReference) pdf.text(`Purchase order: ${doc.orderReference}`, 325, 146);
  pdf.y = 184;
  drawHeader();
  for (const line of doc.lines) {
    const rowHeight = Math.max(19, pdf.heightOfString(line.description, { width: 220, font: "Helvetica", fontSize: 8 }) + 7);
    if (pdf.y + rowHeight > pdf.page.height - 85) {
      pdf.addPage();
      pdf.y = 48;
      drawHeader();
    }
    const y = pdf.y;
    pdf.font("Helvetica").fontSize(8).fillColor("#485560");
    pdf.text(line.sku ?? "", 48, y, { width: 52 });
    pdf.text(line.description, 108, y, { width: 220 });
    pdf.text(String(line.quantity), 337, y, { width: 45, align: "right" });
    pdf.text(Number(line.unitCost).toFixed(2), 386, y, { width: 70, align: "right" });
    pdf.text(Number(line.total).toFixed(2), 461, y, { width: 86, align: "right" });
    pdf.moveTo(48, y + rowHeight - 2).lineTo(right, y + rowHeight - 2).strokeColor("#edf0f2").stroke();
    pdf.y = y + rowHeight;
  }
  if (pdf.y + 48 > pdf.page.height - 48) pdf.addPage();
  pdf.moveTo(350, pdf.y + 10).lineTo(right, pdf.y + 10).strokeColor("#cfd8dd").stroke();
  pdf.font("Helvetica-Bold").fontSize(10).fillColor("#202a35")
    .text(`TOTAL: ${Number(doc.total).toFixed(2)}`, 350, pdf.y + 18, { width: 197, align: "right" });
  pdf.end();
  return result;
}

app.get("/api/audit", requireMasterAdmin, (req, res) => {
  const entries = db.prepare(`
    SELECT audit_log.*, users.email FROM audit_log LEFT JOIN users ON users.id = audit_log.user_id
    ORDER BY audit_log.created_at DESC LIMIT 500
  `).all().map((entry) => ({ ...entry, details: JSON.parse(entry.details) }));
  res.json({ entries });
});

app.use((req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof z.ZodError) return res.status(422).json({ error: "Request validation failed.", details: error.issues });
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "A record with that email, SKU, supplier code, or reference already exists." });
  if (error.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return res.status(409).json({ error: "This record is linked to other ERP records and cannot be changed." });
  if (error.code?.startsWith("SQLITE_CONSTRAINT")) return res.status(422).json({ error: "The requested change violates an ERP data rule." });
  console.error("Unhandled API error", error);
  return res.status(500).json({ error: "An unexpected server error occurred." });
});

export async function start() {
  if (process.env.NODE_ENV === "production" && process.env.SESSION_COOKIE_SECURE !== "true") {
    throw new Error("Set SESSION_COOKIE_SECURE=true for production HTTPS deployments.");
  }
  initializeMasterAdmin();
  const server = app.listen(port, () => console.info(`Mercurio SQLite ERP API listening on port ${port}`));
  const shutdown = () => server.close(() => {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) start();

export { app };
