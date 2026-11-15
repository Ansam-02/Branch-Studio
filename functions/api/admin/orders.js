import { parsePagination, paginationSummary } from '../../../lib/pagination.js';

const orderStatuses = new Set(['new', 'reviewing', 'confirmed', 'completed', 'cancelled']);

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
    const search = (params.get('q') || '').trim().slice(0, 80);
    if (status && !orderStatuses.has(status)) return jsonResponse({ error: 'invalid_status' }, 400);

    const conditions = [];
    const bindings = [];
    if (status) {
      conditions.push('status = ?');
      bindings.push(status);
    }
    if (search) {
      conditions.push('(name LIKE ? OR phone LIKE ? OR city LIKE ? OR details LIKE ?)');
      const term = `%${search}%`;
      bindings.push(term, term, term, term);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
      const [result, count] = await Promise.all([env.ORDERS.prepare(
        `SELECT id, type, name, phone, city, address, details, quantity, event_date, status, created_at,
                (SELECT subtotal_minor FROM cart_checkouts WHERE order_id = orders.id) AS subtotal_minor,
                payment_method
         FROM orders ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ).bind(...bindings, pagination.limit, pagination.offset).all(),
      env.ORDERS.prepare(`SELECT COUNT(*) AS total FROM orders ${where}`).bind(...bindings).first()]);
      const orders = result.results || [];
      if (orders.length) {
        const ids = orders.map(order => order.id);
        const itemsResult = await env.ORDERS.prepare(
          `SELECT order_id, product_id, name, description, image_url, unit_price_minor, quantity
           FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY name, product_id`,
        ).bind(...ids).all();
        for (const order of orders) order.items = (itemsResult.results || []).filter(item => item.order_id === order.id);
      }
      return jsonResponse({
        orders,
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
    if (!id || !orderStatuses.has(status)) return jsonResponse({ error: 'invalid_order_update' }, 400);

    try {
      const result = await env.ORDERS.prepare(
        'UPDATE orders SET status = ? WHERE id = ? RETURNING id, status',
      ).bind(status, id).first();
      return result ? jsonResponse({ order: result }) : jsonResponse({ error: 'not_found' }, 404);
    } catch (error) {
      if (String(error.message).includes('product_unavailable')) return jsonResponse({ error: 'product_unavailable' }, 409);
      return jsonResponse({ error: 'service_unavailable' }, 503);
    }
  }

  return jsonResponse({ error: 'method_not_allowed' }, 405);
}
