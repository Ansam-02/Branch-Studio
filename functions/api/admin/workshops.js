function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function readBody(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 8192) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizeWorkshop(input) {
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';
  const city = typeof input.city === 'string' ? input.city.trim().slice(0, 80) : '';
  const venue = typeof input.venue === 'string' ? input.venue.trim().slice(0, 160) : '';
  const startsAt = typeof input.startsAt === 'string' ? input.startsAt.trim() : '';
  const capacity = Number(input.capacity);
  const priceMinor = input.priceMinor === null || input.priceMinor === '' ? null : Number(input.priceMinor);
  const published = input.published === true ? 1 : input.published === false ? 0 : null;

  if (!title || !city || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(startsAt) ||
      Number.isNaN(Date.parse(startsAt)) || new Date(startsAt).toISOString() !== startsAt ||
      !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 500 ||
      (priceMinor !== null && (!Number.isSafeInteger(priceMinor) || priceMinor < 0 || priceMinor > 100000000)) ||
      published === null) {
    return null;
  }
  return { title, city, venue, startsAt, capacity, priceMinor, published };
}

export async function onRequest({ request, env }) {
  if (!env.ORDERS) return jsonResponse({ error: 'service_unavailable' }, 503);

  if (request.method === 'GET') {
    try {
      const result = await env.ORDERS.prepare(
        `SELECT w.id, w.title, w.starts_at, w.city, w.venue, w.price_minor, w.capacity, w.published,
                COALESCE(SUM(CASE WHEN b.status IN ('requested', 'confirmed') THEN b.seats ELSE 0 END), 0) AS booked
         FROM workshops w
         LEFT JOIN workshop_bookings b ON b.workshop_id = w.id
         GROUP BY w.id ORDER BY datetime(w.starts_at) DESC LIMIT 200`,
      ).all();
      return jsonResponse({ workshops: result.results || [] });
    } catch {
      return jsonResponse({ error: 'service_unavailable' }, 503);
    }
  }

  if (request.method === 'POST' || request.method === 'PUT') {
    const input = await readBody(request);
    if (!input) return jsonResponse({ error: 'invalid_json' }, 400);
    const workshop = normalizeWorkshop(input);
    if (!workshop) return jsonResponse({ error: 'invalid_workshop' }, 400);

    try {
      if (request.method === 'POST') {
        const id = crypto.randomUUID();
        await env.ORDERS.prepare(
          `INSERT INTO workshops (id, title, starts_at, city, venue, price_minor, capacity, published)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, workshop.title, workshop.startsAt, workshop.city, workshop.venue || null,
          workshop.priceMinor, workshop.capacity, workshop.published).run();
        return jsonResponse({ id }, 201);
      }

      const id = typeof input.id === 'string' ? input.id.trim().slice(0, 80) : '';
      if (!id) return jsonResponse({ error: 'invalid_workshop' }, 400);
      const result = await env.ORDERS.prepare(
        `UPDATE workshops
         SET title = ?, starts_at = ?, city = ?, venue = ?, price_minor = ?, capacity = ?, published = ?
         WHERE id = ? AND ? >= COALESCE((
           SELECT SUM(seats) FROM workshop_bookings
           WHERE workshop_id = workshops.id AND status IN ('requested', 'confirmed')
         ), 0)
         RETURNING id`,
      ).bind(workshop.title, workshop.startsAt, workshop.city, workshop.venue || null,
        workshop.priceMinor, workshop.capacity, workshop.published, id, workshop.capacity).first();
      if (result) return jsonResponse({ id: result.id });

      const existing = await env.ORDERS.prepare('SELECT id FROM workshops WHERE id = ?').bind(id).first();
      return existing
        ? jsonResponse({ error: 'capacity_below_bookings' }, 409)
        : jsonResponse({ error: 'not_found' }, 404);
    } catch {
      return jsonResponse({ error: 'service_unavailable' }, 503);
    }
  }

  return jsonResponse({ error: 'method_not_allowed' }, 405);
}
