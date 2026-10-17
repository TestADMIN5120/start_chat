'use strict';
// Phone sign-in via MSG91 OTP. Falls back to a local dev OTP (printed to the
// server console, no SMS sent) unless MSG91_AUTH_KEY and MSG91_TEMPLATE_ID
// are set. Sign-in only skips verification entirely if DEV_OTP=off.

const crypto = require('crypto');

const AUTH_KEY = process.env.MSG91_AUTH_KEY;
const TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID;
const useMsg91 = Boolean(AUTH_KEY && TEMPLATE_ID);
const enabled = useMsg91 || process.env.DEV_OTP !== 'off';

if (!useMsg91) {
  console.warn(enabled
    ? 'MSG91 not configured: using dev OTP (codes are printed to this console, no SMS sent).'
    : 'OTP disabled: set MSG91_AUTH_KEY and MSG91_TEMPLATE_ID, or unset DEV_OTP, to require a code at sign-in.');
}

const PENDING_TTL_MS = 10 * 60 * 1000; // how long a "new user" name is remembered while they enter the code
const pendingNames = new Map(); // phone -> { name, expires }
const pendingCodes = new Map(); // phone -> { code, expires }, dev OTP only

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
  if (!useMsg91) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    pendingCodes.set(phone, { code, expires: Date.now() + PENDING_TTL_MS });
    console.log(`[dev OTP] code for ${phone}: ${code}`);
    return;
  }
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
  if (!useMsg91) {
    const entry = pendingCodes.get(phone);
    if (!entry || entry.expires < Date.now() || entry.code !== code) fail(400, 'That code is not right.');
    pendingCodes.delete(phone);
    return takeName(phone);
  }
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

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

module.exports = { enabled, send, verify };
