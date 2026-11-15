function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return jsonResponse({ error: 'method_not_allowed' }, 405);
  if (!env.ORDERS) return jsonResponse({ error: 'service_unavailable' }, 503);

  try {
    const [orders, bookings, workshops] = await Promise.all([
      env.ORDERS.prepare("SELECT COUNT(*) AS count FROM orders WHERE status IN ('new', 'reviewing')").first(),
      env.ORDERS.prepare("SELECT COUNT(*) AS count FROM workshop_bookings WHERE status = 'requested'").first(),
      env.ORDERS.prepare("SELECT COUNT(*) AS count FROM workshops WHERE published = 1 AND datetime(starts_at) > datetime('now')").first(),
    ]);
    return jsonResponse({
      pendingOrders: Number(orders?.count || 0),
      pendingBookings: Number(bookings?.count || 0),
      upcomingWorkshops: Number(workshops?.count || 0),
    });
  } catch {
    return jsonResponse({ error: 'service_unavailable' }, 503);
  }
}