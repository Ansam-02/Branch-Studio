import { IMAGE_PATH, MAX_PRODUCT_IMAGES, inputError, jsonResponse, productColumns, publicProduct, readJson, sameOrigin, text } from '../../../lib/commerce.js';

function normalize(input) {
  const name = text(input.name, 120);
  const description = text(input.description, 2000);
  const { priceMinor, stock, published, images } = input;
  const salePriceMinor = input.salePriceMinor ?? null;
  if (!name || typeof input.description !== 'string' || input.description.trim().length > 2000 ||
      !Number.isSafeInteger(priceMinor) || priceMinor < 0 || priceMinor > 100000000 ||
      (salePriceMinor !== null && (!Number.isSafeInteger(salePriceMinor) || salePriceMinor < 0 || salePriceMinor >= priceMinor)) ||
      !Number.isSafeInteger(stock) || stock < 0 || stock > 100000 ||
      typeof published !== 'boolean' || !Array.isArray(images) || images.length > MAX_PRODUCT_IMAGES ||
      images.some(url => typeof url !== 'string' || !IMAGE_PATH.test(url)) ||
      new Set(images).size !== images.length || (published && !images.length)) return null;
  return { name, description, priceMinor, salePriceMinor, stock, published: Number(published), images };
}

export async function onRequest({ request, env }) {
  if (!env.ORDERS) return jsonResponse({ error: 'service_unavailable' }, 503);
  if (request.method === 'GET') {
    try {
      const result = await env.ORDERS.prepare(
        `SELECT ${productColumns} FROM products WHERE archived = 0 ORDER BY created_at DESC, id DESC LIMIT 200`,
      ).all();
      return jsonResponse({ products: (result.results || []).map(publicProduct) });
    } catch {
      return jsonResponse({ error: 'service_unavailable' }, 503);
    }
  }
  if (!['POST', 'PUT', 'DELETE'].includes(request.method)) return jsonResponse({ error: 'method_not_allowed' }, 405);
  if (!sameOrigin(request)) return jsonResponse({ error: 'origin_not_allowed' }, 403);
  let input;
  try { input = await readJson(request); } catch (error) { return inputError(error); }
  const id = text(input.id, 80);
  if (request.method === 'DELETE') {
    if (!id) return jsonResponse({ error: 'invalid_product' }, 400);
    try {
      const row = await env.ORDERS.prepare(
        `UPDATE products SET archived = 1, published = 0, version = version + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND archived = 0 RETURNING id`,
      ).bind(id).first();
      return row ? jsonResponse({ ok: true, id }) : jsonResponse({ error: 'not_found' }, 404);
    } catch { return jsonResponse({ error: 'service_unavailable' }, 503); }
  }
  const product = normalize(input);
  if (!product || (request.method === 'PUT' && (!id || !Number.isSafeInteger(input.version) || input.version < 1))) return jsonResponse({ error: 'invalid_product' }, 400);
  try {
    if (product.images.length) {
      const keys = product.images.map(url => IMAGE_PATH.exec(url)[1]);
      const found = await env.ORDERS.prepare(
        `SELECT COUNT(*) AS count FROM product_uploads WHERE key IN (${keys.map(() => '?').join(',')})`,
      ).bind(...keys).first();
      if (Number(found?.count) !== keys.length) return jsonResponse({ error: 'invalid_product_images' }, 400);
    }
    const productId = request.method === 'POST' ? crypto.randomUUID() : id;
    const values = [product.name, product.description, product.priceMinor, product.stock, product.published, JSON.stringify(product.images)];
    const write = request.method === 'POST'
      ? env.ORDERS.prepare(
        `INSERT INTO products (name, description, price_minor, stock, published, images_json, id)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      ).bind(...values, productId)
      : env.ORDERS.prepare(
        `UPDATE products SET name = ?, description = ?, price_minor = ?, stock = ?, published = ?, images_json = ?, version = version + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND archived = 0 AND version = ? RETURNING id`,
      ).bind(...values, productId, input.version);
    // changes() is evaluated directly after the guarded product write in the
    // same D1 transaction. A stale version must not modify the offer either.
    const offerWrite = product.salePriceMinor === null
      ? env.ORDERS.prepare('DELETE FROM product_offers WHERE product_id = ? AND changes() = 1').bind(productId)
      : env.ORDERS.prepare(
        `INSERT INTO product_offers (product_id, original_price_minor, sale_price_minor)
         SELECT ?, ?, ? WHERE changes() = 1
         ON CONFLICT (product_id) DO UPDATE SET original_price_minor = excluded.original_price_minor,
           sale_price_minor = excluded.sale_price_minor`,
      ).bind(productId, product.priceMinor, product.salePriceMinor);
    const results = await env.ORDERS.batch([
      write, offerWrite,
      env.ORDERS.prepare(`SELECT ${productColumns} FROM products WHERE id = ? AND archived = 0`).bind(productId),
    ]);
    const written = results[0]?.results?.[0];
    const row = results[2]?.results?.[0];
    if (!written) return jsonResponse({ error: row ? 'product_changed' : 'not_found' }, row ? 409 : 404);
    return row ? jsonResponse({ product: publicProduct(row) }, request.method === 'POST' ? 201 : 200)
      : jsonResponse({ error: 'service_unavailable' }, 503);
  } catch {
    return jsonResponse({ error: 'service_unavailable' }, 503);
  }
}
