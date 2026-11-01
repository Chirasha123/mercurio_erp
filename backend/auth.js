import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { db, newId } from "./database.js";

const SESSION_COOKIE = "mercurio_session";
const SESSION_DURATION_HOURS = 8;
const SCRYPT_BYTES = 64;

export const modulePermissions = Object.freeze({
  MM: ["view", "create", "edit", "delete", "reports"],
  PRM: ["view", "create", "edit", "delete", "reports"],
  AP: ["view", "create", "edit", "delete", "reports"],
  SM: ["view", "create", "edit", "delete", "reports"],
  FM: ["view", "create", "edit", "delete", "reports"],
  PM: ["view", "create", "edit", "delete", "reports"],
});

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return {
    password_hash: scryptSync(password, salt, SCRYPT_BYTES).toString("hex"),
    password_salt: salt,
  };
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function parsePermissions(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value ?? "{}");
  } catch (error) {
    console.error("Could not parse stored user permissions", error);
    return {};
  }
}

export function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    masterAdmin: Boolean(user.master_admin),
    active: Boolean(user.active),
    forcePasswordChange: Boolean(user.force_password_change),
    permissions: user.master_admin
      ? Object.fromEntries(Object.keys(modulePermissions).map((module) => [module, modulePermissions[module]]))
      : parsePermissions(user.permissions),
    createdAt: user.created_at,
  };
}

export function createUserRecord({ email, password, masterAdmin = false, forcePasswordChange = true, permissions = {} }) {
  const id = newId();
  const passwordFields = hashPassword(password);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, master_admin,
      force_password_change, permissions)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, email.trim().toLowerCase(), passwordFields.password_hash, passwordFields.password_salt,
    Number(masterAdmin), Number(forcePasswordChange), JSON.stringify(permissions),
  );
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function verifyPassword(password, storedHash, salt) {
  const usableSalt = salt ?? "invalid-login-salt";
  const expected = storedHash && /^[a-f0-9]+$/i.test(storedHash) && storedHash.length === SCRYPT_BYTES * 2
    ? Buffer.from(storedHash, "hex")
    : Buffer.alloc(SCRYPT_BYTES);
  const actual = scryptSync(password, usableSalt, SCRYPT_BYTES);
  return timingSafeEqual(actual, expected) && Boolean(storedHash && salt);
}

export function initializeMasterAdmin() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (count > 0) return;
  const email = process.env.MASTER_ADMIN_EMAIL?.trim();
  const password = process.env.MASTER_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) {
    throw new Error("Set MASTER_ADMIN_EMAIL and a MASTER_ADMIN_PASSWORD of at least 12 characters to initialize the empty database.");
  }
  const admin = createUserRecord({ email, password, masterAdmin: true, forcePasswordChange: true });
  console.info(`Bootstrapped master administrator ${admin.email}; change the bootstrap password immediately.`);
}

export function createSession(user, res) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash(token), user.id, csrfToken, expiresAt);
  const secure = process.env.SESSION_COOKIE_SECURE === "true" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${SESSION_DURATION_HOURS * 60 * 60}${secure}`);
  return { user: serializeUser(user), csrfToken };
}

export function destroySession(req, res) {
  if (req.session?.tokenHash) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(req.session.tokenHash);
  const secure = process.env.SESSION_COOKIE_SECURE === "true" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0${secure}`);
}

export function authenticate(req, res, next) {
  const cookie = req.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const token = cookie?.slice(SESSION_COOKIE.length + 1);
  if (!token) return res.status(401).json({ error: "Please sign in to continue." });
  const hashed = tokenHash(token);
  const session = db.prepare(`
    SELECT sessions.token_hash, sessions.csrf_token, sessions.expires_at, users.*
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashed, new Date().toISOString());
  if (!session || !session.active) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashed);
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
  req.user = {
    ...session,
    masterAdmin: Boolean(session.master_admin),
    active: Boolean(session.active),
    permissions: parsePermissions(session.permissions),
  };
  req.session = { tokenHash: session.token_hash, csrfToken: session.csrf_token };
  return next();
}

export function requireCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const supplied = req.get("X-CSRF-Token") ?? "";
  const expected = req.session?.csrfToken ?? "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (!expected || suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return res.status(403).json({ error: "Your security token is missing or expired. Refresh the page and try again." });
  }
  return next();
}

export function requireMasterAdmin(req, res, next) {
  if (!req.user?.master_admin) return res.status(403).json({ error: "Master administrator access is required." });
  return next();
}

export function requirePermission(module, action) {
  return (req, res, next) => {
    if (req.user?.master_admin || req.user?.permissions?.[module]?.includes(action)) return next();
    return res.status(403).json({ error: `You do not have ${action} access to ${module}.` });
  };
}

export function requireAnyPermission(modules, action) {
  return (req, res, next) => {
    if (req.user?.master_admin || modules.some((module) => req.user?.permissions?.[module]?.includes(action))) return next();
    return res.status(403).json({ error: `You do not have ${action} access to ${modules.join(" or ")}.` });
  };
}

export function updateUserPermissions(userId, permissions) {
  db.prepare("UPDATE users SET permissions = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(permissions), userId);
}

export function setUserActive(userId, active) {
  db.prepare("UPDATE users SET active = ?, updated_at = datetime('now') WHERE id = ?")
    .run(Number(active), userId);
}

export function changeUserPassword(userId, password, forcePasswordChange = false) {
  const passwordFields = hashPassword(password);
  db.prepare(`
    UPDATE users SET password_hash = ?, password_salt = ?, force_password_change = ?,
      updated_at = datetime('now') WHERE id = ?
  `).run(passwordFields.password_hash, passwordFields.password_salt, Number(forcePasswordChange), userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}
