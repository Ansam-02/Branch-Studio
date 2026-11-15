CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('product', 'custom', 'favor', 'workshop')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT,
  details TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  event_date TEXT,
  payment_method TEXT NOT NULL DEFAULT 'cash_on_delivery',
  privacy_accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'confirmed', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

CREATE TABLE IF NOT EXISTS request_limits (
  ip_hash TEXT NOT NULL,
  minute_bucket INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, minute_bucket)
);

CREATE TABLE IF NOT EXISTS workshops (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  city TEXT NOT NULL,
  venue TEXT,
  price_minor INTEGER CHECK (price_minor IS NULL OR price_minor >= 0),
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS workshops_start_published_idx ON workshops(published, starts_at);

CREATE TABLE IF NOT EXISTS workshop_bookings (
  id TEXT PRIMARY KEY,
  workshop_id TEXT NOT NULL REFERENCES workshops(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  seats INTEGER NOT NULL CHECK (seats > 0),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'cancelled')),
  privacy_accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS workshop_bookings_capacity_idx ON workshop_bookings(workshop_id, status);

CREATE TABLE IF NOT EXISTS workshop_booking_attendees (
  booking_id TEXT NOT NULL REFERENCES workshop_bookings(id) ON DELETE CASCADE,
  seat_number INTEGER NOT NULL CHECK (seat_number BETWEEN 1 AND 8),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  PRIMARY KEY (booking_id, seat_number)
);

CREATE INDEX IF NOT EXISTS workshop_booking_attendees_booking_idx
  ON workshop_booking_attendees(booking_id, seat_number);
-- The catalog is separate from custom-piece inquiries. Archived products remain
-- available to historical order snapshots but disappear from both catalog lists.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  price_minor INTEGER NOT NULL CHECK (price_minor BETWEEN 0 AND 100000000),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  images_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS products_catalog_idx ON products(archived, published, created_at);

-- Discounts are additive so existing product tables need no destructive ALTER.
-- A price edit outside the catalog API cannot accidentally retain an offer for
-- a different original price: only matching original-price snapshots apply.
CREATE TABLE IF NOT EXISTS product_offers (
  product_id TEXT PRIMARY KEY REFERENCES products(id),
  original_price_minor INTEGER NOT NULL CHECK (original_price_minor BETWEEN 0 AND 100000000),
  sale_price_minor INTEGER NOT NULL CHECK (sale_price_minor >= 0 AND sale_price_minor < original_price_minor)
);

CREATE TABLE IF NOT EXISTS product_uploads (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cart_checkouts (
  request_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  payload_hash TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'ILS' CHECK (currency = 'ILS'),
  stock_released INTEGER NOT NULL DEFAULT 0 CHECK (stock_released IN (0, 1))
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  image_url TEXT,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);

-- D1 batches roll back as a unit. Guard and reserve each line in the same
-- transaction, including price/publishing changes racing the initial read.
-- Replacing this guard also upgrades databases created before discounts.
DROP TRIGGER IF EXISTS reserve_product_stock;
CREATE TRIGGER reserve_product_stock
BEFORE INSERT ON order_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM products
    WHERE id = NEW.product_id AND published = 1 AND archived = 0
      AND stock >= NEW.quantity
      AND COALESCE((SELECT sale_price_minor FROM product_offers
        WHERE product_id = products.id AND original_price_minor = products.price_minor), price_minor) = NEW.unit_price_minor
  ) THEN RAISE(ABORT, 'product_unavailable') END;
  UPDATE products SET stock = stock - NEW.quantity, version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.product_id;
END;

CREATE TRIGGER IF NOT EXISTS restore_cancelled_product_stock
AFTER UPDATE OF status ON orders
WHEN OLD.status <> 'cancelled' AND NEW.status = 'cancelled'
  AND EXISTS (SELECT 1 FROM cart_checkouts WHERE order_id = NEW.id AND stock_released = 0)
BEGIN
  UPDATE products SET version = version + 1, stock = stock + (
    SELECT quantity FROM order_items WHERE order_id = NEW.id AND product_id = products.id
  ), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id IN (SELECT product_id FROM order_items WHERE order_id = NEW.id);
  UPDATE cart_checkouts SET stock_released = 1 WHERE order_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS validate_reactivated_product_stock
BEFORE UPDATE OF status ON orders
WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
  AND EXISTS (SELECT 1 FROM cart_checkouts WHERE order_id = NEW.id AND stock_released = 1)
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM order_items i JOIN products p ON p.id = i.product_id
    WHERE i.order_id = NEW.id AND (p.archived = 1 OR p.published = 0 OR p.stock < i.quantity)
  ) THEN RAISE(ABORT, 'product_unavailable') END;
END;

CREATE TRIGGER IF NOT EXISTS reserve_reactivated_product_stock
AFTER UPDATE OF status ON orders
WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled'
  AND EXISTS (SELECT 1 FROM cart_checkouts WHERE order_id = NEW.id AND stock_released = 1)
BEGIN
  UPDATE products SET version = version + 1, stock = stock - (
    SELECT quantity FROM order_items WHERE order_id = NEW.id AND product_id = products.id
  ), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id IN (SELECT product_id FROM order_items WHERE order_id = NEW.id);
  UPDATE cart_checkouts SET stock_released = 0 WHERE order_id = NEW.id;
END;
