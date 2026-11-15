import { UUID, consumeCheckoutRateLimit, effectivePrice, hashText, inputError, jsonResponse, productColumns, publicProduct, readJson, sameOrigin, text } from '../../lib/commerce.js';

function normalize(input) {
  const requestId = text(input.requestId, 36).toLowerCase();
  const name = text(input.name, 80);
  const phone = text(input.phone, 30);
  const city = text(input.city, 80);
  const address = text(input.address, 300);
  if (!UUID.test(requestId) || !name || !city || !address || !/^[+\d][\d\s().-]{5,29}$/.test(phone) ||
      !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) return null;
  const items = [];
  for (const item of input.items) {
    if (!item || typeof item !== 'object') return null;
    const productId = text(item.productId, 80);
    if (!productId || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99 ||
        !Number.isSafeInteger(item.priceMinor) || item.priceMinor < 0 || item.priceMinor > 100000000) return null;
    items.push({ productId, quantity: item.quantity, priceMinor: item.priceMinor });
  }
  if (new Set(items.map(item => item.productId)).size !== items.length) return null;
  items.sort((a, b) => a.productId.localeCompare(b.productId));
  return { requestId, name, phone, city, address, items };
}

function orderResponse(row, status = 200) {
  return jsonResponse({ ok: true, orderId: row.order_id, subtotalMinor: row.subtotal_minor, currency: 'ILS' }, status);
}

async function previousCheckout(database, requestId) {
  return database.prepare('SELECT order_id, payload_hash, subtotal_minor FROM cart_checkouts WHERE request_id = ?').bind(requestId).first();
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  if (!sameOrigin(request)) return jsonResponse({ error: 'origin_not_allowed' }, 403);
  if (!env.ORDERS) return jsonResponse({ error: 'service_unavailable' }, 503);
  let input;
  try { input = await readJson(request); } catch (error) { return inputError(error); }
  if (input.privacyAccepted !== true) return jsonResponse({ error: 'privacy_consent_required' }, 400);
  if (typeof input.website === 'string' && input.website.trim()) {
    return jsonResponse({ ok: true, orderId: crypto.randomUUID(), subtotalMinor: 0, currency: 'ILS' }, 201);
  }
  const checkout = normalize(input);
  if (!checkout) return jsonResponse({ error: 'invalid_checkout' }, 400);
  const payloadHash = await hashText(JSON.stringify(checkout));
  const database = env.ORDERS;
  try {
    const previous = await previousCheckout(database, checkout.requestId);
    if (previous) {
      return previous.payload_hash === payloadHash ? orderResponse(previous)
        : jsonResponse({ error: 'idempotency_conflict' }, 409);
    }
    if (!await consumeCheckoutRateLimit(request, database)) return jsonResponse({ error: 'rate_limited' }, 429);
    const ids = checkout.items.map(item => item.productId);
    const result = await database.prepare(
      `SELECT ${productColumns} FROM products WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).all();
    const products = new Map((result.results || []).map(row => [row.id, publicProduct(row)]));
    const lines = [];
    for (const item of checkout.items) {
      const product = products.get(item.productId);
      if (!product || !product.published || product.archived || product.stock < item.quantity) {
        return jsonResponse({ error: 'product_unavailable' }, 409);
      }
      if (effectivePrice(product) !== item.priceMinor) return jsonResponse({ error: 'cart_changed' }, 409);
      lines.push({ ...item, product });
    }
    const subtotal = lines.reduce((sum, line) => sum + effectivePrice(line.product) * line.quantity, 0);
    if (!Number.isSafeInteger(subtotal)) return jsonResponse({ error: 'invalid_checkout' }, 400);
    const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
    const details = [
      'طلب من سلة المنتجات:',
      ...lines.map(line => `${line.product.name} × ${line.quantity} — ${(effectivePrice(line.product) * line.quantity / 100).toFixed(2)} شيكل`),
      `مجموع المنتجات: ${(subtotal / 100).toFixed(2)} شيكل. التوصيل يؤكّد بالتواصل. الدفع عند الاستلام.`,
    ].join('\n');
    const orderId = crypto.randomUUID();
    const statements = [
      database.prepare(
        `INSERT INTO orders (id, type, name, phone, city, address, details, quantity, event_date, payment_method)
         VALUES (?, 'product', ?, ?, ?, ?, ?, ?, NULL, 'cash_on_delivery')`,
      ).bind(orderId, checkout.name, checkout.phone, checkout.city, checkout.address, details, quantity),
      database.prepare(
        'INSERT INTO cart_checkouts (request_id, order_id, payload_hash, subtotal_minor) VALUES (?, ?, ?, ?)',
      ).bind(checkout.requestId, orderId, payloadHash, subtotal),
      ...lines.map(line => database.prepare(
        `INSERT INTO order_items (order_id, product_id, name, description, image_url, unit_price_minor, quantity)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(orderId, line.productId, line.product.name, line.product.description, line.product.images[0] || null, effectivePrice(line.product), line.quantity)),
    ];
    try {
      await database.batch(statements);
    } catch (error) {
      // Concurrent duplicate submissions may reach the uniqueness check together.
      // Return the existing result only when every normalized field also matches.
      const existing = await previousCheckout(database, checkout.requestId);
      if (existing) return existing.payload_hash === payloadHash ? orderResponse(existing)
        : jsonResponse({ error: 'idempotency_conflict' }, 409);
      if (String(error.message).includes('product_unavailable')) return jsonResponse({ error: 'cart_changed' }, 409);
      throw error;
    }
    return orderResponse({ order_id: orderId, subtotal_minor: subtotal }, 201);
  } catch {
    return jsonResponse({ error: 'service_unavailable' }, 503);
  }
}
