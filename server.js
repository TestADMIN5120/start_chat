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

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_FILE || path.join(__dirname, 'data.db');
console.log(`Using database: ${DB_PATH}`);
const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'chat', token TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS chat_groups (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL,
  is_direct INTEGER NOT NULL DEFAULT 0);
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

function ensureColumn(table, column, ddl) {
  if (!all(`PRAGMA table_info(${table})`).some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('messages', 'edited_at', 'edited_at INTEGER');
ensureColumn('messages', 'deleted_at', 'deleted_at INTEGER');
ensureColumn('chat_groups', 'is_direct', 'is_direct INTEGER NOT NULL DEFAULT 0');

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

function sendTo(userId, payload) {
  const set = sockets.get(userId);
  if (!set || !set.size) return false;
  const msg = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === 1) ws.send(msg);
  return true;
}

// ---------- group meetings (mesh calls, up to MAX_PARTICIPANTS) ----------
// In-memory only: a meeting does not survive a server restart, which is fine
// since calls are live and nothing about them needs to be durable.
const MAX_PARTICIPANTS = 4;
const meetings = new Map(); // meetingId -> { groupId, participants: Set<userId>, invited: Set<userId> }
const meetingByGroup = new Map(); // groupId -> meetingId

function meetingRosterPayload(meeting) {
  const named = (id) => { const u = get('SELECT id, name FROM users WHERE id = ?', id); return u ? { id: u.id, name: u.name } : null; };
  return {
    participants: [...meeting.participants].map(named).filter(Boolean),
    invited: [...meeting.invited].map(named).filter(Boolean),
  };
}

function broadcastRoster(meetingId) {
  const meeting = meetings.get(meetingId);
  if (!meeting) return;
  const payload = Object.assign({ type: 'meeting-roster', meetingId }, meetingRosterPayload(meeting));
  for (const id of new Set([...meeting.participants, ...meeting.invited])) sendTo(id, payload);
}

function endMeetingIfEmpty(meetingId) {
  const meeting = meetings.get(meetingId);
  if (!meeting) return;
  if (meeting.participants.size === 0) {
    meetings.delete(meetingId);
    if (meetingByGroup.get(meeting.groupId) === meetingId) meetingByGroup.delete(meeting.groupId);
    notifyGroup(meeting.groupId);
  }
}

function leaveMeeting(meetingId, userId) {
  const meeting = meetings.get(meetingId);
  if (!meeting) return;
  const was = meeting.participants.has(userId) || meeting.invited.has(userId);
  meeting.participants.delete(userId);
  meeting.invited.delete(userId);
  if (was) broadcastRoster(meetingId);
  endMeetingIfEmpty(meetingId);
}

// 1:1/mesh call signaling, relayed per-pair, only between people currently in the same meeting.
const CALL_TYPES = new Set(['call-offer', 'call-answer', 'call-ice-candidate']);

function addMessage(groupId, userId, kind, text, refId) {
  insert('INSERT INTO messages (group_id, user_id, kind, text, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    groupId, userId, kind, text, refId || null, Date.now());
}

// ---------- web server ----------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const route = (fn) => (req, res, next) => {
  try { res.json(fn(req) || { ok: true }); } catch (err) { next(err); }
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

// Sign in. NOTE: there is no SMS code check yet, so anyone who knows a phone
// number can sign in as that person. Add OTP verification before public use.
app.post('/api/login', route((req) => {
  const name = cleanText(req.body.name, 40);
  const phone = cleanPhone(req.body.phone);
  if (phone.length < 8 || phone.length > 15) fail(400, 'Enter a valid phone number.');
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

function directChatName(groupId, selfId) {
  const other = get(`SELECT u.name FROM users u JOIN members m ON m.user_id = u.id
                     WHERE m.group_id = ? AND m.user_id != ?`, groupId, selfId);
  return other ? other.name : null;
}

app.get('/api/groups', route((req) => {
  const groups = all(`
    SELECT g.id, g.name, g.is_direct AS isDirect,
      (SELECT COUNT(*) FROM members WHERE group_id = g.id) AS memberCount,
      (SELECT COUNT(*) FROM tasks WHERE group_id = g.id AND done_at IS NULL) AS openAll,
      (SELECT COUNT(*) FROM tasks WHERE group_id = g.id AND done_at IS NULL AND assignee_id = ?) AS openMine
    FROM chat_groups g JOIN members m ON m.group_id = g.id
    WHERE m.user_id = ?`, req.user.id, req.user.id);
  for (const g of groups) {
    if (g.isDirect) g.name = directChatName(g.id, req.user.id) || g.name;
    const last = get(`SELECT m.text, m.kind, m.created_at, m.deleted_at, u.name FROM messages m
                      LEFT JOIN users u ON u.id = m.user_id
                      WHERE m.group_id = ? ORDER BY m.id DESC LIMIT 1`, g.id);
    g.last = last ? { ...last, text: last.deleted_at ? 'Message deleted' : last.text } : null;
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

// Add a contact: find-or-create a 1:1 direct chat with that phone number.
app.post('/api/contacts', route((req) => {
  const phone = cleanPhone(req.body.phone);
  if (phone.length < 8 || phone.length > 15) fail(400, 'Enter a valid phone number.');
  const other = get('SELECT * FROM users WHERE phone = ?', phone);
  if (!other) fail(404, 'That number has not joined the app yet.');
  if (other.id === req.user.id) fail(400, "That's your own number.");

  const existing = get(`
    SELECT g.id FROM chat_groups g
    JOIN members m1 ON m1.group_id = g.id AND m1.user_id = ?
    JOIN members m2 ON m2.group_id = g.id AND m2.user_id = ?
    WHERE g.is_direct = 1`, req.user.id, other.id);
  if (existing) return { id: existing.id };

  const id = insert('INSERT INTO chat_groups (name, created_by, created_at, is_direct) VALUES (?, ?, ?, 1)',
    other.name, req.user.id, Date.now());
  run('INSERT INTO members (group_id, user_id) VALUES (?, ?)', id, req.user.id);
  run('INSERT INTO members (group_id, user_id) VALUES (?, ?)', id, other.id);
  return { id };
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
  const activeMeetingId = meetingByGroup.get(group.id);
  const activeMeeting = activeMeetingId ? meetings.get(activeMeetingId) : null;
  const name = group.is_direct ? (directChatName(group.id, req.user.id) || group.name) : group.name;
  return {
    group: { id: group.id, name, isDirect: !!group.is_direct },
    members: all(`SELECT u.id, u.name FROM users u JOIN members m ON m.user_id = u.id
                  WHERE m.group_id = ? ORDER BY u.name`, group.id),
    messages,
    tasks: all(`SELECT * FROM tasks WHERE group_id = ? AND (done_at IS NULL OR done_at > ?)
                ORDER BY done_at IS NOT NULL, due IS NULL, due, id`, group.id, weekAgo),
    notices,
    activeMeeting: activeMeeting ? { meetingId: activeMeetingId, participantCount: activeMeeting.participants.size } : null,
  };
}));

app.post('/api/groups/:id/messages', route((req) => {
  const group = memberGroup(req);
  const text = cleanText(req.body.text, 4000);
  if (!text) fail(400, 'Type a message first.');
  addMessage(group.id, req.user.id, 'text', text);
  notifyGroup(group.id);
}));

function ownedTextMessage(req) {
  const id = Number(req.params.id);
  const msg = get('SELECT * FROM messages WHERE id = ?', id);
  if (!msg || msg.kind !== 'text' || msg.deleted_at) fail(404, 'Message not found.');
  if (msg.user_id !== req.user.id) fail(403, 'You can only change your own messages.');
  if (!get('SELECT 1 AS ok FROM members WHERE group_id = ? AND user_id = ?', msg.group_id, req.user.id)) {
    fail(404, 'Message not found.');
  }
  return msg;
}

app.put('/api/messages/:id', route((req) => {
  const msg = ownedTextMessage(req);
  const text = cleanText(req.body.text, 4000);
  if (!text) fail(400, 'Type a message first.');
  run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', text, Date.now(), msg.id);
  notifyGroup(msg.group_id);
}));

app.delete('/api/messages/:id', route((req) => {
  const msg = ownedTextMessage(req);
  run('UPDATE messages SET deleted_at = ? WHERE id = ?', Date.now(), msg.id);
  notifyGroup(msg.group_id);
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
  const user = token && get('SELECT id, name FROM users WHERE token = ?', token);
  if (!user) return ws.close();
  if (!sockets.has(user.id)) sockets.set(user.id, new Set());
  sockets.get(user.id).add(ws);
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'meeting-start') {
      const groupId = Number(msg.groupId);
      if (!get('SELECT 1 AS ok FROM members WHERE group_id = ? AND user_id = ?', groupId, user.id)) return;
      let meetingId = meetingByGroup.get(groupId);
      let meeting = meetingId && meetings.get(meetingId);
      if (!meeting) {
        meetingId = crypto.randomBytes(8).toString('hex');
        meeting = { groupId, participants: new Set(), invited: new Set() };
        meetings.set(meetingId, meeting);
        meetingByGroup.set(groupId, meetingId);
      }
      meeting.participants.add(user.id);
      const invitees = Array.isArray(msg.inviteeIds) ? msg.inviteeIds.map(Number) : [];
      for (const id of invitees) {
        if (id !== user.id && !meeting.participants.has(id) && meeting.participants.size + meeting.invited.size < MAX_PARTICIPANTS) {
          meeting.invited.add(id);
        }
      }
      sendTo(user.id, Object.assign({ type: 'meeting-join-ok', meetingId, groupId }, meetingRosterPayload(meeting)));
      broadcastRoster(meetingId);
      for (const id of invitees) {
        if (meeting.invited.has(id)) sendTo(id, { type: 'meeting-invite', meetingId, groupId, from: user.id, fromName: user.name });
      }
      notifyGroup(groupId);
      return;
    }

    if (msg.type === 'meeting-join') {
      const meeting = meetings.get(msg.meetingId);
      if (!meeting) return;
      if (!get('SELECT 1 AS ok FROM members WHERE group_id = ? AND user_id = ?', meeting.groupId, user.id)) return;
      if (!meeting.participants.has(user.id) && meeting.participants.size >= MAX_PARTICIPANTS) {
        sendTo(user.id, { type: 'meeting-full', meetingId: msg.meetingId });
        return;
      }
      meeting.invited.delete(user.id);
      meeting.participants.add(user.id);
      sendTo(user.id, Object.assign({ type: 'meeting-join-ok', meetingId: msg.meetingId, groupId: meeting.groupId }, meetingRosterPayload(meeting)));
      broadcastRoster(msg.meetingId);
      notifyGroup(meeting.groupId);
      return;
    }

    if (msg.type === 'meeting-leave' || msg.type === 'meeting-decline') {
      leaveMeeting(msg.meetingId, user.id);
      return;
    }

    if (msg.type === 'meeting-screen-share') {
      const meeting = meetings.get(msg.meetingId);
      if (!meeting || !meeting.participants.has(user.id)) return;
      const payload = { type: 'meeting-screen-share', meetingId: msg.meetingId, from: user.id, sharing: !!msg.sharing };
      for (const id of meeting.participants) if (id !== user.id) sendTo(id, payload);
      return;
    }

    if (CALL_TYPES.has(msg.type)) {
      const to = Number(msg.to);
      if (!to || to === user.id) return;
      const meeting = meetings.get(msg.meetingId);
      if (!meeting || !meeting.participants.has(user.id) || !meeting.participants.has(to)) return;
      const out = { type: msg.type, from: user.id, fromName: user.name, to, meetingId: msg.meetingId };
      if (msg.sdp) out.sdp = msg.sdp;
      if (msg.candidate) out.candidate = msg.candidate;
      sendTo(to, out);
    }
  });
  ws.on('close', () => {
    const set = sockets.get(user.id);
    if (set) { set.delete(ws); if (!set.size) sockets.delete(user.id); }
    if (!set || !set.size) {
      for (const meetingId of [...meetings.keys()]) leaveMeeting(meetingId, user.id);
    }
  });
  ws.on('error', () => {});
});

server.listen(PORT, () => console.log(`App running at http://localhost:${PORT}`));
