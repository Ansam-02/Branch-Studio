import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { onRequest } from '../functions/api/_middleware.js';

globalThis.crypto ??= webcrypto;

const teamDomain = 'branch-studio-pages.cloudflareaccess.com';
const audience = 'test-audience';
const adminEmail = 'ansamjad02@gmail.com';
const keys = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
publicJwk.kid = 'test-key';
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' },
});

after(() => {
  globalThis.fetch = originalFetch;
});

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function createToken(claimOverrides = {}) {
  const header = encode({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
  const claims = encode({
    iss: `https://${teamDomain}`,
    aud: audience,
    email: adminEmail,
    exp: Math.floor(Date.now() / 1000) + 60,
    nbf: Math.floor(Date.now() / 1000) - 5,
    ...claimOverrides,
  });
  const signedContent = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keys.privateKey,
    new TextEncoder().encode(signedContent),
  );
  return `${signedContent}.${Buffer.from(signature).toString('base64url')}`;
}

function context(
  token,
  method = 'GET',
  origin = 'https://branch-studio.pages.dev',
  path = '/api/admin/orders',
) {
  const headers = {};
  if (token) headers['Cf-Access-Jwt-Assertion'] = token;
  if (origin) headers.Origin = origin;
  const request = new Request(`https://branch-studio.pages.dev${path}`, { method, headers });
  return {
    request,
    env: { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience, ADMIN_EMAIL: adminEmail },
    next: async () => new Response('allowed'),
  };
}

test('allows an unexpired Access JWT for the configured administrator', async () => {
  const response = await onRequest(context(await createToken()));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'allowed');
});

test('leaves public customer APIs available while protecting the admin prefix', async () => {
  const publicResponse = await onRequest(context(null, 'POST', 'https://branch-studio.pages.dev', '/api/orders'));
  const adminResponse = await onRequest(context(null, 'GET', 'https://branch-studio.pages.dev', '/api/admin/overview'));
  assert.equal(publicResponse.status, 200);
  assert.equal(await publicResponse.text(), 'allowed');
  assert.equal(adminResponse.status, 401);
});

test('rejects a JWT for a different email or audience', async () => {
  const wrongEmail = await onRequest(context(await createToken({ email: 'other@example.com' })));
  const wrongAudience = await onRequest(context(await createToken({ aud: 'other-audience' })));
  assert.equal(wrongEmail.status, 401);
  assert.equal(wrongAudience.status, 401);
});

test('rejects expired tokens, missing tokens, and cross-origin mutations', async () => {
  const expired = await onRequest(context(await createToken({ exp: 1 })));
  const missing = await onRequest(context(null));
  const crossOrigin = await onRequest(context(await createToken(), 'PATCH', 'https://attacker.example'));
  assert.equal(expired.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(crossOrigin.status, 403);
});

test('rejects a forged signature and fails closed when admin auth is unconfigured', async () => {
  const token = await createToken();
  const parts = token.split('.');
  parts[2] = Buffer.alloc(256).toString('base64url');
  assert.equal((await onRequest(context(parts.join('.')))).status, 401);
  const unconfigured = context(token);
  unconfigured.env = {};
  assert.equal((await onRequest(unconfigured)).status, 503);
});
