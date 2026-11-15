import { palestineMonthBounds, palestineMonthKey } from '../../lib/palestine-time.js';

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

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  if (!env.ORDERS) {
    return jsonResponse({ error: 'service_unavailable' }, 503);
  }

  const month = new URL(request.url).searchParams.get('month') || palestineMonthKey();
  let bounds;
  try {
    bounds = palestineMonthBounds(month);
  } catch {
    return jsonResponse({ error: 'invalid_month' }, 400);
  }

  try {
    const result = await env.ORDERS.prepare(
      `SELECT w.id, w.title, w.starts_at, w.city, w.venue, w.price_minor, w.capacity,
              w.capacity - COALESCE(SUM(CASE WHEN b.status IN ('requested', 'confirmed') THEN b.seats ELSE 0 END), 0) AS seats_left
       FROM workshops w
       LEFT JOIN workshop_bookings b ON b.workshop_id = w.id
       WHERE w.published = 1
         AND datetime(w.starts_at) > datetime('now')
            AND datetime(w.starts_at) >= datetime(?)
            AND datetime(w.starts_at) < datetime(?)
       GROUP BY w.id
       ORDER BY datetime(w.starts_at) ASC`,
          ).bind(bounds.start, bounds.end).all();

    return jsonResponse({ workshops: result.results || [] });
  } catch {
    return jsonResponse({ error: 'service_unavailable' }, 503);
  }
}
