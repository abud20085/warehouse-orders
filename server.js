"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const DB_FILE = path.join(DATA_DIR, "warehouse.db");

fs.mkdirSync(AUDIO_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");

const now = () => new Date().toISOString();
const makeToken = () => crypto.randomBytes(32).toString("hex");
const str = (v) => (v == null ? "" : String(v)).trim();
const upper = (v) => str(v).toUpperCase();
const int = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};
const bool = (v) => v === true || v === 1 || v === "1" || v === "true";
const json = (v, fallback = null) => {
  try { return JSON.parse(v); } catch { return fallback; }
};

/* ---------------------------------------------------------
   DATABASE
--------------------------------------------------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  password_hash TEXT,
  can_send INTEGER NOT NULL DEFAULT 1,
  can_receive INTEGER NOT NULL DEFAULT 1,
  can_customize INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  default_page TEXT NOT NULL DEFAULT 'home',
  created_at TEXT NOT NULL,
  UNIQUE(name, role)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'normal',
  number TEXT,
  letter TEXT,
  size TEXT,
  color TEXT,
  notes TEXT,
  code TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal',
  sender_id INTEGER,
  sender_name TEXT,
  claimant_id INTEGER,
  claimant_name TEXT,
  prepared_by TEXT,
  prepared_at TEXT,
  closed_reason TEXT,
  edit_lock INTEGER NOT NULL DEFAULT 0,
  edit_by TEXT,
  edit_started_at TEXT,
  check_result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_audio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  sender_id INTEGER,
  sender_name TEXT,
  type TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  audio_file TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS displays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  number TEXT,
  letter TEXT,
  size TEXT,
  color TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  exact_piece INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  completed_by TEXT,
  ended_by TEXT,
  end_reason TEXT,
  ack_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS special_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER,
  sender_name TEXT,
  target_id INTEGER,
  target_name TEXT,
  type TEXT NOT NULL DEFAULT 'custom',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id INTEGER,
  caller_name TEXT,
  target_id INTEGER,
  target_name TEXT,
  location TEXT,
  detail TEXT,
  response TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER,
  sender_name TEXT,
  target_id INTEGER,
  target_name TEXT,
  text TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  ack INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ui_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  actor_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_notifications_target ON notifications(target_id, ack);
CREATE INDEX IF NOT EXISTS idx_displays_status ON displays(status);
`);

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column);
}
function addColumn(table, column, definition) {
  if (!columnExists(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Compatibility for older databases.
addColumn("users", "status", "TEXT NOT NULL DEFAULT 'available'");
addColumn("users", "can_send", "INTEGER NOT NULL DEFAULT 1");
addColumn("users", "can_receive", "INTEGER NOT NULL DEFAULT 1");
addColumn("users", "can_customize", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "permissions", "TEXT NOT NULL DEFAULT '{}'");
addColumn("users", "active", "INTEGER NOT NULL DEFAULT 1");
addColumn("users", "default_page", "TEXT NOT NULL DEFAULT 'home'");
addColumn("orders", "kind", "TEXT NOT NULL DEFAULT 'normal'");
addColumn("orders", "priority", "TEXT NOT NULL DEFAULT 'normal'");
addColumn("orders", "edit_lock", "INTEGER NOT NULL DEFAULT 0");
addColumn("orders", "edit_by", "TEXT");
addColumn("orders", "edit_started_at", "TEXT");
addColumn("orders", "check_result", "TEXT");

const defaultSettings = {
  supervisor_password: bcrypt.hashSync(process.env.SUPERVISOR_PASSWORD || "123456", 10),
  prep_limit: "10",
  unconfirmed_seconds: "30",
  audio_retention_days: "30",
  history_limit: "100",
  display_alert_seconds: "30",
  display_alert_enabled: "1",
  summon_locations: JSON.stringify(["كاشير", "بلاستيكات", "المكتب", "الجسر", "ورا اللوحة"]),
  numbers: JSON.stringify([]),
  colors: JSON.stringify(["BLK", "BRN", "COF", "GRY", "KHA", "NVY", "CML", "TAN", "CRM", "WHT", "BLU", "DGRY", "LGRY", "GRN", "OLV"]),
  letters: JSON.stringify(["R", "S", "B", "Z"]),
  sizes: JSON.stringify(["39", "40", "41", "42", "42.5", "43", "44", "45", "46", "47", "48", "49", "50"])
};

const getSetting = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
const setSetting = (key, value) => db.prepare(`
  INSERT INTO settings(key, value) VALUES(?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(key, String(value));

for (const [key, value] of Object.entries(defaultSettings)) {
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)").run(key, value);
}

/* ---------------------------------------------------------
   USERS / AUTH
--------------------------------------------------------- */

function seedUsers() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count > 0) return;

  const insert = db.prepare(`
    INSERT INTO users(name, role, password_hash, can_customize, permissions, created_at)
    VALUES(?, ?, ?, ?, ?, ?)
  `);
  const created = now();

  insert.run("المشرف", "supervisor", getSetting("supervisor_password"), 1, JSON.stringify({ all: true }), created);
  insert.run("موظف الصالة", "downstairs", null, 0, "{}", created);
  insert.run("حافظ", "upstairs", null, 0, "{}", created);
  insert.run("موظف مستودع 2", "upstairs", null, 0, "{}", created);
}
seedUsers();

const sessions = new Map();
const clients = new Set();
const peers = new Map();

function userFromDb(id) {
  return db.prepare(`
    SELECT id, name, role, status, can_send, can_receive, can_customize, permissions, active, default_page
    FROM users WHERE id = ?
  `).get(id) || null;
}
function isSupervisor(user) { return user?.role === "supervisor"; }
function hasPermission(user, name) {
  if (!user) return false;
  if (isSupervisor(user)) return true;
  if (bool(user[name])) return true;
  const p = json(user.permissions, {});
  return p?.all === true || p?.[name] === true;
}
function audit(user, action, entityType = null, entityId = null, details = "") {
  db.prepare(`
    INSERT INTO audit(actor_id, actor_name, action, entity_type, entity_id, details, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(user?.id ?? null, user?.name ?? null, action, entityType, entityId, str(details), now());
}
function event(orderId, type, user, details = "") {
  db.prepare(`
    INSERT INTO order_events(order_id, type, actor_id, actor_name, details, created_at)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(orderId, type, user?.id ?? null, user?.name ?? null, str(details), now());
  audit(user, type, "order", orderId, details);
}
function broadcast(type, payload = {}) {
  const message = JSON.stringify({ type, ...payload });
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try { ws.send(message); } catch {}
    }
  }
}
function orderById(id) { return db.prepare("SELECT * FROM orders WHERE id = ?").get(int(id)); }
function codeOf(x) { return [x.number, x.letter, x.size, x.color].filter(Boolean).join("-"); }
function requireOrder(req, res) {
  const order = orderById(req.params.id);
  if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return null; }
  return order;
}
function auth(req, res, next) {
  const header = str(req.headers.authorization);
  const value = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = sessions.get(value);
  if (!session) return res.status(401).json({ error: "غير مسجل الدخول" });
  const user = userFromDb(session.userId);
  if (!user || !user.active) {
    sessions.delete(value);
    return res.status(401).json({ error: "الحساب غير متاح" });
  }
  req.user = user;
  req.sessionToken = value;
  next();
}
function supervisorOnly(req, res, next) {
  if (!isSupervisor(req.user)) return res.status(403).json({ error: "هذه العملية للمشرف فقط" });
  next();
}

/* ---------------------------------------------------------
   HTTP
--------------------------------------------------------- */

app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AUDIO_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || ".webm").toLowerCase() || ".webm";
      cb(null, `${Date.now()}-${makeToken()}${ext}`);
    }
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^audio\//i.test(file.mimetype) || /\.(webm|wav|mp3|ogg|m4a)$/i.test(file.originalname || "");
    cb(ok ? null : new Error("نوع الملف الصوتي غير مسموح"), ok);
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "warehouse-orders", time: now(), node: process.version }));

app.post("/api/login", (req, res) => {
  const role = str(req.body.role);
  const name = str(req.body.name);

  if (role === "supervisor") {
    const user = db.prepare("SELECT * FROM users WHERE name = ? AND role = 'supervisor' AND active = 1").get(name || "المشرف");
    if (!user || !bcrypt.compareSync(str(req.body.password), user.password_hash || "")) {
      return res.status(401).json({ error: "بيانات المشرف غير صحيحة" });
    }
    const sessionToken = makeToken();
    sessions.set(sessionToken, { userId: user.id, createdAt: Date.now() });
    audit(user, "login", "user", user.id);
    return res.json({ token: sessionToken, user: userFromDb(user.id) });
  }

  if (!["downstairs", "upstairs"].includes(role)) return res.status(400).json({ error: "اختر الواجهة" });
  if (!name) return res.status(400).json({ error: "اكتب اسم الموظف" });

  let user = db.prepare("SELECT * FROM users WHERE name = ? AND role = ? AND active = 1").get(name, role);
  if (!user) {
    const result = db.prepare("INSERT INTO users(name, role, created_at) VALUES(?, ?, ?)").run(name, role, now());
    user = { id: Number(result.lastInsertRowid), name, role };
  }

  const sessionToken = makeToken();
  sessions.set(sessionToken, { userId: user.id, createdAt: Date.now() });
  audit(user, "login", "user", user.id);
  res.json({ token: sessionToken, user: userFromDb(user.id) });
});

app.post("/api/logout", auth, (req, res) => {
  audit(req.user, "logout", "user", req.user.id);
  sessions.delete(req.sessionToken);
  res.json({ ok: true });
});

app.get("/api/bootstrap", auth, (req, res) => {
  const historyLimit = Math.max(1, int(getSetting("history_limit"), 100));
  const orders = db.prepare(`
    SELECT * FROM orders
    WHERE status NOT IN ('closed','cancelled','unconfirmed') OR edit_lock = 1
    ORDER BY datetime(created_at) ASC
  `).all();
  const history = db.prepare("SELECT * FROM orders ORDER BY datetime(created_at) DESC LIMIT ?").all(historyLimit);
  const users = db.prepare(`SELECT id,name,role,status,can_send,can_receive,can_customize,permissions,active,default_page FROM users ORDER BY role,name`).all();
  const displays = db.prepare(`SELECT * FROM displays WHERE status IN ('requested','waiting','displayed') ORDER BY datetime(created_at) ASC`).all();
  const allDisplays = db.prepare("SELECT * FROM displays ORDER BY datetime(created_at) DESC LIMIT 300").all();
  const specials = db.prepare("SELECT * FROM special_requests ORDER BY datetime(created_at) DESC LIMIT 100").all();
  const summons = db.prepare("SELECT * FROM summons ORDER BY datetime(created_at) DESC LIMIT 100").all();
  const notifications = db.prepare(`SELECT * FROM notifications WHERE target_id IS NULL OR target_id = ? ORDER BY datetime(created_at) DESC LIMIT 100`).all(req.user.id);
  const auditRows = db.prepare("SELECT * FROM audit ORDER BY datetime(created_at) DESC LIMIT 300").all();
  const uiGlobal = db.prepare("SELECT value FROM ui_config WHERE key = 'ui:global'").get()?.value;
  const uiPersonal = db.prepare("SELECT value FROM ui_config WHERE key = ?").get(`ui:user:${req.user.id}`)?.value;

  res.json({
    me: req.user, orders, history, users, displays, allDisplays, specials, summons, notifications, audit: auditRows,
    settings: {
      prepLimit: int(getSetting("prep_limit"), 10),
      unconfirmedSeconds: int(getSetting("unconfirmed_seconds"), 30),
      audioRetentionDays: int(getSetting("audio_retention_days"), 30),
      historyLimit,
      displayAlertSeconds: int(getSetting("display_alert_seconds"), 30),
      displayAlertEnabled: getSetting("display_alert_enabled") === "1",
      locations: json(getSetting("summon_locations"), []),
      numbers: json(getSetting("numbers"), []),
      colors: json(getSetting("colors"), []),
      letters: json(getSetting("letters"), []),
      sizes: json(getSetting("sizes"), [])
    },
    ui: { global: json(uiGlobal, {}), personal: json(uiPersonal, {}) }
  });
});

/* Orders */
app.get("/api/order/:id/details", auth, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  res.json({
    order,
    events: db.prepare("SELECT * FROM order_events WHERE order_id = ? ORDER BY id ASC").all(order.id),
    replies: db.prepare("SELECT * FROM replies WHERE order_id = ? ORDER BY id ASC").all(order.id),
    audio: db.prepare("SELECT * FROM order_audio WHERE order_id = ? ORDER BY id ASC").all(order.id)
  });
});

app.post("/api/orders", auth, (req, res) => {
  if (req.user.role === "upstairs") return res.status(403).json({ error: "واجهة المستودع لا تنشئ طلب صالة من هذا المسار" });
  const number = upper(req.body.number), letter = upper(req.body.letter), size = upper(req.body.size), color = upper(req.body.color), notes = str(req.body.notes);
  if (![number, letter, size, color, notes].some(Boolean)) return res.status(400).json({ error: "أدخل بيانات الطلب" });
  const code = codeOf({ number, letter, size, color });
  const duplicate = code ? db.prepare(`SELECT id,code FROM orders WHERE status NOT IN ('closed','cancelled') AND COALESCE(code,'') = ? ORDER BY id DESC LIMIT 1`).get(code) : null;
  if (duplicate && !bool(req.body.allowDuplicate)) return res.status(409).json({ error: "يوجد طلب مشابه بالفعل", duplicateId: duplicate.id });

  const created = now();
  const result = db.prepare(`INSERT INTO orders(kind,number,letter,size,color,notes,code,status,priority,sender_id,sender_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    str(req.body.kind) || "normal", number, letter, size, color, notes, code, "new", str(req.body.priority) === "urgent" ? "urgent" : "normal", req.user.id, req.user.name, created, created
  );
  event(Number(result.lastInsertRowid), "created", req.user, notes);
  broadcast("orders_changed", { orderId: Number(result.lastInsertRowid) });
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});

app.post("/api/orders/:id/claim", auth, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  if (order.claimant_id) return res.status(409).json({ error: `تم استلامه بواسطة ${order.claimant_name}` });
  const limit = Math.max(1, int(getSetting("prep_limit"), 10));
  const activeCount = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('claimed','searching','needs_reply')`).get().n;
  if (activeCount >= limit && !isSupervisor(req.user)) return res.status(409).json({ error: `الحد الحالي ${limit}` });
  const result = db.prepare(`UPDATE orders SET status='claimed',claimant_id=?,claimant_name=?,updated_at=? WHERE id=? AND claimant_id IS NULL`).run(req.user.id, req.user.name, now(), order.id);
  if (result.changes !== 1) return res.status(409).json({ error: "تم استلام الطلب من جهاز آخر" });
  event(order.id, "claimed", req.user);
  broadcast("orders_changed", { orderId: order.id });
  res.json({ ok: true });
});

app.post("/api/orders/:id/status", auth, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  const status = str(req.body.status);
  const allowed = ["new","claimed","searching","needs_reply","prepared","waiting","unconfirmed","closed","cancelled","returned","editing"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "الحالة غير صحيحة" });
  if (status === "prepared" && req.user.role === "downstairs") return res.status(403).json({ error: "التجهيز من المستودع" });
  if (status === "closed" && req.user.role === "upstairs") return res.status(403).json({ error: "الإغلاق النهائي من الصالة" });

  const timestamp = now();
  const fields = ["status = ?", "updated_at = ?"], values = [status, timestamp];
  if (status === "prepared") { fields.push("prepared_by = ?", "prepared_at = ?"); values.push(req.user.name, timestamp); }
  if (["closed","returned","cancelled"].includes(status)) { fields.push("closed_reason = ?"); values.push(str(req.body.reason) || status); }
  values.push(order.id);
  db.prepare(`UPDATE orders SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  event(order.id, status, req.user, str(req.body.details || req.body.reason));
  broadcast("orders_changed", { orderId: order.id });
  res.json({ ok: true });
});

app.delete("/api/orders/:id", auth, supervisorOnly, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM order_events WHERE order_id=?").run(order.id);
    db.prepare("DELETE FROM replies WHERE order_id=?").run(order.id);
    const audio = db.prepare("SELECT file_name FROM order_audio WHERE order_id=?").all(order.id);
    for (const a of audio) { try { fs.unlinkSync(path.join(AUDIO_DIR, a.file_name)); } catch {} }
    db.prepare("DELETE FROM order_audio WHERE order_id=?").run(order.id);
    db.prepare("DELETE FROM displays WHERE order_id=?").run(order.id);
    db.prepare("DELETE FROM orders WHERE id=?").run(order.id);
  });
  transaction();
  audit(req.user, "order_deleted", "order", order.id, order.code || "");
  broadcast("orders_changed", { orderId: order.id });
  broadcast("history_changed");
  res.json({ ok: true });
});

app.post("/api/orders/:id/reopen", auth, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  db.prepare(`UPDATE orders SET status='new',claimant_id=NULL,claimant_name=NULL,closed_reason=NULL,edit_lock=0,edit_by=NULL,edit_started_at=NULL,updated_at=? WHERE id=?`).run(now(), order.id);
  event(order.id, "reopened", req.user, str(req.body.reason));
  broadcast("orders_changed", { orderId: order.id });
  res.json({ ok: true });
});

app.post("/api/orders/:id/edit/start", auth, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  if (order.edit_lock && order.edit_by !== req.user.name) return res.status(409).json({ error: `الطلب قيد التعديل بواسطة ${order.edit_by}` });
  db.prepare(`UPDATE orders SET edit_lock=1,edit_by=?,edit_started_at=?,status='editing',updated_at=? WHERE id=?`).run(req.user.name, now(), now(), order.id);
  event(order.id, "edit_started", req.user);
  broadcast("order_editing", { orderId: order.id, by: req.user.name });
  broadcast("orders_changed", { orderId: order.id });
  res.json({ ok: true });
});

app.post("/api/orders/:id/edit", auth, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  if (order.edit_lock && order.edit_by && order.edit_by !== req.user.name) return res.status(409).json({ error: `الطلب قيد التعديل بواسطة ${order.edit_by}` });
  const number = upper(req.body.number), letter = upper(req.body.letter), size = upper(req.body.size), color = upper(req.body.color), notes = str(req.body.notes);
  const newCode = codeOf({ number, letter, size, color });
  db.prepare(`UPDATE orders SET number=?,letter=?,size=?,color=?,notes=?,code=?,edit_lock=0,edit_by=NULL,edit_started_at=NULL,status='new',claimant_id=NULL,claimant_name=NULL,updated_at=? WHERE id=?`).run(number, letter, size, color, notes, newCode, now(), order.id);
  event(order.id, "edited", req.user, JSON.stringify({ before: { number: order.number, letter: order.letter, size: order.size, color: order.color }, after: { number, letter, size, color } }));
  broadcast("orders_changed", { orderId: order.id });
  res.json({ ok: true });
});

app.post("/api/orders/:id/check", auth, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  db.prepare(`UPDATE orders SET status='waiting',check_result=NULL,updated_at=? WHERE id=? AND status NOT IN ('closed','cancelled')`).run(now(), order.id);
  event(order.id, "check_requested", req.user);
  broadcast("check_requested", { orderId: order.id, by: req.user.name });
  broadcast("orders_changed", { orderId: order.id });
  res.json({ ok: true });
});

app.post("/api/orders/:id/check-result", auth, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  const result = str(req.body.result);
  if (!["موجود","غير موجود","يوجد بديل"].includes(result)) return res.status(400).json({ error: "نتيجة غير صحيحة" });
  db.prepare("UPDATE orders SET check_result=?,status='waiting',updated_at=? WHERE id=?").run(result, now(), order.id);
  event(order.id, "check_result", req.user, result);
  broadcast("check_result", { orderId: order.id, result });
  broadcast("orders_changed", { orderId: order.id });
  res.json({ ok: true });
});

app.post("/api/orders/:id/alternative", auth, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  const message = str(req.body.text) || "يوجد بديل للطلب";
  db.prepare("UPDATE orders SET status='needs_reply',updated_at=? WHERE id=?").run(now(), order.id);
  db.prepare(`INSERT INTO notifications(sender_id,sender_name,target_id,target_name,text,type,created_at) VALUES(?,?,?,?,?,?,?)`).run(req.user.id, req.user.name, order.sender_id, order.sender_name, message, "alternative", now());
  event(order.id, "alternative", req.user, message);
  broadcast("notifications_changed");
  broadcast("orders_changed", { orderId: order.id });
  res.json({ ok: true });
});

app.post("/api/orders/:id/transfer", auth, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  const target = db.prepare("SELECT id,name FROM users WHERE id=? AND role='upstairs' AND active=1").get(int(req.body.toId));
  if (!target) return res.status(400).json({ error: "الموظف غير موجود" });
  db.prepare("UPDATE orders SET claimant_id=?,claimant_name=?,status='claimed',updated_at=? WHERE id=?").run(target.id, target.name, now(), order.id);
  event(order.id, "transfer", req.user, `إلى ${target.name}`);
  broadcast("orders_changed", { orderId: order.id });
  res.json({ ok: true });
});

app.post("/api/orders/:id/reply", auth, (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  const message = str(req.body.text);
  if (!message) return res.status(400).json({ error: "البيانات ناقصة" });
  db.prepare(`INSERT INTO replies(order_id,sender_id,sender_name,type,text,created_at) VALUES(?,?,?,?,?,?)`).run(order.id, req.user.id, req.user.name, "text", message, now());
  db.prepare("UPDATE orders SET status='needs_reply',updated_at=? WHERE id=?").run(now(), order.id);
  event(order.id, "reply", req.user, message);
  broadcast("orders_changed", { orderId: order.id });
  res.json({ ok: true });
});

app.post("/api/orders/:id/audio", auth, upload.single("audio"), (req, res) => {
  const order = requireOrder(req, res); if (!order) return;
  if (!req.file) return res.status(400).json({ error: "الصوت غير موجود" });
  db.prepare("INSERT INTO order_audio(order_id,file_name,created_at) VALUES(?,?,?)").run(order.id, req.file.filename, now());
  event(order.id, "audio", req.user);
  broadcast("orders_changed", { orderId: order.id });
  res.json({ ok: true, file: req.file.filename });
});

app.get("/api/audio/:file", auth, (req, res) => {
  const file = path.basename(req.params.file);
  const row = db.prepare("SELECT id FROM order_audio WHERE file_name=?").get(file);
  if (!row) return res.status(404).json({ error: "الملف غير موجود" });
  res.sendFile(path.join(AUDIO_DIR, file));
});

/* Other modules */
app.post("/api/special", auth, (req, res) => {
  const message = str(req.body.text);
  if (!message) return res.status(400).json({ error: "اكتب الطلب الخاص" });
  const targetId = req.body.targetId ? int(req.body.targetId) : null;
  const target = targetId ? db.prepare("SELECT id,name FROM users WHERE id=? AND active=1").get(targetId) : null;
  const result = db.prepare(`INSERT INTO special_requests(sender_id,sender_name,target_id,target_name,type,text,created_at) VALUES(?,?,?,?,?,?,?)`).run(req.user.id, req.user.name, target?.id ?? null, target?.name ?? null, str(req.body.type) || "custom", message, now());
  audit(req.user, "special_request", "special", Number(result.lastInsertRowid), message);
  broadcast("special_changed");
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});

app.post("/api/summons", auth, (req, res) => {
  const target = db.prepare("SELECT id,name FROM users WHERE id=? AND active=1").get(int(req.body.targetId));
  if (!target) return res.status(400).json({ error: "اختر موظفًا" });
  const result = db.prepare(`INSERT INTO summons(caller_id,caller_name,target_id,target_name,location,detail,created_at) VALUES(?,?,?,?,?,?,?)`).run(req.user.id, req.user.name, target.id, target.name, str(req.body.location) || "غير محدد", str(req.body.detail), now());
  audit(req.user, "summon", "summon", Number(result.lastInsertRowid), target.name);
  broadcast("summons_changed");
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});
app.post("/api/summons/:id/respond", auth, (req, res) => {
  const result = db.prepare("UPDATE summons SET response=?,status='answered' WHERE id=? AND target_id=?").run(str(req.body.response) || "حاضر", int(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: "الاستدعاء غير موجود" });
  broadcast("summons_changed");
  res.json({ ok: true });
});

app.post("/api/notifications", auth, (req, res) => {
  const message = str(req.body.text);
  if (!message) return res.status(400).json({ error: "اكتب التنبيه" });
  const ids = Array.isArray(req.body.targetIds) ? req.body.targetIds.map(int).filter(Boolean) : [];
  const type = str(req.body.type) || "info";
  const insert = db.prepare(`INSERT INTO notifications(sender_id,sender_name,target_id,target_name,text,type,created_at) VALUES(?,?,?,?,?,?,?)`);
  if (!ids.length) insert.run(req.user.id, req.user.name, null, null, message, type, now());
  else for (const id of ids) {
    const u = db.prepare("SELECT id,name FROM users WHERE id=? AND active=1").get(id);
    if (u) insert.run(req.user.id, req.user.name, u.id, u.name, message, type, now());
  }
  audit(req.user, "notification", "notification", null, message);
  broadcast("notifications_changed");
  res.json({ ok: true });
});
app.post("/api/notifications/:id/ack", auth, (req, res) => {
  db.prepare("UPDATE notifications SET ack=1 WHERE id=? AND (target_id IS NULL OR target_id=?)").run(int(req.params.id), req.user.id);
  res.json({ ok: true });
});

/* Users */
app.post("/api/users", auth, supervisorOnly, (req, res) => {
  const name = str(req.body.name), role = str(req.body.role);
  if (!name || !["supervisor","downstairs","upstairs"].includes(role)) return res.status(400).json({ error: "بيانات الموظف ناقصة" });
  try {
    const result = db.prepare(`INSERT INTO users(name,role,password_hash,can_customize,permissions,created_at) VALUES(?,?,?,?,?,?)`).run(name, role, role === "supervisor" ? getSetting("supervisor_password") : null, bool(req.body.canCustomize) ? 1 : 0, JSON.stringify(req.body.permissions || {}), now());
    audit(req.user, "user_created", "user", Number(result.lastInsertRowid), name);
    broadcast("users_changed");
    res.json({ ok: true, id: Number(result.lastInsertRowid) });
  } catch { res.status(409).json({ error: "المستخدم موجود بالفعل" }); }
});
app.post("/api/users/:id/permissions", auth, supervisorOnly, (req, res) => {
  const id = int(req.params.id);
  if (!db.prepare("SELECT id FROM users WHERE id=?").get(id)) return res.status(404).json({ error: "المستخدم غير موجود" });
  db.prepare(`UPDATE users SET can_send=?,can_receive=?,can_customize=?,permissions=?,default_page=? WHERE id=?`).run(bool(req.body.canSend) ? 1 : 0, bool(req.body.canReceive) ? 1 : 0, bool(req.body.canCustomize) ? 1 : 0, JSON.stringify(req.body.permissions || {}), str(req.body.defaultPage) || "home", id);
  audit(req.user, "permissions_changed", "user", id, JSON.stringify(req.body));
  broadcast("users_changed");
  res.json({ ok: true });
});
app.post("/api/users/:id/status", auth, (req, res) => {
  const id = int(req.params.id);
  if (!isSupervisor(req.user) && id !== req.user.id) return res.status(403).json({ error: "غير مسموح" });
  const status = str(req.body.status);
  if (!["available","busy","away","offline"].includes(status)) return res.status(400).json({ error: "الحالة غير صحيحة" });
  db.prepare("UPDATE users SET status=? WHERE id=?").run(status, id);
  audit(req.user, "status_changed", "user", id, status);
  broadcast("users_changed");
  res.json({ ok: true });
});

app.post("/api/settings", auth, supervisorOnly, (req, res) => {
  const allowed = ["prep_limit","unconfirmed_seconds","audio_retention_days","history_limit","display_alert_seconds","display_alert_enabled","summon_locations","numbers","colors","letters","sizes"];
  for (const key of allowed) if (req.body[key] !== undefined) setSetting(key, typeof req.body[key] === "object" ? JSON.stringify(req.body[key]) : req.body[key]);
  audit(req.user, "settings_changed", "settings", null, JSON.stringify(req.body));
  broadcast("settings_changed");
  res.json({ ok: true });
});
app.post("/api/password", auth, supervisorOnly, (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 6) return res.status(400).json({ error: "كلمة المرور 6 أحرف على الأقل" });
  const hash = bcrypt.hashSync(password, 10);
  setSetting("supervisor_password", hash);
  db.prepare("UPDATE users SET password_hash=? WHERE role='supervisor'").run(hash);
  audit(req.user, "password_changed", "user");
  broadcast("password_changed");
  res.json({ ok: true });
});

/* History / search */
app.get("/api/history", auth, (req, res) => {
  const q = upper(req.query.q), from = str(req.query.from), to = str(req.query.to), status = str(req.query.status);
  const where = [], values = [];
  if (q) { where.push("(UPPER(COALESCE(code,'')) LIKE ? OR UPPER(COALESCE(sender_name,'')) LIKE ? OR UPPER(COALESCE(claimant_name,'')) LIKE ?)"); const v = `%${q}%`; values.push(v,v,v); }
  if (from) { where.push("date(created_at) >= date(?)"); values.push(from); }
  if (to) { where.push("date(created_at) <= date(?)"); values.push(to); }
  if (status) { where.push("status=?"); values.push(status); }
  res.json({ orders: db.prepare(`SELECT * FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY datetime(created_at) DESC LIMIT 500`).all(...values) });
});
app.post("/api/search", auth, (req, res) => {
  const q = upper(req.body.q);
  if (!q) return res.json({ orders: [], displays: [], users: [] });
  const like = `%${q}%`;
  res.json({
    orders: db.prepare(`SELECT * FROM orders WHERE UPPER(COALESCE(code,'')) LIKE ? OR UPPER(COALESCE(sender_name,'')) LIKE ? OR UPPER(COALESCE(claimant_name,'')) LIKE ? ORDER BY datetime(created_at) DESC LIMIT 200`).all(like,like,like),
    displays: db.prepare(`SELECT * FROM displays WHERE UPPER(COALESCE(number || '-' || letter || '-' || size || '-' || color,'')) LIKE ? ORDER BY datetime(created_at) DESC LIMIT 100`).all(like),
    users: db.prepare("SELECT id,name,role,status,active FROM users WHERE UPPER(name) LIKE ? ORDER BY name LIMIT 100").all(like)
  });
});
app.delete("/api/history", auth, supervisorOnly, (req, res) => {
  const transaction = db.transaction(() => {
    const orders = db.prepare("SELECT id FROM orders WHERE status IN ('closed','cancelled')").all();
    for (const o of orders) {
      db.prepare("DELETE FROM order_events WHERE order_id=?").run(o.id);
      db.prepare("DELETE FROM replies WHERE order_id=?").run(o.id);
      const audio = db.prepare("SELECT file_name FROM order_audio WHERE order_id=?").all(o.id);
      for (const a of audio) { try { fs.unlinkSync(path.join(AUDIO_DIR, a.file_name)); } catch {} }
      db.prepare("DELETE FROM order_audio WHERE order_id=?").run(o.id);
    }
    db.prepare("DELETE FROM orders WHERE status IN ('closed','cancelled')").run();
  });
  transaction();
  audit(req.user, "history_deleted", "history");
  broadcast("history_changed");
  res.json({ ok: true });
});

/* Displays */
app.post("/api/displays", auth, (req, res) => {
  const sourceOrder = req.body.orderId ? orderById(req.body.orderId) : null;
  const number = upper(req.body.number || sourceOrder?.number), letter = upper(req.body.letter || sourceOrder?.letter), size = upper(req.body.size || sourceOrder?.size), color = upper(req.body.color || sourceOrder?.color);
  if (![number,letter,size,color].some(Boolean)) return res.status(400).json({ error: "بيانات العرض ناقصة" });
  const duplicate = db.prepare(`SELECT * FROM displays WHERE status IN ('requested','waiting','displayed') AND number=? AND letter=? AND size=? AND color=? LIMIT 1`).get(number,letter,size,color);
  if (duplicate) return res.status(409).json({ error: `الموظف ${duplicate.created_by} أضاف العرض بالفعل` });
  const created = now();
  const result = db.prepare(`INSERT INTO displays(order_id,number,letter,size,color,status,exact_piece,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'requested',?,?,?,?)`).run(req.body.orderId || null, number,letter,size,color,bool(req.body.exactPiece) ? 1 : 0, req.user.name, created, created);
  if (sourceOrder) event(sourceOrder.id, "display_requested", req.user, codeOf({number,letter,size,color}));
  broadcast("displays_changed");
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});
app.post("/api/displays/:id/status", auth, (req, res) => {
  const display = db.prepare("SELECT * FROM displays WHERE id=?").get(int(req.params.id));
  if (!display) return res.status(404).json({ error: "العرض غير موجود" });
  const status = str(req.body.status);
  if (!["requested","waiting","displayed","ended","cancelled","expired"].includes(status)) return res.status(400).json({ error: "الحالة غير صحيحة" });
  const completedBy = status === "displayed" ? req.user.name : display.completed_by;
  const endedBy = ["ended","expired","cancelled"].includes(status) ? req.user.name : display.ended_by;
  db.prepare("UPDATE displays SET status=?,completed_by=?,ended_by=?,end_reason=?,updated_at=? WHERE id=?").run(status,completedBy,endedBy,str(req.body.reason)||null,now(),display.id);
  broadcast("displays_changed");
  res.json({ ok: true });
});
app.post("/api/displays/:id/ack", auth, (req, res) => {
  db.prepare("UPDATE displays SET ack_by=?,updated_at=? WHERE id=?").run(req.user.name,now(),int(req.params.id));
  broadcast("displays_changed");
  res.json({ ok: true });
});

app.post("/api/ui", auth, (req, res) => {
  if (!isSupervisor(req.user) && !req.user.can_customize) return res.status(403).json({ error: "لا تملك صلاحية التخصيص" });
  const key = isSupervisor(req.user) ? "ui:global" : `ui:user:${req.user.id}`;
  db.prepare(`INSERT INTO ui_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(req.body || {}));
  audit(req.user, "ui_changed", "ui", null, key);
  broadcast("ui_changed");
  res.json({ ok: true });
});
app.post("/api/cleanup", auth, supervisorOnly, (req, res) => {
  const days = Math.max(1, int(getSetting("audio_retention_days"), 30));
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const row of db.prepare("SELECT id,file_name,created_at FROM order_audio").all()) {
    if (new Date(row.created_at).getTime() < cutoff) {
      try { fs.unlinkSync(path.join(AUDIO_DIR,row.file_name)); } catch {}
      db.prepare("DELETE FROM order_audio WHERE id=?").run(row.id);
      removed++;
    }
  }
  audit(req.user,"audio_cleanup","audio",null,String(removed));
  res.json({ ok:true, removed });
});

/* ---------------------------------------------------------
   WEBSOCKET
--------------------------------------------------------- */

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // Authentication token can be supplied as ?token=... .
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const token = url.searchParams.get("token");
    const session = token ? sessions.get(token) : null;
    if (session) ws.userId = session.userId;
  } catch {}

  ws.on("message", raw => {
    const message = json(raw.toString(), null);
    if (!message || !ws.userId) return;
    if (["call","offer","answer","ice","hangup"].includes(message.type)) {
      const target = peers.get(int(message.to));
      if (target?.readyState === 1) {
        target.send(JSON.stringify({ ...message, from: ws.userId }));
      }
    }
  });

  if (ws.userId) peers.set(ws.userId, ws);
  ws.on("close", () => {
    clients.delete(ws);
    if (ws.userId && peers.get(ws.userId) === ws) peers.delete(ws.userId);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000).unref();

/* ---------------------------------------------------------
   BACKGROUND TASKS
--------------------------------------------------------- */

setInterval(() => {
  const seconds = Math.max(1, int(getSetting("unconfirmed_seconds"), 30));
  const changed = db.prepare(`
    UPDATE orders SET status='unconfirmed',updated_at=?
    WHERE status='prepared' AND (julianday('now') - julianday(updated_at))*86400 >= ?
  `).run(now(), seconds);
  if (changed.changes) broadcast("orders_changed");
}, 5000).unref();

setInterval(() => {
  if (getSetting("display_alert_enabled") !== "1") return;
  const seconds = Math.max(1, int(getSetting("display_alert_seconds"), 30));
  const rows = db.prepare("SELECT id,created_at FROM displays WHERE status='requested'").all();
  for (const row of rows) {
    if ((Date.now() - new Date(row.created_at).getTime()) / 1000 >= seconds) {
      const changed = db.prepare("UPDATE displays SET status='waiting',updated_at=? WHERE id=? AND status='requested'").run(now(),row.id);
      if (changed.changes) broadcast("display_alert", { displayId: row.id });
    }
  }
}, 5000).unref();

setInterval(() => {
  const changed = db.prepare(`
    UPDATE orders SET edit_lock=0,edit_by=NULL,edit_started_at=NULL,
    status=CASE WHEN status='editing' THEN 'new' ELSE status END,updated_at=?
    WHERE edit_lock=1 AND edit_started_at IS NOT NULL
    AND (julianday('now') - julianday(edit_started_at))*86400 >= 300
  `).run(now());
  if (changed.changes) broadcast("orders_changed");
}, 30000).unref();

/* ---------------------------------------------------------
   ERRORS / SPA
--------------------------------------------------------- */

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  const status = err instanceof multer.MulterError ? 400 : 500;
  res.status(status).json({ error: err.message || "حدث خطأ داخلي في السيرفر" });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "المسار غير موجود" }));
app.get("/{*splat}", (_req, res) => {
  const index = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send("public/index.html غير موجود");
});

/* ---------------------------------------------------------
   START / SHUTDOWN
--------------------------------------------------------- */

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

server.listen(PORT, HOST, () => {
  console.log(`Warehouse Orders listening on ${HOST}:${PORT}`);
  console.log(`Database: ${DB_FILE}`);
});

function shutdown(signal) {
  console.log(`${signal}: shutting down...`);
  for (const token of sessions.keys()) sessions.delete(token);
  for (const ws of wss.clients) { try { ws.close(); } catch {} }
  server.close(() => {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
