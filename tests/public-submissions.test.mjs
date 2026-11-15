import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest as submitOrder } from '../functions/api/orders.js';
import { onRequest as submitBooking } from '../functions/api/workshop-bookings.js';

const origin = 'https://branch-studio.pages.dev';

function fakeDatabase() {
  return {
    touched: false,
    prepare() {
      this.touched = true;
      throw new Error('D1 must not be touched by this request');
    },
  };
}

function postRequest(path, payload, requestOrigin = origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (requestOrigin) headers.Origin = requestOrigin;
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

test('rejects customer submissions when Origin is missing or foreign', async () => {
  const database = fakeDatabase();
  const orderWithoutOrigin = await submitOrder({
    request: postRequest('/api/orders', {}, null), env: { ORDERS: database },
  });
  const bookingFromForeignOrigin = await submitBooking({
    request: postRequest('/api/workshop-bookings', {}, 'https://other.example'),
    env: { ORDERS: database },
  });

  assert.equal(orderWithoutOrigin.status, 403);
  assert.equal(bookingFromForeignOrigin.status, 403);
  assert.equal(database.touched, false);
});

test('does not save PII when a honeypot order is filled', async () => {
  const database = fakeDatabase();
  const response = await submitOrder({
    request: postRequest('/api/orders', { privacyAccepted: true, website: 'bot value' }),
    env: { ORDERS: database },
  });

  assert.equal(response.status, 201);
  assert.equal((await response.json()).ok, true);
  assert.equal(database.touched, false);
});

test('does not save PII when a honeypot booking is filled', async () => {
  const database = fakeDatabase();
  const response = await submitBooking({
    request: postRequest('/api/workshop-bookings', { privacyAccepted: true, website: 'bot value' }),
    env: { ORDERS: database },
  });

  assert.equal(response.status, 201);
  assert.equal((await response.json()).ok, true);
  assert.equal(database.touched, false);
});

test('rejects a booking when attendee names do not match the seat count', async () => {
  const database = fakeDatabase();
  const response = await submitBooking({
    request: postRequest('/api/workshop-bookings', {
      workshopId: 'published-session',
      name: 'Organizer',
      phone: '+970599000000',
      seats: 4,
      attendeeNames: ['One', 'Two', 'Three'],
      privacyAccepted: true,
      website: '',
    }),
    env: { ORDERS: database },
  });

  assert.equal(response.status, 400);
  assert.equal(database.touched, false);
});