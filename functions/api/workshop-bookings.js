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
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  if (!env.ORDERS) {
    return jsonResponse({ error: 'service_unavailable' }, 503);
  }

  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) {
    return jsonResponse({ error: 'origin_not_allowed' }, 403);
  }

  const contentType = request.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.startsWith('application/json')) {
    return jsonResponse({ error: 'unsupported_media_type' }, 415);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 8192) {
    return jsonResponse({ error: 'payload_too_large' }, 413);
  }

  let input;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 8192) {
      return jsonResponse({ error: 'payload_too_large' }, 413);
    }
    input = JSON.parse(body);
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      input.privacyAccepted !== true) {
    return jsonResponse({ error: 'invalid_booking' }, 400);
  }

  if (cleanText(input.website, 200)) {
    return jsonResponse({ ok: true, bookingId: crypto.randomUUID(), status: 'requested' }, 201);
  }

  const workshopId = cleanText(input.workshopId, 80);
  const name = cleanText(input.name, 80);
  const phone = cleanText(input.phone, 30);
  const seats = Number(input.seats);
  const attendeeNames = Array.isArray(input.attendeeNames)
    ? input.attendeeNames.map(attendeeName => cleanText(attendeeName, 80))
    : [];
  if (!workshopId || !name || !phone || !/^[+\d][\d\s().-]{5,29}$/.test(phone) ||
      !Number.isSafeInteger(seats) || seats < 1 || seats > 8 ||
      attendeeNames.length !== seats || attendeeNames.some(attendeeName => !attendeeName)) {
    return jsonResponse({ error: 'invalid_booking' }, 400);
  }

  try {
    if (!await consumeRateLimit(request, env.ORDERS)) {
      return jsonResponse({ error: 'rate_limited' }, 429);
    }

    const bookingId = crypto.randomUUID();
    const bookingStatement = env.ORDERS.prepare(
      `INSERT INTO workshop_bookings (id, workshop_id, name, phone, seats)
       SELECT ?, w.id, ?, ?, ?
       FROM workshops w
       WHERE w.id = ?
         AND w.published = 1
         AND datetime(w.starts_at) > datetime('now')
         AND ? <= w.capacity - COALESCE((
           SELECT SUM(b.seats) FROM workshop_bookings b
           WHERE b.workshop_id = w.id AND b.status IN ('requested', 'confirmed')
         ), 0)
       RETURNING id`,
      ).bind(bookingId, name, phone, seats, workshopId, seats);
      const attendeeStatements = attendeeNames.map((attendeeName, index) => env.ORDERS.prepare(
        `INSERT INTO workshop_booking_attendees (booking_id, seat_number, name)
         SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM workshop_bookings WHERE id = ?)
         RETURNING seat_number`,
      ).bind(bookingId, index + 1, attendeeName, bookingId));
      const results = await env.ORDERS.batch([bookingStatement, ...attendeeStatements]);

      if (!results[0]?.success || results[0].meta?.changes !== 1) {
      return jsonResponse({ error: 'workshop_unavailable' }, 409);
    }
      if (results.slice(1).some(result => !result.success || result.meta?.changes !== 1)) {
        return jsonResponse({ error: 'service_unavailable' }, 503);
      }

    return jsonResponse({ ok: true, bookingId, status: 'requested' }, 201);
  } catch {
    return jsonResponse({ error: 'service_unavailable' }, 503);
  }
}