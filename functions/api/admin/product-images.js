import { MAX_IMAGE_BYTES, jsonResponse, readLimitedBody, sameOrigin } from '../../../lib/commerce.js';

function detectType(bytes) {
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
    return { extension: 'png', type: 'image/png' };
  }
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return { extension: 'jpg', type: 'image/jpeg' };
  }
  if (bytes.length >= 16 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') {
    return { extension: 'webp', type: 'image/webp' };
  }
  return null;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  if (!sameOrigin(request)) return jsonResponse({ error: 'origin_not_allowed' }, 403);
  if (!env.PRODUCT_IMAGES || !env.ORDERS) return jsonResponse({ error: 'image_storage_unavailable' }, 503);
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return jsonResponse({ error: 'unsupported_media_type' }, 415);
  let file;
  try {
    const raw = await readLimitedBody(request, MAX_IMAGE_BYTES + 65536);
    const form = await new Response(raw, { headers: { 'Content-Type': contentType } }).formData();
    file = form.get('file');
  } catch (error) {
    return jsonResponse({ error: error.message === 'payload_too_large' ? 'image_too_large' : 'invalid_upload' }, error.message === 'payload_too_large' ? 413 : 400);
  }
  if (!file || typeof file.arrayBuffer !== 'function' || file.size < 1) return jsonResponse({ error: 'invalid_upload' }, 400);
  if (file.size > MAX_IMAGE_BYTES) return jsonResponse({ error: 'image_too_large' }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = detectType(bytes);
  if (!format || (file.type && file.type !== format.type)) return jsonResponse({ error: 'unsupported_image' }, 415);
  const key = `${crypto.randomUUID()}.${format.extension}`;
  try {
    await env.PRODUCT_IMAGES.put(key, bytes, {
      httpMetadata: { contentType: format.type },
      customMetadata: { source: 'admin-product-upload' },
    });
    await env.ORDERS.prepare('INSERT INTO product_uploads (key, content_type, size_bytes) VALUES (?, ?, ?)')
      .bind(key, format.type, bytes.byteLength).run();
    return jsonResponse({ url: `/media/${key}` }, 201);
  } catch {
    try { await env.PRODUCT_IMAGES.delete(key); } catch { /* Best-effort cleanup of an unreferenced upload. */ }
    return jsonResponse({ error: 'image_upload_failed' }, 503);
  }
}
