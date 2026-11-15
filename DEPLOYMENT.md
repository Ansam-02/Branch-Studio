# Branch Studio orders

The site uses Cloudflare Pages Functions and D1 for catalog, orders, and bookings, with R2 for administrator-uploaded product photos. Custom inquiries use `/api/orders`; cart orders use `/api/checkout`. The browser never connects directly to D1 or R2. No card details are collected. Payment is cash on delivery; delivery cost and final confirmation are agreed by contact. Cart prices and stock are checked on the server.

## Current Cloudflare setup

- Wrangler is authenticated to the Cloudflare account for `ansamjad02@gmail.com`.
- The production D1 database `branch-studio-orders` is created and bound as `ORDERS` in `wrangler.jsonc`.
- The production schema and the November 14, 2026 Hebron workshop are loaded into D1.
- The Pages project `branch-studio` is deployed to production from `main`. Both `https://branch-studio.pages.dev` and preview deployment URLs are protected by Cloudflare Access.
- The Access policy allows only `ansamjad02@gmail.com`; the login page sends a one-time code by email. No admin password is stored in this repository.
- The private admin console is available at `https://branch-studio.pages.dev/admin/`. The parent Pages middleware at `functions/api/_middleware.js` runs before API dispatch and verifies the signed Cloudflare Access JWT, audience, issuer, expiry, and administrator email for every `/api/admin/*` request.

## Protect the temporary Pages hostname

Current configuration: the Pages preview access policy protects `*.branch-studio.pages.dev`, and the Zero Trust Access application protects `branch-studio.pages.dev` with the same allow-only-email policy. Unauthenticated requests to both hosts were verified to redirect to Cloudflare Access.

If recreating the setup, configure protection before deploying:

1. In Cloudflare, open **Workers & Pages** > **branch-studio** > **Settings** > **General** and enable **Access policy** for preview deployments.
2. Open the Access application created for the Pages project. Configure its public hostname so it protects `branch-studio.pages.dev` instead of only the wildcard preview hostname. Cloudflare may ask you to rename the Access application.
3. Return to the Pages project settings and enable the preview **Access policy** again. Confirm there are separate policies for `branch-studio.pages.dev` and `*.<project>.pages.dev`.
4. In **Zero Trust** > **Access** > **Applications**, open both policies and allow only the email `ansamjad02@gmail.com`. Enable **One-time PIN** as the login method.
5. Test the hostname in a private/incognito browser. It should request an email PIN before showing the site.

Cloudflare documents this as the supported path for protecting a Pages `pages.dev` hostname. Protecting the entire temporary hostname is appropriate for private setup and preview, not for the public storefront. After buying a domain, attach it to Pages, leave the storefront hostname public, and create a separate Access application limited to the admin path on the custom domain.

To redeploy after verifying Access is active, run `npm run deploy`. The current production deployment was made after configuring Access.

## Admin console

Sign in to `/admin/` through Cloudflare Access using the authorized administrator email and one-time code. The console manages products, photos, prices, stock, customer orders, workshop bookings, and workshop publishing. Product photos use R2 and all catalog/order metadata uses D1. Group bookings store one attendee name per seat in `workshop_booking_attendees`; older bookings made before that table have no per-seat names. Order and booking status changes are recorded in place; there is no public read endpoint. Workshop capacity cannot be lowered below active bookings. No separate application password or customer-data export is created.

The Access application audience and issuer used by the admin API are configured as non-secret Wrangler vars in `wrangler.jsonc`. If the Access application or team domain changes, update `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, and `ADMIN_EMAIL` to match the new application and allow policy. The admin API fails closed when these values are missing or an Access token cannot be verified.

After connecting a custom domain and making the storefront public, configure Cloudflare Access for both `/admin*` and `/api/admin/*` on that hostname, allowing only the administrator email. Keep the Pages preview hostname protected. The admin API JWT check remains active even if an Access route is misconfigured.

## Connect Cloudflare D1

The production database and Pages project already exist. These steps are only needed if recreating the setup:

1. Install Node.js and dependencies with `npm install`.
2. Sign in with `npx wrangler login`.
3. Create the database with `npx wrangler d1 create branch-studio-orders`, then place its `database_id` in `wrangler.jsonc` under binding `ORDERS`.
4. Run `npm run db:remote:setup` to create the schema and seed the workshop.
5. Create the Pages project with `npx wrangler pages project create branch-studio --production-branch main`.
6. Enable Access protection before running `npm run deploy`.

For later additive schema updates, run `npm run db:remote:schema` without the seed script. Cloudflare may briefly make D1 unavailable while applying a remote schema change.

Use a private Git repository if connecting a Git provider. Do not commit Cloudflare API tokens, customer exports, or database credentials.

## Local development

Run `npm test` with Node.js 22.13 or newer. Integration tests use isolated in-memory
SQLite databases to check order storage, atomic attendee inserts, capacity limits,
admin pagination, and input validation. They do not write to local or production D1.
Run `npm run check` and `npm run check:pagination` before deployment.

After creating the D1 database and setting its ID in `wrangler.jsonc`, initialize the local D1 database and run Pages locally:

```sh
npm run db:local:setup
npm run dev
```

Open the local URL Wrangler prints. Do not test order submissions from `file://`; the API only exists when served by Pages Functions.

## Customer data and order access

The database stores name, phone, city, delivery address for product orders, order details, quantity, event date when provided, request type, status, and creation time. The schema also stores an accepted-consent timestamp. It does not store raw IP addresses, uploaded images, or card data. A short-lived SHA-256 IP hash is used for rate limiting and old limiter rows are periodically deleted.

The public order-submission API intentionally has no read or update endpoint. Customer writes at `/api/orders` and `/api/workshop-bookings` are intentionally public so visitors can submit requests; they require a matching same-origin `Origin`, privacy consent, input validation, per-IP rate limits, and a honeypot. Honeypot submissions receive generic success without being stored. These checks reduce CSRF and basic bot abuse; they do not make a public write endpoint authenticated. Workshop reads return only published upcoming sessions. Customer records and status updates are available only through the Access-protected admin console. D1 credentials are never sent to the browser. Before opening the storefront publicly on a custom domain, add a retention period to the privacy notice and consider enabling Cloudflare Turnstile for the public forms.

## Important before launch

- Verify the Pages project name and custom domain before launch.
- Confirm delivery areas, fees, product names, prices, and stock before treating product submissions as confirmed orders.
- Custom inquiries record availability requests; cart checkout calculates item totals and reserves stock. Delivery costs and final confirmation remain manual.
- The current request limit is five submissions per IP per minute. Shared networks can reach the limit sooner.
- Configure HTTPS and security headers for the Pages project, including a tested Content-Security-Policy, `Referrer-Policy`, `Permissions-Policy`, and `X-Content-Type-Options`.
- Limit Cloudflare dashboard/D1 access to trusted account members and establish a data-retention process.

## Workshop schedule

The November 14, 2026 session is defined in `seed.sql`: pottery workshop, 10:00 AM Palestine time, Hayat Cafe - Al-Haras, Hebron, 12 seats, price to be confirmed. This workshop already exists in production D1. It stops appearing in the upcoming calendar after its start time. Use the admin console for future workshop changes; ordinary releases do not need the seed script.

To add or edit a workshop, use the protected admin console. Set the title, start time, city, venue, capacity, and optional price; only published upcoming workshops appear in the public calendar. The public website has no workshop write or booking-list endpoint.

Bookings immediately reserve their requested seat count while their status is `requested` or `confirmed`. The public form asks for one attendee name per seat; booking and attendee rows are inserted atomically. Review booking records and attendee names in the Access-protected admin console and contact customers to confirm. Cancelled bookings stop counting toward capacity. The booking endpoint enforces capacity in a single database batch and rejects a request if the workshop is full or no longer upcoming.

Admin order and booking lists use `page` and `limit` query parameters and return
pagination totals. Each page contains at most 100 records; the console defaults to
50 and includes previous/next controls. Filtering and search apply to all records,
not only the currently displayed page. Workshop edits store canonical UTC timestamps;
the admin form converts them from and to Palestine time. Invalid dates are rejected
before a database write.

## Product catalog, photos, and cart

Implemented local features are reviewed in `ADMIN-GUIDE.md`. The catalog starts empty: no placeholder products are published. Products have drafts, publishing, up to five JPG/PNG/WebP images (5 MiB each), exact prices in ILS minor units, inventory, optimistic edit versions, and reversible hiding via archiving. The current catalog/admin list supports up to 200 active products.

`PRODUCT_IMAGES` is an R2 binding to `branch-studio-products` in `wrangler.jsonc`. The bucket need not be public: `/media/<uuid>.<extension>` serves product photos with a fixed image content type. Photo writes are protected by the same administrator JWT check as the rest of `/api/admin/*`. Admin blob previews are allowed by `img-src blob:`; uploaded originals stay on this site's `/media/` URLs.

**Production status on November 15, 2026:** R2 is enabled and the private `branch-studio-products` bucket exists. The additive catalog/checkout schema is applied to production D1. One existing local product, its referenced photo, and its discount were imported without replacing any existing customer records. The uploaded photo was downloaded and its SHA-256 checksum verified against the original. All 33 automated tests and JavaScript syntax checks passed before deployment.

The current production release is `https://12e41ffd.branch-studio.pages.dev`, served by the stable hostname `https://branch-studio.pages.dev`. Existing Cloudflare Access restrictions remain in place. The source snapshot and pre-migration database backups are stored privately outside the site's asset directory in `/private/tmp/branch-release-20261115/`. No test orders were inserted in production. Manage subsequent live products through the production admin console; local preview data is independent.

For future deployments or recreating this setup:

1. In the existing Cloudflare account, enable **R2 Object Storage** in the dashboard.
2. Run `npm run storage:setup` once to create `branch-studio-products` (skip creation if the bucket already exists).
3. Run `npm run db:remote:schema` to apply the additive catalog/checkout tables and inventory triggers. Do not reset or replace existing customer tables.
4. Run `npm run check`, `npm test`, and `npm run deploy` when ready to publish. Keep the existing Access protection during private review.
5. On the target public hostname, leave `/api/products`, `/api/checkout`, and `/media/*` reachable by customers while protecting `/admin*` and `/api/admin/*` with the administrator Access policy.

### Local admin preview

Run `npm run dev:admin`, then open `http://127.0.0.1:8791/admin/` and `http://127.0.0.1:8791/products/`. This standalone development server binds only to loopback, checks Host and same-origin writes, invokes the real application handlers, and persists local data in `.local-preview/`. It uses an SQLite adapter and filesystem image adapter for D1/R2 behavior. Local admin access exists only in this excluded development script; production middleware remains unchanged and fails closed. These local products are not uploaded to production.

`scripts/`, `.local-preview/`, and the server-only commerce helper are excluded from static deployment. The local preview does not serve schema, configuration, private variables, scripts, or data files. The normal Wrangler development command remains available and enforces production-style Access authentication.

### Checkout invariants

The server calculates item totals from saved products, checks publishing and stock, rejects changed prices, and reserves all lines in one D1 batch. A UUID idempotency key and normalized-payload hash make retries return the original receipt. Snapshots of item names/descriptions/prices survive product edits. Cancelling a cart order restores stock once; reactivating it checks and reserves stock again. Stale admin edits cannot overwrite stock changed by a checkout.

The browser stores only IDs and quantities in the long-lived cart. During an unresolved checkout it keeps the exact request in session storage and offers a separate retry action; this action remains usable after price or stock changes and reuses the original key. It clears that temporary payload only after a verified receipt or a definite rejection. Item subtotal excludes delivery, whose price remains subject to confirmation.

### Optional product offers

Products keep their original `price_minor` and expose an optional `sale_price_minor`. Administrator input uses `salePriceMinor` (null when disabled). An offer must be a nonnegative integer amount strictly below the original price. Catalog cards, details, cart totals, server checkout and immutable order snapshots use the effective offer price. No offer dates or expiry are implied.

To upgrade an existing catalog, apply `schema.sql` before deploying the updated handlers. Its additive `product_offers` table avoids resetting or altering existing product rows, and its inventory price guard is refreshed to validate the effective offer price atomically. Restart the standalone local preview after code/schema updates so it reloads handlers and reapplies this idempotent schema.
