import { parsePagination, paginationSummary } from '../../../lib/pagination.js';

const bookingStatuses = new Set(['requested', 'confirmed', 'cancelled']);

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

export async function onRequest({ request, env }) {
  if (!env.ORDERS) return jsonResponse({ error: 'service_unavailable' }, 503);

  if (request.method === 'GET') {
    const params = new URL(request.url).searchParams;
    const pagination = parsePagination(params);
    if (!pagination) return jsonResponse({ error: 'invalid_pagination' }, 400);
    const status = params.get('status') || '';
    if (status && !bookingStatuses.has(status)) return jsonResponse({ error: 'invalid_status' }, 400);
    const where = status ? 'WHERE status = ?' : '';
    try {
      const filterBindings = status ? [status] : [];
      const [result, count] = await Promise.all([env.ORDERS.prepare(
        `WITH filtered_bookings AS (
           SELECT b.* FROM workshop_bookings b ${where}
           ORDER BY b.created_at DESC, b.id DESC LIMIT ? OFFSET ?
         )
         SELECT b.id, b.workshop_id, b.name, b.phone, b.seats, b.status, b.created_at,
                w.title AS workshop_title, w.starts_at, w.city, w.venue,
                a.seat_number, a.name AS attendee_name
         FROM filtered_bookings b
         JOIN workshops w ON w.id = b.workshop_id
         LEFT JOIN workshop_booking_attendees a ON a.booking_id = b.id
         ORDER BY b.created_at DESC, b.id DESC, a.seat_number ASC`,
      ).bind(...filterBindings, pagination.limit, pagination.offset).all(),
      env.ORDERS.prepare(`SELECT COUNT(*) AS total FROM workshop_bookings ${where}`)
        .bind(...filterBindings).first()]);
      const bookings = new Map();
      for (const row of result.results || []) {
        if (!bookings.has(row.id)) {
          const { attendee_name, seat_number, ...booking } = row;
          bookings.set(row.id, { ...booking, attendeeNames: [] });
        }
        if (row.attendee_name) bookings.get(row.id).attendeeNames.push(row.attendee_name);
      }
      return jsonResponse({
        bookings: [...bookings.values()],
        pagination: paginationSummary(pagination, Number(count?.total || 0)),
      });
    } catch {
      return jsonResponse({ error: 'service_unavailable' }, 503);
    }
  }

  if (request.method === 'PATCH') {
    const input = await readBody(request);
    const id = typeof input?.id === 'string' ? input.id.trim().slice(0, 80) : '';
    const status = typeof input?.status === 'string' ? input.status : '';
    if (!id || !bookingStatuses.has(status)) return jsonResponse({ error: 'invalid_booking_update' }, 400);

    try {
      const result = await env.ORDERS.prepare(
        `UPDATE workshop_bookings
         SET status = ?
         WHERE id = ? AND (
           ? = 'cancelled' OR seats <= (
             SELECT w.capacity - COALESCE(SUM(b.seats), 0)
             FROM workshops w
             LEFT JOIN workshop_bookings b
               ON b.workshop_id = w.id
              AND b.status IN ('requested', 'confirmed')
              AND b.id <> workshop_bookings.id
             WHERE w.id = workshop_bookings.workshop_id
           )
         )
         RETURNING id, status`,
      ).bind(status, id, status).first();
      if (result) return jsonResponse({ booking: result });

      const existing = await env.ORDERS.prepare('SELECT id FROM workshop_bookings WHERE id = ?').bind(id).first();
      return existing
        ? jsonResponse({ error: 'capacity_exceeded' }, 409)
        : jsonResponse({ error: 'not_found' }, 404);
    } catch {
      return jsonResponse({ error: 'service_unavailable' }, 503);
    }
  }

  return jsonResponse({ error: 'method_not_allowed' }, 405);
}
