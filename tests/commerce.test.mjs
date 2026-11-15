import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { onRequest as catalog } from '../functions/api/products.js';
import { onRequest as adminProducts } from '../functions/api/admin/products.js';
import { onRequest as uploadImage } from '../functions/api/admin/product-images.js';
import { onRequest as serveImage } from '../functions/media/[id].js';
import { onRequest as checkout } from '../functions/api/checkout.js';
import { onRequest as adminOrders } from '../functions/api/admin/orders.js';

const origin = 'https://branch-studio.pages.dev';
const imageKey = '11111111-1111-4111-8111-111111111111.jpg';
const imageUrl = `/media/${imageKey}`;

function setup(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.prepare('INSERT INTO product_uploads (key, content_type, size_bytes) VALUES (?, ?, ?)').run(imageKey, 'image/jpeg', 100);
  t.after(() => sql.close());
  const db = {
    sql,
    beforeBatch: null,
    prepare(query) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return sql.prepare(query).get(...values) ?? null; },
        async all() { return { success: true, results: sql.prepare(query).all(...values) }; },
        async run() { return { success: true, meta: { changes: Number(sql.prepare(query).run(...values).changes) } }; },
        execute() { return { success: true, results: sql.prepare(query).all(...values) }; },
      };
    },
    async batch(statements) {
      if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; hook(); }
      sql.exec('BEGIN');
      try { const result = statements.map(statement => statement.execute()); sql.exec('COMMIT'); return result; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const images = new Map();
  const bucket = {
    async put(key, value, options) { images.set(key, { bytes: new Uint8Array(value), options }); },
    async delete(key) { images.delete(key); },
    async get(key) {
      const file = images.get(key);
      if (!file) return null;
      return {
        body: file.bytes, httpEtag: '"image-etag"',
        writeHttpMetadata(headers) { headers.set('Content-Type', file.options.httpMetadata.contentType); },
      };
    },
  };
  return { db, sql, env: { ORDERS: db, PRODUCT_IMAGES: bucket }, images };
}

function context(env, path, method = 'GET', input, headers = {}) {
  const requestHeaders = { Origin: origin, 'CF-Connecting-IP': '192.0.2.1', ...headers };
  if (input !== undefined && !(input instanceof FormData)) requestHeaders['Content-Type'] = 'application/json';
  return { env, request: new Request(`${origin}${path}`, { method, headers: requestHeaders,
    ...(input === undefined ? {} : { body: input instanceof FormData ? input : JSON.stringify(input) }) }) };
}

const productInput = (extra = {}) => ({ name: 'كوب يدوي', description: 'تفاصيل القطعة', priceMinor: 1950, stock: 5, published: true, images: [imageUrl], ...extra });
async function createProduct(env, extra = {}) {
  const response = await adminProducts(context(env, '/api/admin/products', 'POST', productInput(extra)));
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).product;
}
const cartInput = (product, extra = {}) => ({ requestId: crypto.randomUUID(), name: 'عميل الاختبار', phone: '+970599000000', city: 'الخليل', address: 'عنوان الاختبار', privacyAccepted: true, website: '', items: [{ productId: product.id, quantity: 2, priceMinor: product.sale_price_minor ?? product.price_minor }], ...extra });
const submit = (env, input) => checkout(context(env, '/api/checkout', 'POST', input));
const stock = (sql, id) => sql.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock;
const countOrders = sql => sql.prepare('SELECT COUNT(*) AS n FROM orders').get().n;

test('catalog hides drafts, validates known image paths, and archives without deleting history', async t => {
  const { env, sql } = setup(t);
  for (const extra of [{ images: [] }, { images: ['https://example.com/one.jpg'] }, { images: ['/media/22222222-2222-4222-8222-222222222222.jpg'] }, { priceMinor: -1 }, { images: Array(6).fill(imageUrl) }]) {
    assert.equal((await adminProducts(context(env, '/api/admin/products', 'POST', productInput(extra)))).status, 400);
  }
  const draft = await createProduct(env, { published: false, images: [] });
  const published = await createProduct(env);
  const listed = await (await catalog(context(env, '/api/products'))).json();
  assert.deepEqual(listed.products.map(p => p.id), [published.id]);
  assert.deepEqual(listed.products[0].images, [imageUrl]);
  assert.equal((await adminProducts(context(env, '/api/admin/products', 'DELETE', { id: published.id }))).status, 200);
  assert.equal(sql.prepare('SELECT archived FROM products WHERE id = ?').get(published.id).archived, 1);
  assert.equal((await (await catalog(context(env, '/api/products'))).json()).products.length, 0);
  assert.deepEqual((await (await adminProducts(context(env, '/api/admin/products'))).json()).products.map(p => p.id), [draft.id]);
});

test('image uploads validate content and size, then serve only safe immutable image keys', async t => {
  const { env, images } = setup(t);
  for (const [content, mime] of [['<svg onload="alert(1)"></svg>', 'image/svg+xml'], ['not an image', 'image/jpeg']]) {
    const form = new FormData(); form.set('file', new Blob([content], { type: mime }), 'upload.jpg');
    assert.equal((await uploadImage(context(env, '/api/admin/product-images', 'POST', form))).status, 415);
  }
  const large = new FormData(); large.set('file', new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' }), 'large.png');
  assert.equal((await uploadImage(context(env, '/api/admin/product-images', 'POST', large))).status, 413);
  assert.equal(images.size, 0);
  const form = new FormData();
  form.set('file', new Blob([readFileSync(new URL('../assets/branch-logo.jpg', import.meta.url))], { type: 'image/jpeg' }), 'logo.jpg');
  const response = await uploadImage(context(env, '/api/admin/product-images', 'POST', form));
  assert.equal(response.status, 201);
  const { url } = await response.json();
  const mediaContext = context(env, url); mediaContext.params = { id: url.split('/').at(-1) };
  const image = await serveImage(mediaContext);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.match(image.headers.get('cache-control'), /immutable/);
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.ok((await image.arrayBuffer()).byteLength > 1000);
  assert.equal((await serveImage({ ...mediaContext, params: { id: '../private' } })).status, 404);
});

test('checkout uses authoritative prices, reserves inventory, and preserves receipt snapshots', async t => {
  const { env, sql } = setup(t);
  const product = await createProduct(env);
  const tampered = cartInput(product, { items: [{ productId: product.id, quantity: 2, priceMinor: 1 }], subtotalMinor: 2 });
  assert.equal((await submit(env, tampered)).status, 409);
  assert.equal(countOrders(sql), 0);
  const input = cartInput(product, { subtotalMinor: 1 });
  const response = await submit(env, input);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.subtotalMinor, 3900);
  assert.equal(stock(sql, product.id), 3);
  const latest = sql.prepare('SELECT version FROM products WHERE id = ?').get(product.id);
  const changed = await adminProducts(context(env, '/api/admin/products', 'PUT', productInput({ id: product.id, version: latest.version, name: 'اسم جديد', priceMinor: 2500, stock: 3 })));
  assert.equal(changed.status, 200);
  const order = (await (await adminOrders(context(env, '/api/admin/orders'))).json()).orders[0];
  assert.equal(order.subtotal_minor, 3900);
  assert.equal(order.items[0].name, product.name);
  assert.equal(order.items[0].unit_price_minor, 1950);
  assert.equal(order.payment_method, 'cash_on_delivery');
  assert.ok(order.details.includes('التوصيل يؤكّد بالتواصل'));
});

test('idempotent retries do not reserve twice or expose a receipt for a changed identity', async t => {
  const { env, sql } = setup(t);
  const product = await createProduct(env, { stock: 2 });
  const input = cartInput(product);
  const first = await (await submit(env, input)).json();
  const retry = await submit(env, input);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).orderId, first.orderId);
  assert.equal(countOrders(sql), 1);
  assert.equal(stock(sql, product.id), 0);
  const conflict = await submit(env, { ...input, phone: '+970598111111' });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'idempotency_conflict' });
});

test('a stock or price race rolls back every order line and reservation', async t => {
  const { env, sql, db } = setup(t);
  const first = await createProduct(env, { name: 'أول' });
  const second = await createProduct(env, { name: 'ثاني' });
  const input = cartInput(first, { items: [first, second].map(p => ({ productId: p.id, quantity: 1, priceMinor: p.price_minor })) });
  db.beforeBatch = () => sql.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(second.id);
  assert.equal((await submit(env, input)).status, 409);
  assert.equal(countOrders(sql), 0);
  assert.equal(stock(sql, first.id), 5);
  assert.equal(stock(sql, second.id), 0);
  sql.prepare('UPDATE products SET stock = 5 WHERE id = ?').run(second.id);
  db.beforeBatch = () => sql.prepare('UPDATE products SET price_minor = price_minor + 1 WHERE id = ?').run(second.id);
  assert.equal((await submit(env, { ...input, requestId: crypto.randomUUID() })).status, 409);
  assert.equal(countOrders(sql), 0);
  assert.equal(stock(sql, first.id), 5);
  assert.equal(stock(sql, second.id), 5);
});

test('cancellation returns stock exactly once and reactivation cannot oversell', async t => {
  const { env, sql } = setup(t);
  const product = await createProduct(env, { stock: 2 });
  const first = await (await submit(env, cartInput(product))).json();
  const update = status => adminOrders(context(env, '/api/admin/orders', 'PATCH', { id: first.orderId, status }));
  assert.equal(stock(sql, product.id), 0);
  assert.equal((await update('cancelled')).status, 200);
  assert.equal(stock(sql, product.id), 2);
  assert.equal((await update('cancelled')).status, 200);
  assert.equal(stock(sql, product.id), 2);
  assert.equal((await update('confirmed')).status, 200);
  assert.equal(stock(sql, product.id), 0);
  assert.equal((await update('cancelled')).status, 200);
  assert.equal(stock(sql, product.id), 2);
  assert.equal((await submit(env, cartInput(product))).status, 201);
  assert.equal((await update('confirmed')).status, 409);
  assert.equal(stock(sql, product.id), 0);
  assert.equal(sql.prepare('SELECT status FROM orders WHERE id = ?').get(first.orderId).status, 'cancelled');
});

test('an admin form opened before a checkout cannot overwrite the newer stock', async t => {
  const { env, sql } = setup(t);
  const product = await createProduct(env);
  assert.equal((await submit(env, cartInput(product))).status, 201);
  const stale = await adminProducts(context(env, '/api/admin/products', 'PUT', productInput({ id: product.id, version: product.version, description: 'تعديل قديم' })));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'product_changed');
  assert.equal(stock(sql, product.id), 3);
});

test('checkout enforces origin, consent, line validation, honeypot, and rate limits', async t => {
  const { env, sql } = setup(t);
  const product = await createProduct(env, { stock: 20 });
  const input = cartInput(product);
  assert.equal((await checkout(context(env, '/api/checkout', 'POST', input, { Origin: 'https://foreign.test' }))).status, 403);
  assert.equal((await submit(env, { ...input, privacyAccepted: false })).status, 400);
  assert.equal((await submit(env, { ...input, items: [...input.items, ...input.items] })).status, 400);
  assert.equal((await submit(env, { ...input, items: [{ ...input.items[0], quantity: 0 }] })).status, 400);
  assert.equal((await submit(env, { ...input, website: 'bot.test' })).status, 201);
  assert.equal(countOrders(sql), 0);
  for (let i = 0; i < 5; i++) assert.equal((await submit(env, cartInput(product))).status, 201);
  assert.equal((await submit(env, cartInput(product))).status, 429);
  assert.equal(countOrders(sql), 5);
});

test('discounts persist, reject invalid prices, support zero, and can be removed', async t => {
  const { env, sql } = setup(t);
  for (const salePriceMinor of [-1, 1950, 2000, 10.5, '1500']) {
    assert.equal((await adminProducts(context(env, '/api/admin/products', 'POST', productInput({ salePriceMinor })))).status, 400);
  }
  const product = await createProduct(env, { salePriceMinor: 1500 });
  assert.equal(product.price_minor, 1950);
  assert.equal(product.sale_price_minor, 1500);
  const publicRows = (await (await catalog(context(env, '/api/products'))).json()).products;
  assert.equal(publicRows[0].sale_price_minor, 1500);
  const freeResponse = await adminProducts(context(env, '/api/admin/products', 'PUT', productInput({ id: product.id, version: product.version, salePriceMinor: 0 })));
  assert.equal(freeResponse.status, 200);
  const free = (await freeResponse.json()).product;
  assert.equal(free.sale_price_minor, 0);
  const removeResponse = await adminProducts(context(env, '/api/admin/products', 'PUT', productInput({ id: free.id, version: free.version, salePriceMinor: null })));
  assert.equal(removeResponse.status, 200);
  assert.equal((await removeResponse.json()).product.sale_price_minor, null);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM product_offers').get().n, 0);
});

test('discounted checkout charges the offer and freezes the charged price for history and retries', async t => {
  const { env, sql } = setup(t);
  const product = await createProduct(env, { salePriceMinor: 1250 });
  const input = cartInput(product);
  const originalPriceAttempt = await submit(env, { ...input, requestId: crypto.randomUUID(), items: [{ productId: product.id, quantity: 2, priceMinor: product.price_minor }] });
  assert.equal(originalPriceAttempt.status, 409);
  const response = await submit(env, input);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.subtotalMinor, 2500);
  assert.equal(sql.prepare('SELECT unit_price_minor FROM order_items WHERE order_id = ?').get(receipt.orderId).unit_price_minor, 1250);
  assert.equal(sql.prepare('SELECT price_minor FROM products WHERE id = ?').get(product.id).price_minor, 1950);
  const version = sql.prepare('SELECT version FROM products WHERE id = ?').get(product.id).version;
  const edit = await adminProducts(context(env, '/api/admin/products', 'PUT', productInput({ id: product.id, version, priceMinor: 2100, salePriceMinor: null, stock: 3 })));
  assert.equal(edit.status, 200);
  const replay = await submit(env, input);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).subtotalMinor, 2500);
  assert.equal(countOrders(sql), 1);
  const historical = (await (await adminOrders(context(env, '/api/admin/orders'))).json()).orders[0];
  assert.equal(historical.subtotal_minor, 2500);
  assert.equal(historical.items[0].unit_price_minor, 1250);
});

test('a zero-priced offer is charged as zero rather than falling back to the original price', async t => {
  const { env, sql } = setup(t);
  const product = await createProduct(env, { salePriceMinor: 0 });
  const response = await submit(env, cartInput(product));
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.subtotalMinor, 0);
  assert.equal(sql.prepare('SELECT unit_price_minor FROM order_items WHERE order_id = ?').get(receipt.orderId).unit_price_minor, 0);
  assert.equal(stock(sql, product.id), 3);
});

test('adding, changing, or removing an offer during checkout rolls back every reservation', async t => {
  const { env, sql, db } = setup(t);
  for (const action of ['add', 'change', 'remove']) {
    const product = await createProduct(env, { salePriceMinor: action === 'add' ? null : 1250 });
    const input = cartInput(product);
    db.beforeBatch = () => {
      if (action === 'add') sql.prepare('INSERT INTO product_offers (product_id, original_price_minor, sale_price_minor) VALUES (?, ?, ?)').run(product.id, product.price_minor, 1250);
      if (action === 'change') sql.prepare('UPDATE product_offers SET sale_price_minor = 1000 WHERE product_id = ?').run(product.id);
      if (action === 'remove') sql.prepare('DELETE FROM product_offers WHERE product_id = ?').run(product.id);
    };
    assert.equal((await submit(env, input)).status, 409, action);
    assert.equal(stock(sql, product.id), 5, action);
    assert.equal(countOrders(sql), 0, action);
  }
});

test('product and discount writes are atomic and a stale editor cannot change the offer', async t => {
  const { env, sql } = setup(t);
  const product = await createProduct(env, { salePriceMinor: 1000 });
  assert.equal((await submit(env, cartInput(product))).status, 201);
  const stale = await adminProducts(context(env, '/api/admin/products', 'PUT', productInput({ id: product.id, version: product.version, salePriceMinor: 500, name: 'stale name' })));
  assert.equal(stale.status, 409);
  assert.equal(sql.prepare('SELECT sale_price_minor FROM product_offers WHERE product_id = ?').get(product.id).sale_price_minor, 1000);
  assert.equal(sql.prepare('SELECT name FROM products WHERE id = ?').get(product.id).name, product.name);
  const plain = await createProduct(env, { name: 'بدون عرض' });
  sql.exec("CREATE TRIGGER fail_offer BEFORE INSERT ON product_offers BEGIN SELECT RAISE(ABORT, 'test offer failure'); END");
  const failed = await adminProducts(context(env, '/api/admin/products', 'PUT', productInput({ id: plain.id, version: plain.version, salePriceMinor: 500, name: 'must roll back' })));
  assert.equal(failed.status, 503);
  assert.deepEqual({ ...sql.prepare('SELECT name, version FROM products WHERE id = ?').get(plain.id) }, { name: plain.name, version: plain.version });
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM product_offers WHERE product_id = ?').get(plain.id).n, 0);
});

test('reapplying schema upgrades pre-discount storage and replaces the old price guard without data loss', async t => {
  const { env, sql } = setup(t);
  const product = await createProduct(env);
  const oldReceipt = await (await submit(env, cartInput(product))).json();
  // Recreate the exact legacy state: existing product table and order history,
  // no offer table, and the stock trigger comparing only the original price.
  sql.exec(`
    DROP TRIGGER reserve_product_stock;
    DROP TABLE product_offers;
    CREATE TRIGGER reserve_product_stock BEFORE INSERT ON order_items BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM products WHERE id = NEW.product_id
        AND published = 1 AND archived = 0 AND stock >= NEW.quantity
        AND price_minor = NEW.unit_price_minor) THEN RAISE(ABORT, 'product_unavailable') END;
      UPDATE products SET stock = stock - NEW.quantity, version = version + 1 WHERE id = NEW.product_id;
    END;
  `);
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  sql.exec(schema);
  sql.exec(schema);
  assert.equal(stock(sql, product.id), 3);
  assert.equal(countOrders(sql), 1);
  assert.equal(sql.prepare('SELECT unit_price_minor FROM order_items WHERE order_id = ?').get(oldReceipt.orderId).unit_price_minor, 1950);
  const version = sql.prepare('SELECT version FROM products WHERE id = ?').get(product.id).version;
  const offer = await adminProducts(context(env, '/api/admin/products', 'PUT', productInput({ id: product.id, version, stock: 3, salePriceMinor: 1000 })));
  assert.equal(offer.status, 200);
  const discounted = (await offer.json()).product;
  assert.equal(discounted.sale_price_minor, 1000);
  const response = await submit(env, cartInput(discounted, { items: [{ productId: product.id, quantity: 1, priceMinor: 1000 }] }));
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await response.json()).subtotalMinor, 1000);
  assert.equal(stock(sql, product.id), 2);
  assert.equal(countOrders(sql), 2);
});
