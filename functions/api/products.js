import { jsonResponse, productColumns, publicProduct } from '../../lib/commerce.js';

export async function onRequest({ request, env }) {
  if (!['GET', 'HEAD'].includes(request.method)) return jsonResponse({ error: 'method_not_allowed' }, 405);
  if (!env.ORDERS) return jsonResponse({ error: 'service_unavailable' }, 503);
  try {
    const result = await env.ORDERS.prepare(
      `SELECT ${productColumns} FROM products WHERE published = 1 AND archived = 0
       ORDER BY created_at DESC, id DESC LIMIT 200`,
    ).all();
    const response = jsonResponse({ products: (result.results || []).map(publicProduct) });
    return request.method === 'HEAD' ? new Response(null, response) : response;
  } catch {
    return jsonResponse({ error: 'service_unavailable' }, 503);
  }
}
