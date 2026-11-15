let cachedKeys;
let cachedUntil = 0;

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function loadKeys(teamDomain, force = false) {
  if (!force && cachedKeys && Date.now() < cachedUntil) return cachedKeys;

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Access keys unavailable');

  const result = await response.json();
  if (!Array.isArray(result.keys)) throw new Error('Invalid Access keys');
  const maxAge = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 300);
  cachedKeys = result.keys;
  cachedUntil = Date.now() + Math.min(maxAge, 3600) * 1000;
  return cachedKeys;
}

async function verifyAccessToken(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  const teamDomain = String(env.ACCESS_TEAM_DOMAIN || '').toLowerCase();
  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience : [audience];
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256' || !header.kid || !teamDomain ||
      claims.iss !== `https://${teamDomain}` ||
      !audiences.includes(env.ACCESS_AUD) ||
      String(claims.email || '').toLowerCase() !== String(env.ADMIN_EMAIL || '').toLowerCase() ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      (Number.isFinite(claims.nbf) && claims.nbf > now + 60)) {
    return false;
  }

  let keys = await loadKeys(teamDomain);
  let jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) {
    keys = await loadKeys(teamDomain, true);
    jwk = keys.find(key => key.kid === header.kid);
  }
  if (!jwk) return false;

  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signedContent = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    decodeBase64Url(parts[2]),
    signedContent,
  );
}

export async function onRequest({ request, env, next }) {
  const path = new URL(request.url).pathname;
  if (path !== '/api/admin' && !path.startsWith('/api/admin/')) return next();

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ADMIN_EMAIL) {
    return jsonResponse({ error: 'admin_auth_not_configured' }, 503);
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('Origin');
    if (!origin || origin !== new URL(request.url).origin) {
      return jsonResponse({ error: 'origin_not_allowed' }, 403);
    }
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return jsonResponse({ error: 'authentication_required' }, 401);

  try {
    if (!await verifyAccessToken(token, env)) {
      return jsonResponse({ error: 'authentication_required' }, 401);
    }
  } catch {
    return jsonResponse({ error: 'authentication_unavailable' }, 503);
  }

  return next();
}