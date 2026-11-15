import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { onRequest as submitOrder } from '../functions/api/orders.js';
import { onRequest as submitBooking } from '../functions/api/workshop-bookings.js';
import { onRequest as workshops } from '../functions/api/workshops.js';
import { onRequest as adminOrders } from '../functions/api/admin/orders.js';
import { onRequest as adminBookings } from '../functions/api/admin/bookings.js';
import { onRequest as adminWorkshops } from '../functions/api/admin/workshops.js';

const origin = 'https://branch-studio.pages.dev';
const future = new Date(Date.now() + 86_400_000).toISOString();

function database(t, capacity = 3) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.prepare('INSERT INTO workshops (id, title, starts_at, city, capacity, published) VALUES (?, ?, ?, ?, ?, 1)')
    .run('workshop', 'Pottery', future, 'Hebron', capacity);
  t.after(() => sql.close());
  return {
    sql,
    prepare(query) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return sql.prepare(query).get(...values) ?? null; },
        async all() { return { success: true, results: sql.prepare(query).all(...values) }; },
        async run() {
          const result = sql.prepare(query).run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
        execute() {
          const results = sql.prepare(query).all(...values);
          return { success: true, results, meta: { changes: Number(sql.prepare('SELECT changes() AS n').get().n) } };
        },
      };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function context(db, path, method = 'GET', payload) {
  return {
    env: { ORDERS: db },
    request: new Request(`${origin}${path}`, {
      method,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }),
  };
}

const order = {
  type: 'custom', name: 'Test customer', phone: '+970599000000', city: 'Hebron',
  details: 'A painted cup', quantity: 1, privacyAccepted: true,
};
const booking = {
  workshopId: 'workshop', name: 'Organizer', phone: '+970599000000',
  seats: 2, attendeeNames: ['First participant', 'Second participant'], privacyAccepted: true,
};

test('stores a valid order and makes it visible in the admin list', async t => {
  const db = database(t);
  const response = await submitOrder(context(db, '/api/orders', 'POST', order));
  assert.equal(response.status, 201);
  const { orderId } = await response.json();
  const list = await adminOrders(context(db, '/api/admin/orders'));
  const data = await list.json();
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].id, orderId);
  assert.equal(data.orders[0].status, 'new');
  assert.equal(data.pagination.total, 1);
});

test('books seats and attendee names together and rejects overbooking', async t => {
  const db = database(t);
  const accepted = await submitBooking(context(db, '/api/workshop-bookings', 'POST', booking));
  assert.equal(accepted.status, 201);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM workshop_booking_attendees').get().n, 2);
  const rejected = await submitBooking(context(db, '/api/workshop-bookings', 'POST', booking));
  assert.equal(rejected.status, 409);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM workshop_bookings').get().n, 1);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM workshop_booking_attendees').get().n, 2);
  const list = await adminBookings(context(db, '/api/admin/bookings?status=requested'));
  const data = await list.json();
  assert.deepEqual(data.bookings[0].attendeeNames, booking.attendeeNames);
});

test('rolls back the reservation when an attendee insert fails', async t => {
  const db = database(t);
  db.sql.exec("CREATE TRIGGER reject_attendee BEFORE INSERT ON workshop_booking_attendees BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const response = await submitBooking(context(db, '/api/workshop-bookings', 'POST', booking));
  assert.equal(response.status, 503);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM workshop_bookings').get().n, 0);
});

test('blocks capacity reductions and reactivation beyond remaining seats', async t => {
  const db = database(t);
  const accepted = await submitBooking(context(db, '/api/workshop-bookings', 'POST', booking));
  const { bookingId } = await accepted.json();
  const update = await adminWorkshops(context(db, '/api/admin/workshops', 'PUT', {
    id: 'workshop', title: 'Pottery', startsAt: future, city: 'Hebron', capacity: 1,
    published: true, priceMinor: null,
  }));
  assert.equal(update.status, 409);
  const cancelled = await adminBookings(context(db, '/api/admin/bookings', 'PATCH', { id: bookingId, status: 'cancelled' }));
  assert.equal(cancelled.status, 200);
  const replacement = await submitBooking(context(db, '/api/workshop-bookings', 'POST', {
    ...booking, seats: 3, attendeeNames: ['One', 'Two', 'Three'],
  }));
  assert.equal(replacement.status, 201);
  const restored = await adminBookings(context(db, '/api/admin/bookings', 'PATCH', { id: bookingId, status: 'confirmed' }));
  assert.equal(restored.status, 409);
});

test('reaches orders and bookings beyond the first 100 records without losing attendees', async t => {
  const db = database(t, 500);
  const insertOrder = db.sql.prepare('INSERT INTO orders (id, type, name, phone, city, details, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertBooking = db.sql.prepare('INSERT INTO workshop_bookings (id, workshop_id, name, phone, seats) VALUES (?, ?, ?, ?, ?)');
  const insertAttendee = db.sql.prepare('INSERT INTO workshop_booking_attendees (booking_id, seat_number, name) VALUES (?, ?, ?)');
  for (let index = 0; index < 105; index += 1) {
    const id = String(index).padStart(3, '0');
    insertOrder.run(id, 'custom', 'Customer', '+970599000000', 'Hebron', 'Cup', 1);
    insertBooking.run(id, 'workshop', 'Organizer', '+970599000000', 2);
    insertAttendee.run(id, 1, 'One');
    insertAttendee.run(id, 2, 'Two');
  }
  for (const [handler, path, field] of [
    [adminOrders, '/api/admin/orders', 'orders'],
    [adminBookings, '/api/admin/bookings', 'bookings'],
  ]) {
    const first = await (await handler(context(db, `${path}?page=1&limit=100`))).json();
    const second = await (await handler(context(db, `${path}?page=2&limit=100`))).json();
    assert.equal(first[field].length, 100);
    assert.equal(second[field].length, 5);
    assert.equal(second.pagination.total, 105);
    assert.equal(new Set([...first[field], ...second[field]].map(row => row.id)).size, 105);
    if (field === 'bookings') assert.deepEqual(second[field][0].attendeeNames, ['One', 'Two']);
  }
});

test('rejects invalid calendar input and noncanonical workshop dates', async t => {
  const db = database(t);
  for (const month of ['0000-01', '0099-03', '9999-12', '2026-13']) {
    const response = await workshops(context(db, `/api/workshops?month=${month}`));
    assert.equal(response.status, 400, month);
  }
  const response = await adminWorkshops(context(db, '/api/admin/workshops', 'POST', {
    title: 'Pottery', city: 'Hebron', startsAt: '2026-02-31T10:00:00.000Z',
    capacity: 12, priceMinor: null, published: true,
  }));
  assert.equal(response.status, 400);
  const invalidEvent = await submitOrder(context(db, '/api/orders', 'POST', { ...order, eventDate: '2026-02-31' }));
  assert.equal(invalidEvent.status, 400);
});

test('validates pagination and enforces the customer submission limit', async t => {
  const db = database(t);
  for (const params of ['page=0', 'page=-1', 'page=NaN', 'limit=101', 'page=1.5']) {
    assert.equal((await adminOrders(context(db, `/api/admin/orders?${params}`))).status, 400);
  }
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await submitOrder(context(db, '/api/orders', 'POST', order))).status, 201);
  }
  assert.equal((await submitOrder(context(db, '/api/orders', 'POST', order))).status, 429);
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 5);
});
