/* BusVerify PH - demo app. All data lives in this browser's localStorage.

   Data model (DB_VERSION 2). Every timestamp is an ISO-8601 UTC string, so values
   sort, compare and convert with Date.parse() and survive time-zone changes.

   bus: {
     id, operatorId, plate, make, seats (number), route, note, qr,
     status: 'pending' | 'approved' | 'correction',
     createdAt, updatedAt, submittedAt, reviewedAt, reviewedBy,
     approvedAt, validUntil,          // validUntil = when the approval lapses
     lastScan: { at, by },
     docs: { [key]: { file, expiry: 'YYYY-MM-DD', expiresAt, updatedAt } },
     history: [{ at, msg }]
   }
   - doc.expiresAt     end of the expiry day (local time) as an instant
   - bus.validUntil    earliest of (approvedAt + APPROVAL_TTL_DAYS, every doc.expiresAt)
   - session           { uid, at, exp } so a login also expires
   The "effective" status (adds 'expired' when validUntil has passed) is derived by
   analyze() and never stored, so it can never go stale. */
(() => {
'use strict';
const $ = s => document.querySelector(s);

/* ---------- Config ---------- */
const DB_KEY = 'bv_db', SES_KEY = 'bv_session', DB_VERSION = 2;
const APPROVAL_TTL_DAYS = 365;   // an approval lapses after this long, or sooner if a document expires
const EXPIRING_SOON_DAYS = 30;   // warning window before a document or approval ends
const SESSION_TTL_HOURS = 8;     // a login lasts this long
const HISTORY_LIMIT = 100;       // oldest history entries are dropped past this
const SCAN_LOG_GAP_MS = 60e3;    // repeat scans inside this window are not logged again
const DAY = 864e5, HOUR = 36e5, MAX_TIMEOUT = 2 ** 31 - 1;

const DOCS = [['cr', 'Certificate of Registration (CR)'], ['or', 'Official Receipt (OR)'], ['franchise', 'LTFRB Franchise / CPC'], ['insurance', 'Insurance (CTPL)'], ['emission', 'Emission Test']];
const ROLES = { operator: 'Bus Operator', superadmin: 'Super Admin', lto: 'LTO Officer' };
const ROLE_ICON = { operator: '🚌', superadmin: '🛡️', lto: '📷' };
const STATUS = { pending: 'Pending review', approved: 'Approved', correction: 'Needs correction', expired: 'Approval expired' };
const STATUS_BADGE = { approved: 'approved', pending: 'pending' };   // everything else uses the red badge
const DOC_LABEL = { valid: 'Valid', expiring: 'Expiring soon', expired: 'Expired / missing' };
const FILTERS = [['pending', 'Pending review'], ['correction', 'Needs correction'], ['approved', 'Approved'], ['expired', 'Approval expired'], ['all', 'All']];
const homeFor = u => '/' + (u.role === 'superadmin' ? 'admin' : u.role);

/* ---------- Small helpers ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const uid = () => hex(6);
const QR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no look-alike characters (0/O, 1/I/L)

/* Time. Never use toISOString().slice(0, 10) for "today": it is the UTC date,
   which is yesterday in the Philippines between 00:00 and 08:00. */
const nowISO = () => new Date().toISOString();
const ts = iso => (iso ? Date.parse(iso) : NaN);
const pad = n => String(n).padStart(2, '0');
const localYMD = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const endOfDay = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999); };
const validYMD = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && localYMD(endOfDay(s)) === s;   // rejects 2026-02-31
const fmtDate = d => d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '-';
const fmtTime = t => t ? new Date(t).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '-';

/* ---------- Data ---------- */
const seed = () => ({ v: DB_VERSION, users: [
  { id: 'u1', role: 'superadmin', name: 'Super Admin', email: 'admin@busverify.ph', password: 'admin123' },
  { id: 'u2', role: 'operator', name: 'Sample Bus Lines', email: 'operator@demo.ph', password: 'demo123' },
  { id: 'u3', role: 'lto', name: 'Officer Reyes', email: 'lto@demo.ph', password: 'demo123' }
], buses: [] });

function computeValidUntil(b, approvedMs) {
  let end = approvedMs + APPROVAL_TTL_DAYS * DAY;
  for (const [k] of DOCS) { const e = ts(b.docs[k]?.expiresAt); if (e < end) end = e; }   // NaN never wins
  return new Date(end).toISOString();
}

/* Upgrade data saved by older versions (epoch history times, no timestamps). */
function migrate(raw) {
  if (!raw || !Array.isArray(raw.users) || !Array.isArray(raw.buses)) throw new Error('bad shape');
  for (const b of raw.buses) {
    b.history = Array.isArray(b.history) ? b.history : [];
    for (const h of b.history) if (!h.at) { h.at = new Date(h.t || Date.now()).toISOString(); delete h.t; }
    const first = b.history[0]?.at || nowISO(), last = b.history.at(-1)?.at || first;
    b.createdAt ||= first; b.updatedAt ||= last; b.submittedAt ||= b.updatedAt;
    b.seats = Number(b.seats) || 0; b.note ||= ''; b.docs ||= {};
    for (const d of Object.values(b.docs)) if (d?.expiry) { d.expiresAt ||= endOfDay(d.expiry).toISOString(); d.updatedAt ||= b.updatedAt; }
    if (b.status === 'approved' && !b.validUntil) { b.approvedAt ||= last; b.validUntil = computeValidUntil(b, ts(b.approvedAt)); }
  }
  raw.v = DB_VERSION;
  return raw;
}
function loadDB() {
  let text = null;
  try { text = localStorage.getItem(DB_KEY); } catch { /* storage blocked */ }
  if (!text) return seed();
  try { return migrate(JSON.parse(text)); }
  catch {   // keep a copy instead of silently overwriting unreadable data
    try { localStorage.setItem(DB_KEY + '_corrupt', text); } catch { /* ignore */ }
    return seed();
  }
}

/* Lookup maps make every id / QR / plate lookup O(1) instead of a scan of the array. */
let busById, busByQr, busByPlate, userById;
function reindex() {
  busById = new Map(); busByQr = new Map(); busByPlate = new Map(); userById = new Map();
  for (const b of db.buses) { busById.set(b.id, b); busByPlate.set(b.plate, b); if (b.qr) busByQr.set(b.qr, b); }
  for (const u of db.users) userById.set(u.id, u);
}
let db = loadDB();
reindex();

/* Derived state is computed once per bus per render and cached. */
let cache = new WeakMap();
const resetCache = () => { cache = new WeakMap(); };
function save() {
  reindex(); resetCache();
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); return true; }
  catch { toast('Could not save data in this browser.', 'error'); return false; }
}
/* Save, and if storage refuses, throw away the unsaved in-memory change so the screen
   never shows (or later saves) data that was not actually stored. */
function commit() {
  if (save()) return true;
  db = loadDB(); reindex(); resetCache();
  return false;
}
const userName = id => userById.get(id)?.name || 'Unknown';
/* `at` lets an action stamp its history entry with the same instant as its other fields. */
const log = (b, msg, at = nowISO()) => {
  b.history.push({ at, msg });
  if (b.history.length > HISTORY_LIMIT) b.history.splice(0, b.history.length - HISTORY_LIMIT);
};

function docState(d, now) {
  const exp = ts(d?.expiresAt);
  if (!(exp >= now)) return 'expired';   // past, missing, or unreadable all fail closed
  return exp - now <= EXPIRING_SOON_DAYS * DAY ? 'expiring' : 'valid';
}
function analyze(b) {
  let a = cache.get(b);
  if (a) return a;
  const now = Date.now(), docs = {}, bad = [], soon = [];
  for (const [k, n] of DOCS) {
    const s = docs[k] = docState(b.docs[k], now);
    if (s === 'expired') bad.push(n); else if (s === 'expiring') soon.push(n);
  }
  const approved = b.status === 'approved';
  const approvalLapsed = approved && !(now <= ts(b.validUntil));
  const approvalSoon = approved && !approvalLapsed && ts(b.validUntil) - now <= EXPIRING_SOON_DAYS * DAY;
  a = { docs, bad, soon, approvalLapsed, approvalSoon,
    status: approvalLapsed ? 'expired' : b.status,
    legal: approved && !approvalLapsed && !bad.length,
    needsAction: approved && (approvalLapsed || bad.length > 0) };
  cache.set(b, a);
  return a;
}
const docBadge = s => `<span class="badge badge-${s}">${DOC_LABEL[s]}</span>`;
const statusBadge = s => `<span class="badge badge-${STATUS_BADGE[s] || 'correction'}">${STATUS[s]}</span>`;

function newQr() {
  let code;
  do { code = 'BV-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), x => QR_ALPHABET[x % QR_ALPHABET.length]).join(''); }
  while (busByQr.has(code));
  return code;
}
const normalizeCode = raw => (String(raw ?? '').toUpperCase().match(/BV-[A-Z0-9]{4,12}/) || [''])[0];

/* ---------- Session (a login expires too) ---------- */
let sesRaw = null, sesVal = null;   // parsed session is reused until the stored text changes
function readSession() {
  let raw = null;
  try { raw = localStorage.getItem(SES_KEY); } catch { return null; }
  if (raw !== sesRaw) { sesRaw = raw; try { sesVal = JSON.parse(raw); } catch { sesVal = null; } }
  if (sesVal?.uid && Date.now() < ts(sesVal.exp)) return sesVal;
  if (raw) { try { localStorage.removeItem(SES_KEY); } catch { /* ignore */ } }   // purge an expired login
  return null;
}
const getUser = () => { const s = readSession(); return s ? userById.get(s.uid) || null : null; };
function startSession(u) {
  const at = Date.now();
  try { localStorage.setItem(SES_KEY, JSON.stringify({ uid: u.id, at: new Date(at).toISOString(), exp: new Date(at + SESSION_TTL_HOURS * HOUR).toISOString() })); }
  catch { toast('Could not start a session in this browser.', 'error'); }
}

/* Every action re-checks who is asking, so an expired session or a tampered
   data-id cannot reach another operator's bus. Returns {u, b} or null. */
function guardAction(role, id) {
  const u = getUser();
  if (!u || u.role !== role) { closeModal(); toast('Your session ended or you do not have access. Please log in again.', 'error'); render(); return null; }
  const b = id ? busById.get(id) : null;
  if (id && (!b || (role === 'operator' && b.operatorId !== u.id))) { toast('Bus not found.', 'error'); return null; }
  return { u, b };
}

/* ---------- UI helpers ---------- */
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' toast-' + type : '');
  t.textContent = msg;
  $('#toast').append(t);
  setTimeout(() => t.remove(), 4000);
}
function openModal(title, html, wide) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').classList.toggle('wide', !!wide);
  if (!$('#modal').open) $('#modal').showModal();
}
const closeModal = () => { const m = $('#modal'); if (m.open) m.close(); };
const nav = p => { location.hash = p; };

function docTable(b) {
  const a = analyze(b);
  return `<div class="table-wrap"><table><thead><tr><th>Document</th><th>File</th><th>Expiry</th><th>Updated</th><th>Status</th></tr></thead><tbody>${
    DOCS.map(([k, n]) => `<tr><td>${n}</td><td>${esc(b.docs[k]?.file || '-')}</td><td>${fmtDate(b.docs[k]?.expiry)}</td><td>${fmtTime(b.docs[k]?.updatedAt)}</td><td>${docBadge(a.docs[k])}</td></tr>`).join('')}</tbody></table></div>`;
}
const historyHTML = b => `<h3 class="section-title">History</h3><ul class="timeline">${b.history.slice().reverse().map(h => `<li><time datetime="${esc(h.at)}">${fmtTime(h.at)}</time>${esc(h.msg)}</li>`).join('')}</ul>`;
const stampRows = b => [['Registered', b.createdAt], ['Last submitted', b.submittedAt], ['Reviewed', b.reviewedAt], ['Approved', b.approvedAt], ['Approval valid until', b.validUntil], ['Last scanned', b.lastScan?.at]]
  .filter(([, t]) => t).map(([l, t]) => `<div><dt>${l}</dt><dd>${fmtTime(t)}</dd></div>`).join('');
const statGrid = items => `<div class="grid grid-4" style="margin-bottom:1.5rem">${items.map(([l, v]) => `<div class="card stat"><b>${v}</b><span>${l}</span></div>`).join('')}</div>`;

/* ---------- Header ---------- */
function renderHeader() {
  const u = getUser();
  $('#auth-area').innerHTML = u
    ? `<span class="user-chip"><span class="role-dot role-${u.role}"></span>${esc(u.name)} <small>${ROLES[u.role]}</small></span>
        <a class="btn btn-outline btn-sm" href="#${homeFor(u)}">Dashboard</a>
        <button class="btn btn-ghost btn-sm" data-action="logout">Log out</button>`
    : `<a class="btn btn-primary btn-sm" href="#/login">Log in</a>`;
}

/* ---------- Views ---------- */
function viewHome() {
  return `<section class="hero"><div class="container hero-grid"><div>
      <span class="eyebrow">Bus legal documents verification</span>
      <h1>Know a bus is road-legal in seconds.</h1>
      <p class="lead">Operators submit their legal documents once. The Super Admin verifies them and issues a QR code. LTO officers scan it on the road to confirm the bus is compliant.</p>
      <div class="row"><a class="btn btn-primary btn-lg" href="#/login">Log in or register</a><a class="btn btn-outline btn-lg" href="#/lto">Verify a bus</a></div>
    </div>
    <div class="card"><h3>Documents checked</h3><ul>${DOCS.map(d => `<li>${d[1]}</li>`).join('')}</ul></div></div></section>
  <section class="section"><div class="container"><h2>How it works</h2><ol class="steps">
    <li><h3>Submit</h3><p>The operator registers a bus and enters each document's expiry date.</p></li>
    <li><h3>Verify</h3><p>The Super Admin reviews the documents, then approves or asks for corrections.</p></li>
    <li><h3>Get a QR code</h3><p>Approved buses receive a QR code. The approval lasts until the earliest document expires, or ${APPROVAL_TTL_DAYS} days.</p></li>
    <li><h3>Scan</h3><p>An LTO officer scans the code and sees the bus's current legal status.</p></li></ol></div></section>
  <section class="section" style="padding-top:0"><div class="container"><h2>Who uses it</h2><div class="grid grid-3">
    <div class="card role-card operator"><h3>Bus Operator</h3><ul><li>Register buses</li><li>Upload document details</li><li>Print QR stickers</li></ul></div>
    <div class="card role-card superadmin"><h3>Super Admin</h3><ul><li>Review submissions</li><li>Approve or return for correction</li><li>Issue QR codes</li></ul></div>
    <div class="card role-card lto"><h3>LTO Officer</h3><ul><li>Scan QR codes</li><li>See document validity</li><li>Spot expired papers</li></ul></div></div></div></section>`;
}

let authMode = 'login';
function viewLogin() {
  const reg = authMode === 'register';
  return `<div class="auth-wrap card"><h1 style="font-size:1.6rem">${reg ? 'Register as an operator' : 'Log in'}</h1>
  <form data-form="${reg ? 'register' : 'login'}" novalidate>
    ${reg ? '' : `<fieldset class="segmented"><legend>I am a</legend>${Object.entries(ROLES).map(([r, n], i) =>
      `<label><input type="radio" name="role" value="${r}" ${i === 0 ? 'checked' : ''}><span class="seg"><span aria-hidden="true">${ROLE_ICON[r]}</span>${n}</span></label>`).join('')}</fieldset>`}
    ${reg ? `<label class="field">Company name<input name="name" required autocomplete="organization"></label>` : ''}
    <div class="stack"><label class="field">Email<input type="email" name="email" required autocomplete="email"></label>
    <label class="field">Password<input type="password" name="password" required minlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}"></label></div>
    <p class="form-error" role="alert"></p>
    <button class="btn btn-primary" style="width:100%">${reg ? 'Create account' : 'Log in'}</button>
  </form>
  <p style="margin:1rem 0 0" class="text-muted">${reg ? 'Already registered?' : 'New operator?'} <a href="#" data-action="auth-mode">${reg ? 'Log in' : 'Create an account'}</a></p>
  <details class="demo"><summary>Demo accounts</summary>
    <p><code>operator@demo.ph</code> / <code>demo123</code><br><code>admin@busverify.ph</code> / <code>admin123</code><br><code>lto@demo.ph</code> / <code>demo123</code></p></details></div>`;
}

function viewOperator(u) {
  const buses = [], c = { approved: 0, pending: 0, attention: 0 };
  for (const b of db.buses) {   // one pass for the list and every counter
    if (b.operatorId !== u.id) continue;
    buses.push(b);
    const a = analyze(b);
    if (a.status === 'approved') c.approved++;
    if (b.status === 'pending') c.pending++;
    if (b.status === 'correction' || a.needsAction) c.attention++;
  }
  return `<div class="container section"><div class="page-head"><div><h1>My buses</h1><p>Register buses and keep their documents up to date.</p></div>
    <button class="btn btn-primary" data-action="bus-form">Add bus</button></div>
  ${statGrid([['Total', buses.length], ['Approved', c.approved], ['Pending', c.pending], ['Need attention', c.attention]])}
  ${buses.length ? `<div class="grid grid-2">${buses.map(busCard).join('')}</div>` : `<div class="card empty"><p>No buses yet.</p><button class="btn btn-primary" data-action="bus-form">Add your first bus</button></div>`}</div>`;
}
function busCard(b) {
  const a = analyze(b), approved = b.status === 'approved';
  const canEdit = !approved || a.needsAction || a.soon.length > 0 || a.approvalSoon;
  const notes = [];
  if (b.status === 'correction') notes.push(`<div class="callout callout-warn" style="margin-top:1rem"><strong>Admin note:</strong> ${esc(b.note)}</div>`);
  if (a.approvalLapsed || (approved && a.bad.length)) {
    const parts = [];
    if (a.approvalLapsed) parts.push(`Approval expired on ${fmtTime(b.validUntil)}.`);
    if (a.bad.length) parts.push(`Expired: ${esc(a.bad.join(', '))}.`);
    notes.push(`<div class="callout callout-danger" style="margin-top:1rem">${parts.join(' ')} Update and resubmit.</div>`);
  } else if (approved && (a.soon.length || a.approvalSoon)) {
    const parts = [];
    if (a.soon.length) parts.push(`Expiring soon: ${esc(a.soon.join(', '))}.`);
    if (a.approvalSoon) parts.push(`Approval ends ${fmtTime(b.validUntil)}.`);
    notes.push(`<div class="callout callout-warn" style="margin-top:1rem">${parts.join(' ')}</div>`);
  } else if (a.legal) {
    notes.push(`<p class="text-muted" style="margin:.75rem 0 0;font-size:.9rem">Approved ${fmtTime(b.approvedAt)} &middot; valid until ${fmtDate(b.validUntil)}</p>`);
  }
  const editLabel = b.status === 'correction' ? 'Fix and resubmit' : a.approvalLapsed ? 'Renew' : 'Edit';
  return `<article class="card bus-card"><header><div><h3>${esc(b.plate)}</h3><p>${esc(b.make)} &middot; ${esc(b.seats)} seats<br>${esc(b.route)}</p></div>${statusBadge(a.status)}</header>
    ${notes.join('')}
    <div class="card-actions">${approved ? `<button class="btn btn-primary btn-sm" data-action="show-qr" data-id="${b.id}">View QR</button>` : ''}
    ${canEdit ? `<button class="btn btn-outline btn-sm" data-action="bus-form" data-id="${b.id}">${editLabel}</button>` : ''}
    <button class="btn btn-ghost btn-sm" data-action="bus-details" data-id="${b.id}">Details</button></div></article>`;
}

let adminFilter = 'pending';
function viewAdmin() {
  const counts = { pending: 0, approved: 0, correction: 0, expired: 0 }, rows = [];
  for (const b of db.buses) {
    const s = analyze(b).status;
    counts[s]++;
    if (adminFilter === 'all' || s === adminFilter) rows.push(b);
  }
  const key = b => ts(b.submittedAt) || 0;
  rows.sort(adminFilter === 'pending' ? (x, y) => key(x) - key(y) : (x, y) => key(y) - key(x));   // review queue is oldest first
  return `<div class="container section"><div class="page-head"><div><h1>Verification queue</h1><p>Review operator submissions and issue QR codes.</p></div></div>
  ${statGrid([['Pending', counts.pending], ['Approved', counts.approved], ['Need correction', counts.correction], ['Approval expired', counts.expired], ['All buses', db.buses.length]])}
  <div class="toolbar"><label class="field">Show<select data-change="admin-filter">${FILTERS.map(([v, l]) => `<option value="${v}" ${v === adminFilter ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
  ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Plate</th><th>Operator</th><th>Route</th><th>Submitted</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(b =>
    `<tr><td><strong>${esc(b.plate)}</strong></td><td>${esc(userName(b.operatorId))}</td><td>${esc(b.route)}</td><td>${fmtTime(b.submittedAt)}</td><td>${statusBadge(analyze(b).status)}</td>
     <td class="actions"><button class="btn btn-outline btn-sm" data-action="review" data-id="${b.id}">Review</button></td></tr>`).join('')}</tbody></table></div>`
    : `<div class="card empty">Nothing to show for this filter.</div>`}</div>`;
}

function viewLto() {
  return `<div class="container section"><div class="page-head"><div><h1>Verify a bus</h1><p>Scan the QR code on the bus or enter the code below it.</p></div></div>
  <div class="lto-grid"><div class="card"><h3>Scan or enter code</h3>
    <button class="btn btn-primary" style="width:100%;margin-top:.5rem" data-action="scan">Scan with camera</button>
    <div id="scan-box" class="scan-box" hidden><video id="scan-video" playsinline muted></video><div id="scan-reader"></div></div>
    <form data-form="lookup" style="margin-top:1rem"><label class="field">Code<input name="code" placeholder="BV-XXXXXXXX" autocapitalize="characters" required></label>
    <button class="btn btn-outline" style="width:100%;margin-top:.75rem">Check code</button></form></div>
  <div id="lto-result"><div class="card empty">Results appear here.</div></div></div></div>`;
}
function resultHTML(b, raw) {
  if (!b) return `<div class="result-banner warn"><h3>Not verified</h3><p>No bus matches <code>${esc(String(raw ?? '').trim().slice(0, 40))}</code>. Treat this bus as unverified.</p></div>`;
  const a = analyze(b), why = [];
  if (b.status !== 'approved') why.push('This bus is not approved.');
  else if (a.approvalLapsed) why.push(`Approval expired on ${esc(fmtTime(b.validUntil))}.`);
  if (a.bad.length) why.push(`Expired: ${esc(a.bad.join(', '))}.`);
  return `<div class="card"><div class="result-banner ${a.legal ? 'ok' : 'warn'}"><h3>${a.legal ? 'Road-legal' : 'Not road-legal'}</h3>
    <p>${a.legal ? 'All documents are valid.' : why.join(' ')}</p></div>
    <dl class="meta"><div><dt>Plate</dt><dd>${esc(b.plate)}</dd></div><div><dt>Make / model</dt><dd>${esc(b.make)}</dd></div><div><dt>Seats</dt><dd>${esc(b.seats)}</dd></div>
    <div><dt>Operator</dt><dd>${esc(userName(b.operatorId))}</dd></div><div><dt>Route</dt><dd>${esc(b.route)}</dd></div>
    ${b.validUntil && b.status === 'approved' ? `<div><dt>Approval valid until</dt><dd>${fmtTime(b.validUntil)}</dd></div>` : ''}
    <div><dt>Checked</dt><dd>${fmtTime(nowISO())}</dd></div></dl>
    <h3 class="section-title">Documents</h3>${docTable(b)}</div>`;
}
function showResult(raw) {
  const target = $('#lto-result');
  if (!target) return;
  resetCache();   // a legal check must use the current moment, not a cached render
  const b = busByQr.get(normalizeCode(raw));
  target.innerHTML = resultHTML(b, raw);
  if (b) recordScan(b);
}
function recordScan(b) {
  const now = Date.now(), prev = ts(b.lastScan?.at), by = getUser()?.name || 'officer';
  b.lastScan = { at: new Date(now).toISOString(), by };
  if (!(now - prev < SCAN_LOG_GAP_MS)) log(b, `Scanned by ${by}`, b.lastScan.at);   // prev may be NaN: then log
  save();
}

/* ---------- Router ---------- */
const guards = { operator: 'operator', admin: 'superadmin', lto: 'lto' };
let lastRoute = null;
function render() {
  stopScan(); resetCache();
  const route = location.hash.replace(/^#\/?/, '');
  if (route !== 'login') authMode = 'login';   // leaving the page resets the login/register toggle
  const u = getUser();
  let html;
  if (route in guards) {
    if (!u) return nav('/login');
    if (u.role !== guards[route]) { toast('You do not have access to that page.', 'error'); return nav(homeFor(u)); }
    html = route === 'operator' ? viewOperator(u) : route === 'admin' ? viewAdmin() : viewLto();
  } else if (route === 'login') {
    if (u) return nav(homeFor(u));
    html = viewLogin();
  } else html = viewHome();
  const changed = route !== lastRoute; lastRoute = route;
  $('#main').innerHTML = html;
  $('#site-nav').classList.remove('open');
  document.querySelector('.menu-toggle')?.setAttribute('aria-expanded', 'false');
  renderHeader();
  if (changed) window.scrollTo(0, 0);   // timed refreshes and filter changes keep the scroll position
  scheduleRefresh();
}

/* One timer wakes the page at the next moment anything changes (a document
   starts "expiring", a document or approval expires, the session ends).
   No polling. It waits while a modal is open or the camera is scanning. */
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const now = Date.now(), u = getUser();
  let next = Infinity;
  const consider = t => { if (t > now && t < next) next = t; };
  const s = readSession(); if (s) consider(ts(s.exp));
  if (u && u.role !== 'lto') {
    for (const b of db.buses) {
      if (u.role === 'operator' && b.operatorId !== u.id) continue;
      if (b.status === 'approved') consider(ts(b.validUntil) + 1);
      for (const d of Object.values(b.docs)) { const e = ts(d?.expiresAt); consider(e + 1); consider(e - EXPIRING_SOON_DAYS * DAY); }
    }
  }
  if (next !== Infinity) refreshTimer = setTimeout(onRefresh, Math.min(next - now + 50, MAX_TIMEOUT));
}
function onRefresh() {
  if ($('#modal').open || scan) { refreshTimer = setTimeout(onRefresh, 30e3); return; }
  render();
}

/* ---------- Scanner ---------- */
/* Uses the browser's BarcodeDetector when it can read QR codes, otherwise the
   html5-qrcode library that index.html loads. */
let scan = null;   // the active scan session, or null
function stopScan() {
  const box = $('#scan-box'); if (box) box.hidden = true;
  if (!scan) return;
  const s = scan; scan = null;
  clearTimeout(s.timer);
  s.stream?.getTracks().forEach(t => t.stop());
  const v = $('#scan-video'); if (v) v.srcObject = null;   // release the camera feed
  if (s.h5) s.h5.stop().then(() => s.h5.clear()).catch(() => {});
}
/* BarcodeDetector can exist without QR support (e.g. desktop Chrome on Linux). */
async function nativeQrSupported() {
  try { return 'BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code'); }
  catch { return false; }
}
async function startScan() {
  if (scan) return;   // already running: do not open a second camera
  if (!navigator.mediaDevices?.getUserMedia) return toast('Camera is not available here. Enter the code instead.', 'error');
  const box = $('#scan-box'), video = $('#scan-video');
  if (!box || !video) return;
  const s = scan = {};
  box.hidden = false;
  try {
    const native = await nativeQrSupported();
    if (scan !== s) return;   // cancelled while checking support
    if (native) await scanNative(s, video);
    else await scanFallback(s, video);
  } catch (err) {
    if (scan === s) stopScan();
    const denied = /denied|NotAllowed|Permission/i.test(`${err?.name} ${err?.message} ${err}`);
    toast(denied ? 'Camera permission was denied.' : 'Could not start the camera. Enter the code instead.', 'error');
  }
}
async function scanNative(s, video) {
  s.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  if (scan !== s) { s.stream.getTracks().forEach(t => t.stop()); return; }   // cancelled while the prompt was open
  video.hidden = false; video.srcObject = s.stream; await video.play();
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  const tick = async () => {   // next frame is queued only after the last one finished, so detects never overlap
    if (scan !== s) return;
    try {
      const r = await det.detect(video);
      if (scan === s && r[0]) { stopScan(); showResult(r[0].rawValue); return; }
    } catch { /* keep trying */ }
    if (scan === s) s.timer = setTimeout(tick, 300);
  };
  tick();
}
async function scanFallback(s, video) {
  if (!window.Html5Qrcode) throw new Error('scanner library missing');
  video.hidden = true;
  const h5 = s.h5 = new Html5Qrcode('scan-reader');
  await h5.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 }, text => { if (scan === s) { stopScan(); showResult(text); } }, () => {});
  if (scan !== s) h5.stop().then(() => h5.clear()).catch(() => {});   // cancelled while starting
}

/* ---------- Actions ---------- */
function busFormHTML(b) {
  b = b || { docs: {} };
  return `<form data-form="bus" novalidate><input type="hidden" name="id" value="${esc(b.id || '')}">
    ${b.status === 'approved' ? `<div class="callout callout-info">Submitting changes sends this bus back for review. Its QR code will show "not approved" until it is approved again.</div>` : ''}
    <div class="form-grid"><label class="field">Plate number<input name="plate" value="${esc(b.plate)}" required></label>
    <label class="field">Make / model<input name="make" value="${esc(b.make)}" required></label>
    <label class="field">Seats<input type="number" name="seats" min="1" step="1" value="${esc(b.seats)}" required></label>
    <label class="field">Route<input name="route" value="${esc(b.route)}" required></label></div>
    ${DOCS.map(([k, n]) => `<fieldset class="doc-field"><legend>${n}</legend><div class="form-grid">
      <label class="field">Expiry date<input type="date" name="exp_${k}" value="${esc(b.docs[k]?.expiry)}" required></label>
      <label class="field">Scan / photo<input type="file" name="file_${k}" accept="image/*,.pdf"><span class="hint">${b.docs[k]?.file ? 'Current: ' + esc(b.docs[k].file) : 'Only the file name is kept in this demo.'}${b.docs[k]?.updatedAt ? ' Updated ' + fmtTime(b.docs[k].updatedAt) + '.' : ''}</span></label></div></fieldset>`).join('')}
    <p class="form-error" role="alert"></p>
    <div class="form-actions"><button type="button" class="btn btn-outline" data-action="close-modal">Cancel</button><button class="btn btn-primary">Submit for review</button></div></form>`;
}

const actions = {
  'toggle-menu': (_, el) => { const o = $('#site-nav').classList.toggle('open'); el.setAttribute('aria-expanded', o); },
  'close-modal': closeModal,
  'auth-mode': () => { authMode = authMode === 'login' ? 'register' : 'login'; render(); },
  logout: () => { closeModal(); try { localStorage.removeItem(SES_KEY); } catch { /* ignore */ } nav('/'); renderHeader(); toast('Logged out.'); },
  'bus-form': id => { const g = guardAction('operator', id); if (g) openModal(g.b ? 'Edit bus' : 'Add bus', busFormHTML(g.b), true); },
  'bus-details': id => {
    const g = guardAction('operator', id); if (!g?.b) return;
    openModal(g.b.plate, `<dl class="meta">${stampRows(g.b)}</dl>${docTable(g.b)}${historyHTML(g.b)}`, true);
  },
  'show-qr': id => {
    const g = guardAction('operator', id), b = g?.b;
    if (!b?.qr || b.status !== 'approved') return;
    openModal('QR code - ' + b.plate, `<div class="qr-sheet"><div class="qr-box" id="qr-target"></div><p class="qr-code">${esc(b.qr)}</p><p class="text-muted">${esc(b.plate)} &middot; ${esc(userName(b.operatorId))}</p>
      <div class="row no-print" style="justify-content:center"><button class="btn btn-primary" data-action="print">Print sticker</button></div></div>`);
    if (window.QRCode) new QRCode($('#qr-target'), { text: b.qr, width: 220, height: 220 });
    else $('#qr-target').innerHTML = '<p class="text-muted">QR library did not load. Check your internet connection.</p>';
  },
  print: () => window.print(),
  review: id => {
    const g = guardAction('superadmin', id), b = g?.b;
    if (!b) return;
    openModal('Review ' + b.plate, `<dl class="meta"><div><dt>Operator</dt><dd>${esc(userName(b.operatorId))}</dd></div><div><dt>Make / model</dt><dd>${esc(b.make)}</dd></div><div><dt>Seats</dt><dd>${esc(b.seats)}</dd></div><div><dt>Route</dt><dd>${esc(b.route)}</dd></div><div><dt>Status</dt><dd>${statusBadge(analyze(b).status)}</dd></div>${stampRows(b)}</dl>
      ${docTable(b)}<form data-form="decision" style="margin-top:1rem"><input type="hidden" name="id" value="${b.id}">
      <label class="field">Note to operator (required to request a correction)<textarea name="note">${esc(b.note)}</textarea></label><p class="form-error" role="alert"></p>
      <div class="form-actions"><button type="submit" name="decision" value="correction" class="btn btn-danger">Request correction</button><button type="submit" name="decision" value="approved" class="btn btn-success">${b.qr ? 'Approve and renew' : 'Approve and issue QR'}</button></div></form>
      ${historyHTML(b)}`, true);
  },
  scan: () => { if (guardAction('lto')) startScan(); }
};

const forms = {
  login(f) {
    const fd = new FormData(f), err = f.querySelector('.form-error');
    const role = fd.get('role'), email = String(fd.get('email')).trim().toLowerCase(), pw = fd.get('password');
    const u = db.users.find(x => x.role === role && x.email === email && x.password === pw);
    if (!u) return void (err.textContent = 'Email, password or role is incorrect.');
    u.lastLoginAt = nowISO(); save();
    startSession(u);
    nav(homeFor(u));
  },
  register(f) {
    const fd = new FormData(f), err = f.querySelector('.form-error');
    const name = String(fd.get('name')).trim(), email = String(fd.get('email')).trim().toLowerCase(), pw = String(fd.get('password'));
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return void (err.textContent = 'Enter a company name and a valid email.');
    if (pw.length < 6) return void (err.textContent = 'Password must be at least 6 characters.');
    if (db.users.some(x => x.email === email)) return void (err.textContent = 'That email is already registered.');
    const now = nowISO(), u = { id: uid(), role: 'operator', name, email, password: pw, createdAt: now, lastLoginAt: now };
    db.users.push(u);
    if (!commit()) return void (err.textContent = 'Could not save your account in this browser.');
    startSession(u); authMode = 'login';
    nav('/operator'); toast('Account created.', 'success');
  },
  bus(f) {
    const fd = new FormData(f), g = guardAction('operator', fd.get('id') || undefined);
    if (!g) return;
    const err = f.querySelector('.form-error'), existing = g.b, v = k => String(fd.get(k) ?? '').trim();
    const plate = v('plate').toUpperCase().replace(/\s+/g, ' '), make = v('make'), route = v('route'), seats = Number(v('seats'));
    if (!plate || !make || !route) return void (err.textContent = 'Fill in all bus details.');
    if (!Number.isInteger(seats) || seats < 1) return void (err.textContent = 'Seats must be a whole number of at least 1.');
    const clash = busByPlate.get(plate);
    if (clash && clash !== existing) return void (err.textContent = 'That plate number is already registered.');
    const now = nowISO(), docs = {};
    for (const [k, n] of DOCS) {
      const expiry = v('exp_' + k), prev = existing?.docs[k];
      if (!validYMD(expiry)) return void (err.textContent = `Enter a valid expiry date for ${n}.`);
      const file = fd.get('file_' + k)?.name || prev?.file || '';
      const changed = !prev || prev.expiry !== expiry || prev.file !== file;
      docs[k] = { expiry, expiresAt: endOfDay(expiry).toISOString(), file, updatedAt: changed ? now : prev.updatedAt || now };
    }
    const b = existing || { id: uid(), operatorId: g.u.id, createdAt: now, history: [] };
    // Resubmitting drops the approval window, so an edited bus can never keep scanning as legal.
    Object.assign(b, { plate, make, seats, route, docs, status: 'pending', note: '', submittedAt: now, updatedAt: now, approvedAt: null, validUntil: null });
    log(b, existing ? 'Resubmitted for review' : 'Submitted for review', now);
    if (!existing) db.buses.push(b);
    if (!commit()) return void (err.textContent = 'Could not save. Your changes were not stored.');
    closeModal(); render(); toast('Submitted for review.', 'success');
  },
  decision(f, e) {
    const fd = new FormData(f), g = guardAction('superadmin', fd.get('id'));
    if (!g?.b) return;
    const b = g.b, err = f.querySelector('.form-error'), d = e.submitter?.value, note = String(fd.get('note')).trim();
    if (d !== 'approved' && d !== 'correction') return;
    resetCache();   // judge the documents at this moment
    const bad = analyze(b).bad;
    if (d === 'correction' && !note) return void (err.textContent = 'Write a note explaining what to correct.');
    if (d === 'approved' && bad.length) return void (err.textContent = 'Cannot approve: ' + bad.join(', ') + ' expired or missing.');
    const now = Date.now(), iso = new Date(now).toISOString();
    Object.assign(b, { status: d, note: d === 'correction' ? note : '', reviewedAt: iso, reviewedBy: g.u.id, updatedAt: iso });
    if (d === 'approved') { b.qr ||= newQr(); b.approvedAt = iso; b.validUntil = computeValidUntil(b, now); }
    else { b.approvedAt = null; b.validUntil = null; }
    log(b, d === 'approved' ? `Approved. QR code issued. Valid until ${fmtTime(b.validUntil)}.` : 'Correction requested: ' + note, iso);
    if (!commit()) return void (err.textContent = 'Could not save. The decision was not stored.');
    closeModal(); render(); toast(d === 'approved' ? 'Bus approved.' : 'Correction requested.', 'success');
  },
  lookup(f) { if (guardAction('lto')) showResult(new FormData(f).get('code')); }
};

/* ---------- Events ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.tagName === 'A') e.preventDefault();
  actions[el.dataset.action]?.(el.dataset.id, el);
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  forms[f.dataset.form]?.(f, e);
});
document.addEventListener('change', e => {
  if (e.target.dataset.change === 'admin-filter' && FILTERS.some(([v]) => v === e.target.value)) { adminFilter = e.target.value; render(); }
});
$('#modal').addEventListener('click', e => { if (e.target === $('#modal')) closeModal(); });
window.addEventListener('hashchange', render);
/* Another tab changed the data or logged in/out: reload so this tab never saves stale data over it. */
window.addEventListener('storage', e => {
  if (e.key === null || e.key === DB_KEY) { db = loadDB(); reindex(); resetCache(); if (!scan) render(); }   // do not kill an active camera scan
  else if (e.key === SES_KEY) render();
});

$('#year').textContent = new Date().getFullYear();
save();
render();
})();
