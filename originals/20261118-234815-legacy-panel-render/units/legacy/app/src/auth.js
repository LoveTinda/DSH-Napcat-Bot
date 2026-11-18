import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureTokenFile(file) {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s) return s;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function headerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return String(req.headers['x-admin-token'] || req.headers['x-token'] || '').trim();
}

export function bearerToken(req) {
  return headerToken(req);
}

export function hasJsonContentType(req) {
  return /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
}

export function localHosts(port, extra = []) {
  const p = Number(port) || 0;
  const set = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) if (p) set.add(h + ':' + p);
  for (const h of extra) if (h) set.add(String(h).toLowerCase());
  return set;
}

export function hostAllowed(req, allowed) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return false;
  if (allowed.has(host)) return true;
  const bare = host.replace(/:\d+$/, '');
  return allowed.has(bare);
}

export function originsFor(host, port) {
  if (host instanceof Set || Array.isArray(host)) {
    const out = new Set();
    for (const h of host) { out.add('http://' + h); out.add('https://' + h); }
    return out;
  }
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return ['http://' + h + ':' + port, 'https://' + h + ':' + port];
}

export function originAllowed(req, allowed) {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  return allowed.has(origin.toLowerCase());
}
