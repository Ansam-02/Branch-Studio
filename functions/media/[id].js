import { IMAGE_PATH } from '../../lib/commerce.js';

export async function onRequest({ request, env, params }) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const id = params?.id;
  if (typeof id !== 'string' || !IMAGE_PATH.test(`/media/${id}`)) return new Response(null, { status: 404 });
  if (!env.PRODUCT_IMAGES) return new Response(null, { status: 503 });
  try {
    const object = await env.PRODUCT_IMAGES.get(id);
    if (!object) return new Response(null, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(headers.get('Content-Type'))) return new Response(null, { status: 404 });
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    headers.set('ETag', object.httpEtag);
    if (request.headers.get('If-None-Match') === object.httpEtag) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  } catch { return new Response(null, { status: 503 }); }
}
