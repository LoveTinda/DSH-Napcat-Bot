import fs from 'node:fs';
import path from 'node:path';

const SECRET = /token|secret|password|accessToken/i;

function stripSecrets(v) {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET.test(k) ? '***' : stripSecrets(val);
    return out;
  }
  return v;
}

export function readConfigFile(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { source: file, config };
}

export function configView(file) {
  const { source, config } = readConfigFile(file);
  return { source, config: stripSecrets(config) };
}

export function prepareConfig(submitted, current = {}, { env = process.env } = {}) {
  const next = { ...current };
  if (submitted && typeof submitted === 'object') {
    for (const [k, v] of Object.entries(submitted)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && next[k] && typeof next[k] === 'object') {
        next[k] = { ...next[k], ...v };
      } else {
        next[k] = v;
      }
    }
  }
  return { config: next, warnings: [] };
}

export function writeConfigFile(file, config) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = file + '.bak-' + stamp;
  try { fs.copyFileSync(file, backup); } catch {}
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { source: file, backup, savedAt: new Date().toISOString() };
}

export function diffConfig(a, b) {
  const changed = [];
  const walk = (x, y, prefix) => {
    if (x === y) return;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], prefix ? prefix + '.' + k : k);
    } else {
      changed.push(prefix || '(root)');
    }
  };
  walk(a, b, '');
  return changed;
}
