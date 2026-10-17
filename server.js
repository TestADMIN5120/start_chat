'use strict';
// Chat app with built-in tasks: server.
// Serves the web app, stores everything in one SQLite file, and tells
// connected phones when something in one of their groups has changed.

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const PORT = Number(process.env.PORT) || 3000;
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'data.db'));

const SERVICE_ACCOUNT_FILE = process.env.FIREBASE_SERVICE_ACCOUNT_FILE
  || path.join(__dirname, 'chatapp-22c89-firebase-adminsdk-fbsvc-bb503e87da.json');
initializeApp({ credential: cert(require(SERVICE_ACCOUNT_FILE)) });
const firebaseAuth = getAuth();

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'chat', token TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS chat_groups (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  group_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (group_id, user_id));
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, user_id INTEGER,
  kind TEXT NOT NULL, text TEXT NOT NULL, ref_id INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages (group_id, id);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, title TEXT NOT NULL,
  assignee_id INTEGER NOT NULL, created_by INTEGER NOT NULL, due INTEGER,
  created_at INTEGER NOT NULL, done_at INTEGER, done_by INTEGER);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee_id);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS acks (
  notice_id INTEGER NOT NULL, user_id INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (notice_id, user_id));
`);

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const insert = (sql, ...p) => Number(run(sql, ...p).lastInsertRowid);

const cleanPhone = (v) => String(v || '').replace(/\D/g, '');
const cleanText = (v, max) => String(v || '').trim().slice(0, max);
const publicUser = (u) => ({ id: u.id, name: u.name, phone: u.phone, mode: u.mode });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// ---------- live updates ----------
const sockets = new Map(); // user id -> Set of open sockets

function notifyGroup(groupId) {
  const payload = JSON.stringify({ type: 'update', groupId });
  for (const m of all('SELECT user_id FROM members WHERE group_id = ?', groupId)) {
    for (const ws of sockets.get(m.user_id) || []) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }
}

function addMessage(groupId, userId, kind, text, refId) {
  insert('INSERT INTO messages (group_id, user_id, kind, text, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    groupId, userId, kind, text, refId || null, Date.now());
}

// ---------- web server ----------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const route = (fn) => (req, res, next) => {
  Promise.resolve().then(() => fn(req)).then((data) => res.json(data || { ok: true })).catch(next);
};

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const user = token && get('SELECT * FROM users WHERE token = ?', token);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });
  req.user = user;
  next();
}

function memberGroup(req) {
  const id = Number(req.params.id);
  const group = get(`SELECT g.* FROM chat_groups g JOIN members m ON m.group_id = g.id
                     WHERE g.id = ? AND m.user_id = ?`, id, req.user.id);
  if (!group) fail(404, 'Group not found.');
  return group;
}

// Sign in: the browser verifies the phone number with Firebase (which sends
// the real SMS and checks the code), then hands us the resulting Firebase ID
// token. We verify that token server-side and issue our own app token.
app.post('/api/login', route(async (req) => {
  const name = cleanText(req.body.name, 40);
  const idToken = String(req.body.idToken || '');
  if (!idToken) fail(400, 'Missing sign-in token.');
  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(idToken);
  } catch (e) {
    fail(401, 'That sign-in code is invalid or expired. Try again.');
  }
  const phone = cleanPhone(decoded.phone_number);
  if (phone.length < 8 || phone.length > 15) fail(400, 'Could not read a valid phone number.');
  let user = get('SELECT * FROM users WHERE phone = ?', phone);
  if (!user) {
    if (!name) fail(400, 'Enter your name.');
    const id = insert('INSERT INTO users (name, phone, token) VALUES (?, ?, ?)',
      name, phone, crypto.randomBytes(24).toString('hex'));
    user = get('SELECT * FROM users WHERE id = ?', id);
  } else if (name && name !== user.name) {
    run('UPDATE users SET name = ? WHERE id = ?', name, user.id);
    user.name = name;
  }
  return { token: user.token, user: publicUser(user) };
}));

app.use('/api', auth);

app.get('/api/me', route((req) => ({ user: publicUser(req.user) })));

app.post('/api/mode', route((req) => {
  const mode = req.body.mode === 'advanced' ? 'advanced' : 'chat';
  run('UPDATE users SET mode = ? WHERE id = ?', mode, req.user.id);
  return { mode };
}));

app.get('/api/groups', route((req) => {
  const groups = all(`
    SELECT g.id, g.name,
      (SELECT COUNT(*) FROM members WHERE group_id = g.id) AS memberCount,
      (SELECT COUNT(*) FROM tasks WHERE group_id = g.id AND done_at IS NULL) AS openAll,
      (SELECT COUNT(*) FROM tasks WHERE group_id = g.id AND done_at IS NULL AND assignee_id = ?) AS openMine
    FROM chat_groups g JOIN members m ON m.group_id = g.id
    WHERE m.user_id = ?`, req.user.id, req.user.id);
  for (const g of groups) {
    const last = get(`SELECT m.text, m.kind, m.created_at, u.name FROM messages m
                      LEFT JOIN users u ON u.id = m.user_id
                      WHERE m.group_id = ? ORDER BY m.id DESC LIMIT 1`, g.id);
    g.last = last || null;
  }
  groups.sort((a, b) => (b.last ? b.last.created_at : 0) - (a.last ? a.last.created_at : 0));
  return { groups };
}));

function addMembersByPhone(groupId, phones) {
  const notFound = [];
  for (const raw of phones) {
    const phone = cleanPhone(raw);
    if (!phone) continue;
    const user = get('SELECT id FROM users WHERE phone = ?', phone);
    if (!user) { notFound.push(phone); continue; }
    run('INSERT OR IGNORE INTO members (group_id, user_id) VALUES (?, ?)', groupId, user.id);
  }
  return notFound;
}

app.post('/api/groups', route((req) => {
  const name = cleanText(req.body.name, 60);
  if (!name) fail(400, 'Give the group a name.');
  const phones = Array.isArray(req.body.phones) ? req.body.phones.slice(0, 200) : [];
  const id = insert('INSERT INTO chat_groups (name, created_by, created_at) VALUES (?, ?, ?)',
    name, req.user.id, Date.now());
  run('INSERT INTO members (group_id, user_id) VALUES (?, ?)', id, req.user.id);
  const notFound = addMembersByPhone(id, phones);
  addMessage(id, null, 'system', `${req.user.name} created the group`);
  notifyGroup(id);
  return { id, notFound };
}));

app.post('/api/groups/:id/members', route((req) => {
  const group = memberGroup(req);
  const notFound = addMembersByPhone(group.id, [req.body.phone]);
  if (notFound.length) fail(404, 'That number has not joined the app yet.');
  notifyGroup(group.id);
}));

app.get('/api/groups/:id', route((req) => {
  const group = memberGroup(req);
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const notices = all('SELECT * FROM notices WHERE group_id = ? ORDER BY id DESC LIMIT 50', group.id);
  for (const n of notices) n.acks = all('SELECT user_id, at FROM acks WHERE notice_id = ?', n.id);
  const messages = all('SELECT * FROM messages WHERE group_id = ? ORDER BY id DESC LIMIT 200', group.id).reverse();
  return {
    group: { id: group.id, name: group.name },
    members: all(`SELECT u.id, u.name FROM users u JOIN members m ON m.user_id = u.id
                  WHERE m.group_id = ? ORDER BY u.name`, group.id),
    messages,
    tasks: all(`SELECT * FROM tasks WHERE group_id = ? AND (done_at IS NULL OR done_at > ?)
                ORDER BY done_at IS NOT NULL, due IS NULL, due, id`, group.id, weekAgo),
    notices,
  };
}));

app.post('/api/groups/:id/messages', route((req) => {
  const group = memberGroup(req);
  const text = cleanText(req.body.text, 4000);
  if (!text) fail(400, 'Type a message first.');
  addMessage(group.id, req.user.id, 'text', text);
  notifyGroup(group.id);
}));

app.post('/api/groups/:id/tasks', route((req) => {
  const group = memberGroup(req);
  const title = cleanText(req.body.title, 200);
  if (!title) fail(400, 'Give the task a title.');
  const assigneeId = Number(req.body.assigneeId);
  if (!get('SELECT 1 AS ok FROM members WHERE group_id = ? AND user_id = ?', group.id, assigneeId)) {
    fail(400, 'Choose someone from this group.');
  }
  const due = Number(req.body.due) > 0 ? Number(req.body.due) : null;
  const id = insert(`INSERT INTO tasks (group_id, title, assignee_id, created_by, due, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)`, group.id, title, assigneeId, req.user.id, due, Date.now());
  addMessage(group.id, req.user.id, 'task', title, id);
  notifyGroup(group.id);
  return { id };
}));

app.post('/api/tasks/:id/done', route((req) => {
  const task = get('SELECT * FROM tasks WHERE id = ?', Number(req.params.id));
  if (!task) fail(404, 'Task not found.');
  if (task.assignee_id !== req.user.id && task.created_by !== req.user.id) {
    fail(403, 'Only the person doing the task or the person who gave it can change it.');
  }
  const done = req.body.done !== false;
  if (done === (task.done_at !== null)) return { ok: true };
  if (done) {
    run('UPDATE tasks SET done_at = ?, done_by = ? WHERE id = ?', Date.now(), req.user.id, task.id);
    addMessage(task.group_id, null, 'system', `${req.user.name} finished “${task.title}”`);
  } else {
    run('UPDATE tasks SET done_at = NULL, done_by = NULL WHERE id = ?', task.id);
    addMessage(task.group_id, null, 'system', `${req.user.name} reopened “${task.title}”`);
  }
  notifyGroup(task.group_id);
}));

app.post('/api/groups/:id/notices', route((req) => {
  const group = memberGroup(req);
  const title = cleanText(req.body.title, 120);
  const body = cleanText(req.body.body, 2000);
  if (!title) fail(400, 'Give the notice a title.');
  const id = insert('INSERT INTO notices (group_id, title, body, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    group.id, title, body, req.user.id, Date.now());
  addMessage(group.id, req.user.id, 'notice', title, id);
  notifyGroup(group.id);
  return { id };
}));

app.post('/api/notices/:id/ack', route((req) => {
  const notice = get(`SELECT n.* FROM notices n JOIN members m ON m.group_id = n.group_id
                      WHERE n.id = ? AND m.user_id = ?`, Number(req.params.id), req.user.id);
  if (!notice) fail(404, 'Notice not found.');
  run('INSERT OR IGNORE INTO acks (notice_id, user_id, at) VALUES (?, ?, ?)', notice.id, req.user.id, Date.now());
  notifyGroup(notice.group_id);
}));

// Everything assigned to me, across all groups: open tasks plus ones finished today.
app.get('/api/today', route((req) => {
  const since = Number(req.query.since) || 0;
  return {
    tasks: all(`SELECT t.*, g.name AS groupName, u.name AS fromName
                FROM tasks t JOIN chat_groups g ON g.id = t.group_id
                JOIN members m ON m.group_id = t.group_id AND m.user_id = t.assignee_id
                JOIN users u ON u.id = t.created_by
                WHERE t.assignee_id = ? AND (t.done_at IS NULL OR t.done_at >= ?)
                ORDER BY t.done_at IS NOT NULL, t.due IS NULL, t.due, t.id`, req.user.id, since),
  };
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  const user = token && get('SELECT id FROM users WHERE token = ?', token);
  if (!user) return ws.close();
  if (!sockets.has(user.id)) sockets.set(user.id, new Set());
  sockets.get(user.id).add(ws);
  ws.on('close', () => {
    const set = sockets.get(user.id);
    if (set) { set.delete(ws); if (!set.size) sockets.delete(user.id); }
  });
  ws.on('error', () => {});
});

server.listen(PORT, () => console.log(`App running at http://localhost:${PORT}`));
