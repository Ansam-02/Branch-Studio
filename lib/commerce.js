export const MAX_PRODUCT_IMAGES = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_PATH = /^\/media\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:jpg|png|webp))$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function sameOrigin(request) {
  return request.headers.get('Origin') === new URL(request.url).origin;
}

export async function readLimitedBody(request, limit) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > limit) throw new Error('payload_too_large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let lengthRead = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lengthRead += value.byteLength;
      if (lengthRead > limit) {
        await reader.cancel();
        throw new Error('payload_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(lengthRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJson(request, limit = 32768) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('unsupported_media_type');
  }
  const input = JSON.parse(new TextDecoder().decode(await readLimitedBody(request, limit)));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_json');
  return input;
}

export function inputError(error) {
  const message = error.message;
  return jsonResponse({ error: ['payload_too_large', 'unsupported_media_type'].includes(message) ? message : 'invalid_json' },
    message === 'payload_too_large' ? 413 : message === 'unsupported_media_type' ? 415 : 400);
}

export function text(value, max) {
  return typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
}

export function publicProduct(row) {
  let images = [];
  try {
    const parsed = JSON.parse(row.images_json || '[]');
    if (Array.isArray(parsed)) images = parsed.filter(value => typeof value === 'string' && IMAGE_PATH.test(value));
  } catch { /* A damaged image list must not expose arbitrary URLs. */ }
  const { images_json, ...fields } = row;
  return { ...fields, images };
}

export const productColumns = `id, name, description, price_minor, stock, published, archived, version, images_json, created_at, updated_at,
  (SELECT sale_price_minor FROM product_offers
   WHERE product_id = products.id AND original_price_minor = products.price_minor) AS sale_price_minor`;

export function effectivePrice(product) {
  return product.sale_price_minor ?? product.price_minor;
}

export async function hashText(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function consumeCheckoutRateLimit(request, database) {
  const ip = await hashText(`checkout:${request.headers.get('CF-Connecting-IP') || 'local'}`);
  const minute = Math.floor(Date.now() / 60000);
  const row = await database.prepare(
    `INSERT INTO request_limits (ip_hash, minute_bucket, request_count) VALUES (?, ?, 1)
     ON CONFLICT (ip_hash, minute_bucket) DO UPDATE SET request_count = request_count + 1
     RETURNING request_count`,
  ).bind(ip, minute).first();
  if (minute % 10 === 0) {
    await database.prepare('DELETE FROM request_limits WHERE minute_bucket < ?').bind(minute - 10).run();
  }
  return row?.request_count <= 5;
}
