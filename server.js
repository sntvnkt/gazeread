/*
 * GazeRead – малък сървър с акаунти (само вградени модули на Node.js, без npm пакети)
 *
 *   node server.js            → http://localhost:8080
 *
 * Пази потребителите в data/users.json:
 *   • паролите са хеширани със scrypt (никога не се пазят като текст),
 *   • профилът (калибриране, настройки, трудни думи, личен модел) е JSON до 4 MB.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');
const MAX_PROFILE = 4 * 1024 * 1024;
const SESSION_DAYS = 60;

// ---------- „база данни“ ----------
let db = { users: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* нов файл */ }
db.users = db.users || {}; db.sessions = db.sessions || {};

let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);       // атомарен запис
  }, 200);
}

// ---------- пароли и сесии ----------
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(pw, user) {
  const { hash } = hashPassword(pw, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
function newSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { username, expires: Date.now() + SESSION_DAYS * 864e5 };
  saveDb();
  return token;
}
function sessionUser(req) {
  const m = /(?:^|;\s*)gr_session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = db.sessions[m[1]];
  if (!s || s.expires < Date.now()) { if (s) { delete db.sessions[m[1]]; saveDb(); } return null; }
  return { token: m[1], user: db.users[s.username] };
}
function cookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie', `gr_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`);
}

// ограничение на опитите за вход (срещу налучкване на пароли)
const attempts = new Map();
function limited(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  a.push(now); attempts.set(ip, a);
  return a.length > 20;
}

// ---------- помощни ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const validName = (u) => typeof u === 'string' && /^[\p{L}\p{N}_.-]{3,30}$/u.test(u);
const publicUser = (u) => ({ username: u.display, created: u.created });

// ---------- API ----------
async function api(req, res, url) {
  const ip = req.socket.remoteAddress;
  // заявките, които променят нещо, трябва да идват от същия сайт
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return send(res, 403, { error: 'Забранено' });
  }

  if (url.pathname === '/api/register' && req.method === 'POST') {
    if (limited(ip)) return send(res, 429, { error: 'Твърде много опити. Изчакай малко.' });
    const { username, password } = await readBody(req, 10e3);
    if (!validName(username)) return send(res, 400, { error: 'Името трябва да е 3–30 букви, цифри, точка, тире или долна черта.' });
    if (typeof password !== 'string' || password.length < 6) return send(res, 400, { error: 'Паролата трябва да е поне 6 символа.' });
    const key = username.toLowerCase();
    if (db.users[key]) return send(res, 409, { error: 'Това име вече е заето.' });
    db.users[key] = { display: username, ...hashPassword(password), created: Date.now(), profile: null };
    saveDb();
    cookie(res, newSession(key), SESSION_DAYS * 86400);
    return send(res, 200, { user: publicUser(db.users[key]), profile: null });
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (limited(ip)) return send(res, 429, { error: 'Твърде много опити. Изчакай малко.' });
    const { username, password } = await readBody(req, 10e3);
    const u = typeof username === 'string' && db.users[username.toLowerCase()];
    if (!u || typeof password !== 'string' || !checkPassword(password, u)) return send(res, 401, { error: 'Грешно име или парола.' });
    cookie(res, newSession(username.toLowerCase()), SESSION_DAYS * 86400);
    return send(res, 200, { user: publicUser(u), profile: u.profile });
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const s = sessionUser(req);
    if (s) { delete db.sessions[s.token]; saveDb(); }
    cookie(res, '', 0);
    return send(res, 200, { ok: true });
  }

  const s = sessionUser(req);
  if (url.pathname === '/api/me' && req.method === 'GET') {
    if (!s || !s.user) return send(res, 200, { user: null });
    return send(res, 200, { user: publicUser(s.user), profile: s.user.profile });
  }

  if (url.pathname === '/api/profile' && req.method === 'PUT') {
    if (!s || !s.user) return send(res, 401, { error: 'Не си влязъл в профила си.' });
    let profile;
    try { profile = await readBody(req, MAX_PROFILE); } catch (e) { return send(res, 413, { error: 'Профилът е твърде голям.' }); }
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return send(res, 400, { error: 'Невалиден профил.' });
    s.user.profile = profile; s.user.updated = Date.now();
    saveDb();
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/account' && req.method === 'DELETE') {
    if (!s || !s.user) return send(res, 401, { error: 'Не си влязъл в профила си.' });
    const key = s.user.display.toLowerCase();
    delete db.users[key];
    for (const [t, v] of Object.entries(db.sessions)) if (v.username === key) delete db.sessions[t];
    saveDb(); cookie(res, '', 0);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'Няма такъв адрес.' });
}

// ---------- статични файлове ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  // не пускаме извън папката, нито към данните и сървъра
  if (!file.startsWith(ROOT + path.sep) || file.startsWith(DATA_DIR) || /(^|[\\/])\.|^server\.js$/.test(path.relative(ROOT, file))) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Грешка в сървъра.' });
  }
}).listen(PORT, () => {
  console.log(`GazeRead: http://localhost:${PORT}`);
  console.log('Важно: камерата работи само на http://localhost (на същия компютър) или през https://.');
  console.log('От друг компютър през http://<IP-адрес> камерата ще бъде спряна от браузъра.');
});
