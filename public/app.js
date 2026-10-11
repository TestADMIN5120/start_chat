'use strict';
// Chat app with built-in tasks: the phone web app.
// Two modes per person: "chat" (simple) and "advanced" (tasks, notices, summary).

const root = document.getElementById('app');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
};

const S = {
  token: store.get('token'),
  me: null,
  view: { name: 'chats' },
  groups: [],
  group: null,      // details of the open group
  today: [],
  sel: null,        // message picked to turn into a task
  showMembers: false,
  toast: '',
};

// ---------- small helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
const val = (key) => { const el = root.querySelector(`[data-k="${key}"]`); return el ? el.value.trim() : ''; };
const clear = (...keys) => keys.forEach((key) => { const el = root.querySelector(`[data-k="${key}"]`); if (el) el.value = ''; });
const startOfDay = () => new Date().setHours(0, 0, 0, 0);
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtDay(ms) {
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) return 'today';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
const fmtWhen = (ms) => `${fmtDay(ms)}, ${fmtTime(ms)}`;
const listTime = (ms) => (fmtDay(ms) === 'today' ? fmtTime(ms) : fmtDay(ms));

let toastTimer;
function toast(msg) {
  S.toast = msg; render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.toast = ''; render(); }, 3500);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, S.token ? { Authorization: `Bearer ${S.token}` } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) { signOut(); throw new Error(data.error || 'Signed out'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
// Run an action and show any problem to the person instead of failing silently.
const act = (fn) => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message); } };

// ---------- data ----------
async function loadGroups() { S.groups = (await api('GET', '/api/groups')).groups; }
async function loadGroup(id) { S.group = await api('GET', `/api/groups/${id}`); }
async function loadToday() { S.today = (await api('GET', `/api/today?since=${startOfDay()}`)).tasks; }

async function refresh() {
  if (!S.me) return;
  const jobs = [loadGroups()];
  if (S.view.name === 'group') jobs.push(loadGroup(S.view.id));
  if (S.view.name === 'today') jobs.push(loadToday());
  await Promise.all(jobs);
  render();
}

const go = act(async (view) => {
  S.view = view; S.sel = null; S.showMembers = false;
  if (view.name === 'group') S.group = null;
  render();
  await refresh();
  if (view.name === 'group') scrollChat(true);
});

// ---------- live updates ----------
let socket;
function connect() {
  if (!S.token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws?token=${S.token}`);
  socket.onmessage = () => { refresh().catch(() => {}); };
  socket.onclose = () => { if (S.token) setTimeout(connect, 2000); };
  socket.onopen = () => { refresh().catch(() => {}); };
}

function signOut() {
  S.token = null; S.me = null; store.set('token', null);
  if (socket) socket.close();
  S.view = { name: 'chats' };
  render();
}

// ---------- actions ----------
const signIn = act(async () => {
  const data = await api('POST', '/api/login', { name: val('name'), phone: val('phone') });
  S.token = data.token; S.me = data.user; store.set('token', data.token);
  connect();
  await go({ name: 'chats' });
});

const setMode = act(async (mode) => {
  S.me.mode = (await api('POST', '/api/mode', { mode })).mode;
  render();
});

const createGroup = act(async () => {
  const phones = val('g-phones').split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
  const data = await api('POST', '/api/groups', { name: val('g-name'), phones });
  await go({ name: 'group', id: data.id });
  if (data.notFound.length) toast(`Not on the app yet: ${data.notFound.join(', ')}. Add them once they join.`);
});

const addMember = act(async () => {
  await api('POST', `/api/groups/${S.view.id}/members`, { phone: val('m-phone') });
  clear('m-phone');
});

const sendMessage = act(async () => {
  const text = val('msg');
  if (!text) return;
  clear('msg');
  await api('POST', `/api/groups/${S.view.id}/messages`, { text });
  scrollChat(true);
});

const createTask = act(async (prefix, title) => {
  const dueText = val(`${prefix}-due`);
  await api('POST', `/api/groups/${S.view.id}/tasks`, {
    title: title || val(`${prefix}-title`),
    assigneeId: Number(val(`${prefix}-who`)),
    due: dueText ? new Date(dueText).getTime() : null,
  });
  clear(`${prefix}-title`, `${prefix}-due`);
  S.sel = null;
  render();
});

const setDone = act(async (task, done) => { await api('POST', `/api/tasks/${task.id}/done`, { done }); });

const postNotice = act(async () => {
  await api('POST', `/api/groups/${S.view.id}/notices`, { title: val('n-title'), body: val('n-body') });
  clear('n-title', 'n-body');
});

const ackNotice = act(async (notice) => { await api('POST', `/api/notices/${notice.id}/ack`); });

// ---------- shared pieces ----------
function nameOf(id) {
  if (id === S.me.id) return 'You';
  const m = S.group && S.group.members.find((x) => x.id === id);
  return m ? m.name : 'Someone';
}

function field(label, key, attrs, tag) {
  return h('div', { class: 'field' },
    h('label', { for: key }, label),
    h(tag || 'input', Object.assign({ id: key, 'data-k': key }, attrs)));
}

function whoField(key) {
  return h('div', { class: 'field' },
    h('label', { for: key }, 'Who will do it'),
    h('select', { id: key, 'data-k': key },
      S.group.members.map((m) => h('option', { value: m.id, selected: m.id === S.me.id }, m.id === S.me.id ? 'Me' : m.name))));
}

function taskStatus(t) {
  if (t.done_at) return h('span', { class: 'pill' }, 'Done');
  if (t.due && t.due < Date.now()) return h('span', { class: 'pill warn' }, 'Overdue');
  return h('span', { class: 'pill warn' }, 'Pending');
}

function taskMeta(t) {
  const parts = [`For ${nameOf(t.assignee_id)}`];
  if (t.done_at) parts.push(`finished ${fmtWhen(t.done_at)}`);
  else if (t.due) parts.push(`due ${fmtWhen(t.due)}`);
  parts.push(`from ${nameOf(t.created_by)}`);
  return parts.join(' · ');
}

function taskCard(t, extraClass) {
  const mine = t.assignee_id === S.me.id || t.created_by === S.me.id;
  return h('div', { class: `card ${extraClass || ''}` },
    h('div', { class: 'head' }, h('span', { class: 'cap' }, 'Task'), taskStatus(t)),
    h('div', { class: `title ${t.done_at ? 'done' : ''}` }, t.title),
    h('div', { class: 'meta' }, taskMeta(t)),
    mine && h('div', { class: 'actions' },
      t.done_at
        ? h('button', { class: 'btn ghost small', onclick: () => setDone(t, false) }, 'Reopen')
        : h('button', { class: 'btn small', onclick: () => setDone(t, true) }, 'Mark done')));
}

function noticeCard(n, extraClass, full) {
  const others = S.group.members.filter((m) => m.id !== n.created_by);
  const acked = new Set(n.acks.map((a) => a.user_id));
  const waiting = others.filter((m) => !acked.has(m.id));
  const needsMe = n.created_by !== S.me.id && !acked.has(S.me.id);
  return h('div', { class: `card ${extraClass || ''}` },
    h('div', { class: 'head' },
      h('span', { class: 'cap' }, `Notice from ${nameOf(n.created_by)}`),
      h('span', { class: `pill ${waiting.length ? 'warn' : ''}` }, `${others.length - waiting.length} of ${others.length} read`)),
    h('div', { class: 'title' }, n.title),
    n.body && h('div', {}, n.body),
    full && waiting.length > 0 && h('div', { class: 'meta' }, `Not yet: ${waiting.map((m) => nameOf(m.id)).join(', ')}`),
    needsMe && h('div', { class: 'actions' },
      h('button', { class: 'btn small', onclick: () => ackNotice(n) }, 'I have read this')));
}

function bottomNav(current) {
  const item = (name, label) => h('button', {
    class: current === name ? 'on' : '', 'aria-current': current === name ? 'page' : null,
    onclick: () => go({ name }),
  }, label);
  return h('nav', { class: 'nav', 'aria-label': 'Main' }, item('chats', 'Chats'), item('today', 'Today'));
}

// ---------- screens ----------
function viewLogin() {
  return h('div', { class: 'screen' },
    h('div', { class: 'pad', style: 'margin-top: 48px' },
      h('h1', { style: 'font-family: Sora, sans-serif; font-size: 30px' }, 'Welcome'),
      h('p', { class: 'sub', style: 'font-size: 16px' }, 'Chat with your groups and keep track of who is doing what.'),
      field('Your name', 'name', { type: 'text', autocomplete: 'name' }),
      field('Phone number', 'phone', { type: 'tel', autocomplete: 'tel', inputmode: 'tel' }),
      h('button', { class: 'btn wide', onclick: signIn }, 'Continue')));
}

function viewChats() {
  const adv = S.me.mode === 'advanced';
  const waiting = S.groups.reduce((n, g) => n + g.openMine, 0);
  const modeBtn = (mode, label) => h('button', {
    class: S.me.mode === mode ? 'on' : '', 'aria-pressed': String(S.me.mode === mode),
    onclick: () => setMode(mode),
  }, label);
  const row = (g) => h('button', { class: 'row', onclick: () => go({ name: 'group', id: g.id }) },
    h('div', { class: 'avatar' }, initials(g.name)),
    h('div', { class: 'body' },
      h('div', { class: 'line1' },
        h('span', { class: 'name' }, g.name),
        g.last && h('span', { class: 'sub' }, listTime(g.last.created_at))),
      h('div', { class: 'last' }, g.last ? `${g.last.name ? `${g.last.name}: ` : ''}${g.last.text}` : 'No messages yet'),
      adv && g.openAll > 0 && h('span', { class: 'pill warn' }, plural(g.openAll, 'open task'))));
  return h('div', { class: 'screen' },
    h('header', { class: 'top' },
      h('h1', {}, 'Chats'),
      h('button', { class: 'btn dark small', onclick: () => go({ name: 'newgroup' }) }, '+ New group')),
    h('div', { class: 'seg' }, modeBtn('chat', 'Chat mode'), modeBtn('advanced', 'Advanced mode')),
    adv && h('button', { class: 'banner', onclick: () => go({ name: 'today' }) },
      h('span', { class: 'cap' }, 'Today'),
      h('strong', {}, waiting ? `${plural(waiting, 'task')} waiting for you` : 'Nothing waiting for you')),
    h('div', { class: 'list' },
      S.groups.length ? S.groups.map(row) : h('p', { class: 'empty' }, 'No chats yet. Create a group to start.'),
      h('button', { class: 'link', onclick: signOut }, `Signed in as ${S.me.name} · Sign out`)),
    adv && bottomNav('chats'));
}

function viewNewGroup() {
  return h('div', { class: 'screen' },
    h('header', { class: 'top bar' },
      h('button', { class: 'icon', 'aria-label': 'Back to chats', onclick: () => go({ name: 'chats' }) }, '‹'),
      h('h1', {}, 'New group')),
    h('div', { class: 'scroll' }, h('div', { class: 'pad' },
      field('Group name', 'g-name', { type: 'text', placeholder: 'For example: Shop team' }),
      field('Phone numbers to add', 'g-phones', { placeholder: 'One number per line. They must have signed in to the app once.' }, 'textarea'),
      h('button', { class: 'btn wide', onclick: createGroup }, 'Create group'))));
}

function chatTab(g, adv) {
  const items = [];
  for (const m of g.messages) {
    const me = m.user_id === S.me.id;
    if (m.kind === 'system') {
      items.push(h('div', { class: 'sys' }, `${m.text} · ${fmtTime(m.created_at)}`));
    } else if (m.kind === 'task') {
      const t = g.tasks.find((x) => x.id === m.ref_id);
      items.push(t ? taskCard(t, `in-chat ${me ? 'me' : ''}`)
        : h('div', { class: 'sys' }, `Task: ${m.text} (finished earlier)`));
    } else if (m.kind === 'notice') {
      const n = g.notices.find((x) => x.id === m.ref_id);
      if (n) items.push(noticeCard(n, `in-chat ${me ? 'me' : ''}`, false));
    } else {
      const picked = S.sel === m.id;
      items.push(h(adv ? 'button' : 'div', {
        class: `bubble ${me ? 'me' : ''} ${picked ? 'sel' : ''}`,
        onclick: adv ? () => { S.sel = picked ? null : m.id; render(); } : null,
        'aria-expanded': adv ? String(picked) : null,
      },
        !me && h('span', { class: 'who' }, nameOf(m.user_id)),
        h('span', {}, m.text),
        h('span', { class: 'time' }, fmtTime(m.created_at))));
      if (adv && picked) {
        items.push(h('div', { class: 'card inline-form' },
          h('span', { class: 'cap' }, 'Make this a task'),
          whoField('q-who'),
          field('Due (optional)', 'q-due', { type: 'datetime-local' }),
          h('button', { class: 'btn', onclick: () => createTask('q', m.text) }, 'Create task')));
      }
    }
  }
  return [
    h('div', { class: 'msgs', id: 'msgs' },
      items.length ? items : h('p', { class: 'empty' }, 'Say hello to start the chat.'),
      adv && items.length > 0 && S.sel == null && h('div', { class: 'sys' }, 'Tip: tap a message to turn it into a task.')),
    h('div', { class: 'composer' },
      h('label', { for: 'msg', style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)' }, 'Message'),
      h('input', { id: 'msg', 'data-k': 'msg', type: 'text', placeholder: 'Message', autocomplete: 'off',
        onkeydown: (e) => { if (e.key === 'Enter') sendMessage(); } }),
      h('button', { class: 'btn', onclick: sendMessage }, 'Send')),
  ];
}

function tasksTab(g) {
  const open = g.tasks.filter((t) => !t.done_at);
  const done = g.tasks.filter((t) => t.done_at);
  return h('div', { class: 'scroll' }, h('div', { class: 'pad' },
    h('div', { class: 'card' },
      h('span', { class: 'cap' }, 'New task'),
      field('What needs doing', 't-title', { type: 'text' }),
      whoField('t-who'),
      field('Due (optional)', 't-due', { type: 'datetime-local' }),
      h('button', { class: 'btn', onclick: () => createTask('t') }, 'Add task')),
    h('h2', { class: 'cap' }, `Open (${open.length})`),
    open.length ? open.map((t) => taskCard(t)) : h('p', { class: 'sub' }, 'No open tasks.'),
    done.length > 0 && h('h2', { class: 'cap' }, 'Finished this week'),
    done.map((t) => taskCard(t))));
}

function noticesTab(g) {
  return h('div', { class: 'scroll' }, h('div', { class: 'pad' },
    h('div', { class: 'card' },
      h('span', { class: 'cap' }, 'New notice'),
      field('Title', 'n-title', { type: 'text' }),
      field('Details (optional)', 'n-body', {}, 'textarea'),
      h('button', { class: 'btn', onclick: postNotice }, 'Send to everyone')),
    g.notices.length ? g.notices.map((n) => noticeCard(n, '', true))
      : h('p', { class: 'sub' }, 'No notices yet. A notice is a message everyone must confirm they have read.')));
}

function summaryTab(g) {
  const since = startOfDay();
  const done = g.tasks.filter((t) => t.done_at && t.done_at >= since);
  const pending = g.tasks.filter((t) => !t.done_at);
  return h('div', { class: 'scroll' }, h('div', { class: 'pad' },
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, done.length), 'Done today'),
      h('div', { class: 'stat warn' }, h('b', {}, pending.length), 'Still pending')),
    pending.length > 0 && h('h2', { class: 'cap' }, 'Still pending'),
    pending.map((t) => taskCard(t)),
    done.length > 0 && h('h2', { class: 'cap' }, 'Done today'),
    done.map((t) => taskCard(t))));
}

function viewGroup() {
  const g = S.group;
  const back = h('button', { class: 'icon', 'aria-label': 'Back to chats', onclick: () => go({ name: 'chats' }) }, '‹');
  if (!g) return h('div', { class: 'screen' }, h('header', { class: 'top bar' }, back, h('h1', {}, 'Loading')));
  const adv = S.me.mode === 'advanced';
  const tab = adv ? (S.view.tab || 'chat') : 'chat';
  const tabBtn = (name, label) => h('button', {
    class: tab === name ? 'on' : '', 'aria-pressed': String(tab === name),
    onclick: () => { S.view.tab = name; S.sel = null; render(); if (name === 'chat') scrollChat(true); },
  }, label);
  const openCount = g.tasks.filter((t) => !t.done_at).length;
  return h('div', { class: 'screen' },
    h('header', { class: 'top bar' },
      back,
      h('div', { class: 'avatar', style: 'width:40px;height:40px;border-radius:13px' }, initials(g.group.name)),
      h('div', { style: 'flex:1;min-width:0' },
        h('h1', {}, g.group.name),
        h('div', { class: 'sub' }, plural(g.members.length, 'member'))),
      h('button', { class: 'btn ghost small', 'aria-expanded': String(S.showMembers),
        onclick: () => { S.showMembers = !S.showMembers; render(); } }, 'People')),
    S.showMembers && h('div', { class: 'pad', style: 'background: var(--card); border-bottom: 1px solid var(--line)' },
      h('div', { class: 'sub', style: 'font-size:15px' }, g.members.map((m) => nameOf(m.id)).join(', ')),
      field('Add someone by phone number', 'm-phone', { type: 'tel', inputmode: 'tel' }),
      h('button', { class: 'btn ghost', onclick: addMember }, 'Add to group')),
    adv && h('div', { class: 'tabs' },
      tabBtn('chat', 'Chat'), tabBtn('tasks', openCount ? `Tasks · ${openCount}` : 'Tasks'),
      tabBtn('notices', 'Notices'), tabBtn('summary', 'Summary')),
    tab === 'chat' ? chatTab(g, adv)
      : tab === 'tasks' ? tasksTab(g)
        : tab === 'notices' ? noticesTab(g) : summaryTab(g));
}

function viewToday() {
  const done = S.today.filter((t) => t.done_at).length;
  const row = (t) => h('div', { class: 'card', style: 'padding:0' }, h('div', { class: 'task-row' },
    h('button', { class: `check ${t.done_at ? 'on' : ''}`, 'aria-pressed': String(!!t.done_at),
      'aria-label': `${t.done_at ? 'Reopen' : 'Mark done'}: ${t.title}`, onclick: () => setDone(t, !t.done_at) },
      h('span', {}, t.done_at ? '✓' : '')),
    h('button', { class: 'row', style: 'padding:6px 0', onclick: () => go({ name: 'group', id: t.group_id }) },
      h('div', { class: 'body' },
        h('div', { class: `title ${t.done_at ? 'done' : ''}`, style: 'font-weight:700' }, t.title),
        h('div', { class: 'sub', style: 'font-size:14px' },
          [t.groupName, t.due ? `due ${fmtWhen(t.due)}` : null, t.created_by === S.me.id ? null : `from ${t.fromName}`]
            .filter(Boolean).join(' · '))))));
  return h('div', { class: 'screen' },
    h('header', { class: 'top' }, h('div', { style: 'flex:1' },
      h('h1', {}, 'Today'),
      h('div', { class: 'sub', style: 'font-size:15px' }, 'Everything assigned to you, from all your groups'))),
    h('div', { class: 'scroll' }, h('div', { class: 'pad', style: 'padding-top:0' },
      S.today.length > 0 && h('div', { class: 'stat', style: 'background: var(--ink)' }, `${done} of ${S.today.length} done`),
      S.today.length ? S.today.map(row) : h('p', { class: 'empty' }, 'Nothing is assigned to you right now.'))),
    bottomNav('today'));
}

// ---------- drawing ----------
function scrollChat(force) {
  const el = document.getElementById('msgs');
  if (el && force) el.scrollTop = el.scrollHeight;
}

function render() {
  // Keep what the person is typing, and their place in the chat, across redraws.
  const kept = {};
  root.querySelectorAll('[data-k]').forEach((el) => { kept[el.getAttribute('data-k')] = el.value; });
  const focused = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-k');
  const oldMsgs = document.getElementById('msgs');
  const atBottom = oldMsgs ? oldMsgs.scrollHeight - oldMsgs.scrollTop - oldMsgs.clientHeight < 80 : true;
  const oldScroll = oldMsgs ? oldMsgs.scrollTop : 0;

  let screen;
  if (!S.me) screen = viewLogin();
  else if (S.view.name === 'group') screen = viewGroup();
  else if (S.view.name === 'newgroup') screen = viewNewGroup();
  else if (S.view.name === 'today' && S.me.mode === 'advanced') screen = viewToday();
  else screen = viewChats();
  root.replaceChildren(screen, S.toast ? h('div', { class: 'toast', role: 'status' }, S.toast) : '');

  root.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.getAttribute('data-k');
    if (kept[k] != null && kept[k] !== '') el.value = kept[k];
  });
  if (focused) { const el = root.querySelector(`[data-k="${focused}"]`); if (el) el.focus(); }
  const msgs = document.getElementById('msgs');
  if (msgs) msgs.scrollTop = atBottom ? msgs.scrollHeight : oldScroll;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ---------- start ----------
(async function start() {
  render();
  if (!S.token) return;
  try {
    S.me = (await api('GET', '/api/me')).user;
    connect();
    await refresh();
  } catch (e) { render(); }
})();
