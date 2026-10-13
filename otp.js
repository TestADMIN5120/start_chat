'use strict';
// Phone sign-in via MSG91 OTP. Disabled (instant sign-in) unless
// MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are set — see server.js for the fallback.

const AUTH_KEY = process.env.MSG91_AUTH_KEY;
const TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID;
const enabled = Boolean(AUTH_KEY && TEMPLATE_ID);

if (!enabled) {
  console.warn('OTP disabled: set MSG91_AUTH_KEY and MSG91_TEMPLATE_ID to require SMS codes at sign-in.');
}

const PENDING_TTL_MS = 10 * 60 * 1000; // how long a "new user" name is remembered while they enter the code
const pendingNames = new Map(); // phone -> { name, expires }

function rememberName(phone, name) {
  if (name) pendingNames.set(phone, { name, expires: Date.now() + PENDING_TTL_MS });
}

function takeName(phone) {
  const entry = pendingNames.get(phone);
  pendingNames.delete(phone);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.name;
}

async function send(phone, name) {
  rememberName(phone, name);
  const url = `https://control.msg91.com/api/v5/otp?template_id=${encodeURIComponent(TEMPLATE_ID)}&mobile=${encodeURIComponent(phone)}`;
  const res = await fetch(url, { method: 'POST', headers: { authkey: AUTH_KEY } });
  const data = await res.json().catch(() => ({}));
  if (data.type !== 'success') {
    const err = new Error(data.message || 'Could not send the code. Try again.');
    err.status = 502;
    throw err;
  }
}

async function verify(phone, code) {
  const url = `https://control.msg91.com/api/v5/otp/verify?mobile=${encodeURIComponent(phone)}&otp=${encodeURIComponent(code)}`;
  const res = await fetch(url, { headers: { authkey: AUTH_KEY } });
  const data = await res.json().catch(() => ({}));
  if (data.type !== 'success') {
    const err = new Error(data.message || 'That code is not right.');
    err.status = 400;
    throw err;
  }
  return takeName(phone);
}

module.exports = { enabled, send, verify };
