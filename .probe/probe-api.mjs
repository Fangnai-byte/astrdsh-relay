// Read-only probe of the local DSH Web /api dispatch surface.
// Usage: node probe-api.mjs "<endpoint>" ["<argsJson>"] ... 
// Mints the same browser-session cookie the Web UI would carry (see
// dsh-client-connection/lib/index.js BrowserAuth), then POSTs one Connection
// RPC envelope per endpoint. Read-only: every call below is a query.
import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const secretB64 = readFileSync(process.env.DSH_HOME + '/.credentials.yaml', 'utf8')
  .match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/)[1];
const secret = Buffer.from(
  secretB64.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (secretB64.length % 4)) % 4),
  'base64',
);

const authority = '127.0.0.1:3080';
const b64u = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const now = Date.now();
const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3600_000 }), 'utf8'));
const value = `v1.${body}.${b64u(createHmac('sha256', secret).update(body).digest())}`;
const cookie = `${'dsh-auth-' + b64u(createHash('sha256').update(authority).digest())}=${value}`;

const specs = process.argv.slice(2);
for (const spec of specs) {
  const [path, argsJson] = spec.split('@');
  const args = argsJson === undefined ? {} : JSON.parse(argsJson);
  const rpcId = 'probe-' + Math.random().toString(36).slice(2, 10);
  const res = await fetch(`http://127.0.0.1:3080/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: path, payload: { args } }),
  });
  const text = await res.text();
  console.log(`POST /api/${path} args=${JSON.stringify(args)} -> HTTP ${res.status} :: ${text.slice(0, 420)}`);
}
