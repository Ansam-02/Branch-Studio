const allowedTypes = new Set(['product', 'custom', 'favor', 'workshop']);

function jsonResponse(body, status) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  return new Response(JSON.stringify(body), { status, headers });
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

async function consumeRateLimit(request, database) {
  const address = request.headers.get('CF-Connecting-IP') || 'local';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address));
  const ipHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const result = await database.prepare(
    `INSERT INTO request_limits (ip_hash, minute_bucket, request_count)
     VALUES (?, ?, 1)
     ON CONFLICT (ip_hash, minute_bucket) DO UPDATE SET request_count = request_count + 1
     RETURNING request_count`,
  ).bind(ipHash, minuteBucket).first();

  if (minuteBucket % 10 === 0) {
    await database.prepare('DELETE FROM request_limits WHERE minute_bucket < ?')
      .bind(minuteBucket - 10).run();
  }

  return result?.request_count <= 5;
}

export async function onRequest({ request, env }) {
  const origin = request.headers.get('Origin');

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  if (!env.ORDERS) {
    return jsonResponse({ error: 'service_unavailable' }, 503);
  }

  if (!origin || origin !== new URL(request.url).origin) {
    return jsonResponse({ error: 'origin_not_allowed' }, 403);
  }

  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return jsonResponse({ error: 'unsupported_media_type' }, 415);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 16_384) {
    return jsonResponse({ error: 'payload_too_large' }, 413);
  }

  let input;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 16_384) {
      return jsonResponse({ error: 'payload_too_large' }, 413);
    }
    input = JSON.parse(body);
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return jsonResponse({ error: 'invalid_order' }, 400);
  }

  if (input.privacyAccepted !== true) {
    return jsonResponse({ error: 'privacy_consent_required' }, 400);
  }

  if (cleanText(input.website, 200)) {
    return jsonResponse({ ok: true, orderId: crypto.randomUUID() }, 201);
  }

  const type = cleanText(input.type, 20);
  const name = cleanText(input.name, 80);
  const phone = cleanText(input.phone, 30);
  const city = cleanText(input.city, 80);
  const address = cleanText(input.address, 300);
  const details = cleanText(input.details, 1500);
  const quantity = Number(input.quantity);
  const eventDate = cleanText(input.eventDate, 10) || null;
  const orderDetails = details || (type === 'workshop' ? 'طلب حجز ورشة' : '');

  if (!allowedTypes.has(type) || !name || !phone || !city || !orderDetails ||
      !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) {
    return jsonResponse({ error: 'invalid_order' }, 400);
  }

  if (!/^[+\d][\d\s().-]{5,29}$/.test(phone)) {
    return jsonResponse({ error: 'invalid_phone' }, 400);
  }

  if (type === 'product' && !address) {
    return jsonResponse({ error: 'address_required' }, 400);
  }

  if (eventDate && (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) ||
      Number.isNaN(Date.parse(`${eventDate}T00:00:00Z`)) ||
      new Date(`${eventDate}T00:00:00Z`).toISOString().slice(0, 10) !== eventDate)) {
    return jsonResponse({ error: 'invalid_date' }, 400);
  }

  try {
    if (!await consumeRateLimit(request, env.ORDERS)) {
      return jsonResponse({ error: 'rate_limited' }, 429);
    }
  } catch {
    return jsonResponse({ error: 'service_unavailable' }, 503);
  }

  const id = crypto.randomUUID();
  try {
    await env.ORDERS.prepare(
      `INSERT INTO orders (id, type, name, phone, city, address, details, quantity, event_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, type, name, phone, city, address || null, orderDetails, quantity, eventDate).run();
  } catch {
    return jsonResponse({ error: 'save_failed' }, 500);
  }

  return jsonResponse({ ok: true, orderId: id }, 201);
}
