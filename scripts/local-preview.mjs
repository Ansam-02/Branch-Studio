/**
 * Development-only preview with a local administrator and persistent local data.
 * This file is never part of a Pages deployment. Production uses Cloudflare Access.
 */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, rename, realpath, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const maxBodyBytes = 6 * 1024 * 1024;
const publicFiles = new Set([
  'storefront.html', 'storefront.css', 'storefront.js', 'visual-motion.js',
  'pages.css', 'products.css', 'shop.js', 'shop.css', 'cart.js', 'cart.css',
  'lib/palestine-time.js', 'lib/cart.js', 'lib/cart-storage.js', 'lib/cartstorage.js',
]);
const publicPages = new Set(['products', 'services', 'workshops', 'gallery', 'about', 'request', 'cart']);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};
const routeFiles = new Map([
  ['/api/orders', 'functions/api/orders.js'],
  ['/api/workshops', 'functions/api/workshops.js'],
  ['/api/workshop-bookings', 'functions/api/workshop-bookings.js'],
  ['/api/products', 'functions/api/products.js'],
  ['/api/checkout', 'functions/api/checkout.js'],
  ['/api/admin/overview', 'functions/api/admin/overview.js'],
  ['/api/admin/orders', 'functions/api/admin/orders.js'],
  ['/api/admin/bookings', 'functions/api/admin/bookings.js'],
  ['/api/admin/workshops', 'functions/api/admin/workshops.js'],
  ['/api/admin/products', 'functions/api/admin/products.js'],
  ['/api/admin/product-images', 'functions/api/admin/product-images.js'],
]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** A small local adapter for the D1 operations used by the actual handlers. */
function d1Database(sql) {
  const execute = (query, values) => {
    const statement = sql.prepare(query);
    const results = statement.all(...values);
    const changes = Number(sql.prepare('SELECT changes() AS n').get().n);
    return { success: true, results, meta: { changes, last_row_id: Number(sql.prepare('SELECT last_insert_rowid() AS n').get().n) } };
  };
  const prepare = (query, values = []) => ({
    bind(...nextValues) { return prepare(query, nextValues); },
    async first(column) {
      const result = sql.prepare(query).get(...values);
      if (result === undefined) return null;
      if (column !== undefined) {
        if (!Object.hasOwn(result, column)) throw new Error(`Unknown result column: ${column}`);
        return result[column];
      }
      return result;
    },
    async all() { return execute(query, values); },
    async run() { return execute(query, values); },
    async raw({ columnNames = false } = {}) {
      const statement = sql.prepare(query);
      const columns = statement.columns().map(column => column.name);
      const rows = statement.all(...values).map(row => columns.map(name => row[name]));
      return columnNames ? [columns, ...rows] : rows;
    },
    execute() { return execute(query, values); },
  });
  return {
    prepare,
    async batch(statements) {
      sql.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.execute());
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(query) {
      sql.exec(query);
      return { count: 1, duration: 0 };
    },
  };
}

/** Local R2-compatible object storage. Keys are hashed to prevent path traversal. */
function imageBucket(directory) {
  const baseFor = key => join(directory, createHash('sha256').update(String(key)).digest('hex'));
  const metadataHeaders = (metadata, headers) => {
    for (const [property, header] of [
      ['contentType', 'Content-Type'], ['contentLanguage', 'Content-Language'],
      ['contentDisposition', 'Content-Disposition'], ['contentEncoding', 'Content-Encoding'],
      ['cacheControl', 'Cache-Control'],
    ]) if (metadata[property]) headers.set(header, metadata[property]);
    if (metadata.cacheExpiry) headers.set('Expires', new Date(metadata.cacheExpiry).toUTCString());
  };
  const object = (metadata, bytes) => ({
    key: metadata.key,
    size: metadata.size,
    etag: metadata.etag,
    httpEtag: `"${metadata.etag}"`,
    uploaded: new Date(metadata.uploaded),
    httpMetadata: metadata.httpMetadata,
    customMetadata: metadata.customMetadata,
    ...(bytes ? {
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => bytes.toString('utf8'),
      json: async () => JSON.parse(bytes.toString('utf8')),
    } : {}),
    writeHttpMetadata(headers) { metadataHeaders(metadata.httpMetadata, headers); },
  });
  return {
    async put(key, value, options = {}) {
      let bytes;
      if (typeof value === 'string') bytes = Buffer.from(value);
      else if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
      else if (ArrayBuffer.isView(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      else if (value && typeof value.arrayBuffer === 'function') bytes = Buffer.from(await value.arrayBuffer());
      else bytes = Buffer.from(await new Response(value).arrayBuffer());
      if (bytes.byteLength > maxBodyBytes) throw new Error('Local image exceeds upload limit');
      await mkdir(directory, { recursive: true });
      const metadata = {
        key: String(key), size: bytes.byteLength,
        etag: createHash('sha256').update(bytes).digest('hex'), uploaded: new Date().toISOString(),
        httpMetadata: options.httpMetadata || {}, customMetadata: options.customMetadata || {},
      };
      const base = baseFor(key);
      const temporary = `${base}.${randomUUID()}`;
      await writeFile(`${temporary}.data`, bytes);
      await writeFile(`${temporary}.json`, JSON.stringify(metadata));
      await rename(`${temporary}.data`, `${base}.data`);
      await rename(`${temporary}.json`, `${base}.json`);
      return object(metadata);
    },
    async get(key) {
      const base = baseFor(key);
      try {
        const [bytes, text] = await Promise.all([readFile(`${base}.data`), readFile(`${base}.json`, 'utf8')]);
        return object(JSON.parse(text), bytes);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const base = baseFor(key);
        await Promise.all(['.data', '.json'].map(extension => unlink(base + extension).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        })));
      }
    },
  };
}

function allowedStaticFile(path) {
  if (publicFiles.has(path)) return true;
  if (/^admin\/[a-zA-Z0-9_-]+\.(?:html|css|js)$/.test(path)) return true;
  if (path.startsWith('assets/')) {
    const extension = extname(path).toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg', '.ico', '.woff2', '.woff', '.ttf'].includes(extension) ||
      /\/[^/]+-OFL\.txt$/.test(path);
  }
  return [...publicPages].some(page => path === `${page}/index.html`);
}

async function staticResponse(url, root) {
  let path;
  try { path = decodeURIComponent(url.pathname); }
  catch { return json({ error: 'invalid_path' }, 400); }
  if (path.includes('\0') || path.includes('\\') || path.split('/').some(part => part.startsWith('.'))) {
    return json({ error: 'not_found' }, 404);
  }
  if (path === '/' || path === '/storefront' || path === '/storefront.html') path = '/storefront.html';
  if (path === '/admin') return new Response(null, { status: 308, headers: { Location: '/admin/' } });
  const page = path.slice(1).replace(/\/$/, '');
  if (publicPages.has(page) && !path.endsWith('/')) {
    return new Response(null, { status: 308, headers: { Location: `${path}/${url.search}` } });
  }
  if (path === '/admin/' || publicPages.has(page)) path = `${path}index.html`;
  const relativePath = path.slice(1);
  if (!allowedStaticFile(relativePath)) return json({ error: 'not_found' }, 404);
  try {
    const filename = await realpath(join(root, relativePath));
    const realRoot = await realpath(root);
    if (!filename.startsWith(realRoot + sep)) return json({ error: 'not_found' }, 404);
    const bytes = await readFile(filename);
    return new Response(bytes, {
      headers: { 'Content-Type': mimeTypes[extname(filename).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return json({ error: 'not_found' }, 404);
    throw error;
  }
}

async function readBody(request) {
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) {
    request.resume();
    throw Object.assign(new Error('payload_too_large'), { status: 413 });
  }
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        if (!rejected) rejectBody(Object.assign(new Error('payload_too_large'), { status: 413 }));
        rejected = true;
        chunks.length = 0;
      } else if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => { if (!rejected) resolveBody(Buffer.concat(chunks)); });
    request.on('error', rejectBody);
    request.on('aborted', () => rejectBody(new Error('request_aborted')));
  });
}

async function securityHeaders(root) {
  const headers = new Headers({
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  try {
    for (const line of (await readFile(join(root, '_headers'), 'utf8')).split('\n')) {
      const match = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
      if (match && match[1].toLowerCase() !== 'access-control-allow-origin') headers.set(match[1], match[2]);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return headers;
}

export async function createLocalPreview({ root = projectRoot, dataDirectory = join(root, '.local-preview'), port = 8791 } = {}) {
  await mkdir(dataDirectory, { recursive: true });
  const sql = new DatabaseSync(join(dataDirectory, 'store.sqlite'));
  try {
    sql.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    sql.exec(await readFile(join(root, 'schema.sql'), 'utf8'));
  } catch (error) { sql.close(); throw error; }
  const env = { ORDERS: d1Database(sql), PRODUCT_IMAGES: imageBucket(join(dataDirectory, 'images')) };
  const safeHeaders = await securityHeaders(root);
  const loadedHandlers = new Map();
  const pendingTasks = new Set();
  let boundPort = port;

  async function dispatch(request) {
    const url = new URL(request.url);
    let file = routeFiles.get(url.pathname);
    const params = {};
    if (/^\/media\/[^/]+$/.test(url.pathname)) {
      file = 'functions/media/[id].js';
      params.id = decodeURIComponent(url.pathname.slice('/media/'.length));
    }
    if (!file) {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
        return json({ error: 'not_found' }, 404);
      }
      if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
      return staticResponse(url, root);
    }
    if (url.pathname.startsWith('/api/admin/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        request.headers.get('Origin') !== url.origin) {
      return json({ error: 'origin_not_allowed' }, 403);
    }
    let handler = loadedHandlers.get(file);
    if (!handler) {
      try {
        const module = await import(pathToFileURL(join(root, file)).href);
        handler = module.onRequest;
        if (typeof handler !== 'function') throw new Error('Handler not implemented');
        loadedHandlers.set(file, handler);
      } catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND') return json({ error: 'preview_handler_unavailable' }, 503);
        throw error;
      }
    }
    return handler({
      request, env, params, data: {}, next: () => json({ error: 'not_found' }, 404),
      waitUntil(task) {
        const promise = Promise.resolve(task).catch(error => console.error('Local background task failed:', error.message));
        pendingTasks.add(promise);
        promise.finally(() => pendingTasks.delete(promise));
      },
    });
  }

  const server = createServer(async (incoming, outgoing) => {
    const send = async response => {
      const headers = new Headers(safeHeaders);
      for (const [name, value] of response.headers) {
        if (name.toLowerCase() !== 'access-control-allow-origin') headers.set(name, value);
      }
      outgoing.writeHead(response.status, Object.fromEntries(headers));
      if (incoming.method === 'HEAD' || !response.body) return outgoing.end();
      await pipeline(Readable.fromWeb(response.body), outgoing);
    };
    try {
      const authority = (incoming.headers.host || '').toLowerCase();
      const allowedAuthorities = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
      if (boundPort === 80) ['127.0.0.1', 'localhost'].forEach(host => allowedAuthorities.add(host));
      if (!allowedAuthorities.has(authority) || incoming.headers['sec-fetch-site'] === 'cross-site') {
        incoming.resume();
        return await send(json({ error: 'local_host_required' }, 403));
      }
      const authorityUrl = new URL(`http://${authority}`);
      const url = new URL(incoming.url, authorityUrl.origin);
      if (url.origin !== authorityUrl.origin) return await send(json({ error: 'local_host_required' }, 403));
      const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : await readBody(incoming);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      headers.set('CF-Connecting-IP', '127.0.0.1');
      const request = new Request(url, { method: incoming.method, headers, ...(body ? { body } : {}) });
      await send(await dispatch(request));
    } catch (error) {
      if (outgoing.headersSent) outgoing.destroy(error);
      else {
        if (!error.status) console.error('Local preview request failed:', error.message);
        await send(json({ error: error.status === 413 ? 'payload_too_large' : 'preview_error' }, error.status || 500));
      }
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, '127.0.0.1', resolveListen);
    });
  } catch (error) { sql.close(); throw error; }
  boundPort = server.address().port;
  let closing;
  return {
    server, env, url: `http://127.0.0.1:${boundPort}`,
    close() {
      closing ??= (async () => {
        await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
        await Promise.allSettled(pendingTasks);
        sql.close();
      })();
      return closing;
    },
  };
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--help') {
      console.log('Usage: node scripts/local-preview.mjs [--port 8791] [--data-dir .local-preview]');
      return;
    }
    if (args[index] === '--port') {
      const value = args[++index];
      if (!/^\d+$/.test(value || '') || Number(value) > 65535) throw new Error('Choose a valid local port');
      options.port = Number(value);
    } else if (args[index] === '--data-dir') {
      const value = args[++index];
      if (!value) throw new Error('A local data directory is required');
      options.dataDirectory = isAbsolute(value) ? value : resolve(projectRoot, value);
    } else throw new Error(`Unknown option: ${args[index]}`);
  }
  const preview = await createLocalPreview(options);
  console.log(`Local development preview: ${preview.url}`);
  console.log(`Local administrator: ${preview.url}/admin/`);
  console.log('Development only: local data stays on this computer. Production administration still requires Cloudflare Access.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.close().catch(error => {
    console.error('Could not close local preview:', error.message);
    process.exitCode = 1;
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Local preview could not start: ${error.message}`);
    process.exitCode = 1;
  });
}
