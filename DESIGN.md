# Branch Studio design system

The storefront pairs a warm paper surface with oversized editorial type, real studio photography, and rounded, asymmetric layouts. Arabic remains the primary language and reading direction.

## Palette

The public interface uses exactly four base colors, inspired by the original Branch logo:

| Token | Color | Use |
| --- | --- | --- |
| `--green` | `#454F36` | Header logo, small text, buttons, footer, dark cards, and photo overlays |
| `--olive` | `#77783C` | Editorial accents on inner pages; the home page uses the main green instead |
| `--cream` | `#F4F0DF` | Main page surface, fields, and light text on green |
| `--sand` | `#E5DFC3` | Secondary card surfaces, borders, and quiet decoration |

All semantic tokens resolve to these four colors. `--deep-olive`, `--forest`, `--ink`, `--accent`, and `--muted` follow green; `--paper` and `--white` follow cream; `--paper-2`, `--sage`, and `--line` follow sand. Shadows, borders, and photo overlays may use alpha variants of these same colors. Do not add independent pale greens, pure white, or extra neutrals.

Use green for small text on cream or sand, and cream for text on green. Reserve olive for large typography and graphic accents. The organic seal uses green with cream text for readability. Photographs retain their original colors; the four-color limit applies to the designed interface.

## Type and shape

Anton carries English editorial headlines. Inter handles Latin interface text, while IBM Plex Sans Arabic supplies Arabic glyphs and weights. All fonts are hosted under `assets/fonts/`, with their license files.

Display sizes scale with the viewport. Arabic paragraphs retain generous line height. Cards use 2–2.5rem corners, major sections use up to 5rem corners, and pill buttons use a full radius. The hero photo uses an arch to echo the irregular clay pieces.

## Layout and behavior

The source of truth is `storefront.css`: palette and shape tokens live at its beginning. Services use an unequal three-column grid, the gallery uses a large photograph beside two smaller frames, and forms sit in a paper-toned panel. Layouts collapse to one column on small phones without changing reading order.

`visual-motion.js` progressively adds 800ms reveal transitions through `data-reveal`. Only floating hero details use `data-parallax`; movement is bounded to 36px, disabled on narrow screens and coarse pointers, and suspended when the page is hidden. Reduced-motion preferences remove animation. Content stays visible when scripting or observer support is unavailable.

The repeating local `assets/paper-grain.svg` adds texture without intercepting pointer events. Preserve visible focus outlines, semantic headings, native form validation, live status messages, and hidden-state behavior when extending components.

The home page uses a plain cream surface without the green grain overlay. Both
BRANCH and STUDIO use the main logo green; do not restore a lighter green or olive
headline on that page.

Inner-page introductions share a balanced layout in `pages.css`: Arabic titles
and supporting copy sit on the right, with the English display line on the left.
Group Arabic content in `.page-heading-copy`, beside `.section-display` or
`.page-display`. At 700px and below these stack in reading order. Display sizes
use fixed breakpoint values and zero letter spacing. Product and workshop grids
fill their available columns; a lone item pairs its photograph with its details
on desktop and stacks on mobile. Keep empty states truthful rather than adding
placeholder inventory to fill space.

## Pages

The home page is a short introduction with three navigation cards. Detailed content lives on separate pages, all sharing `storefront.css`, `pages.css`, and the same navigation. The mobile menu uses native disclosure controls and works without JavaScript.

| URL | Source | Content |
| --- | --- | --- |
| `/` | `storefront.html` | Landing page |
| `/products/` | `products/index.html` | Published product catalog, detail dialog, and add-to-cart controls |
| `/cart/` | `cart/index.html` | Quantities, delivery details, checkout, and receipt recovery |
| `/workshops/` | `workshops/index.html` | Schedule, calendar, and booking |
| `/services/` | `services/index.html` | Custom pieces, clay boxes, and event favors |
| `/gallery/` | `gallery/index.html` | Workshop photographs |
| `/request/` | `request/index.html` | Request forms |

Request links may use `?type=custom`, `?type=product`, `?type=favor`, or `?type=workshop` to open the appropriate form directly. `storefront.js` loads on the relevant pages and fetches schedules only where the calendar or workshop cards are mounted. The product page has extra styles in `products.css`. Navigation and footer markup are static in each page so they remain usable without scripting; keep the shared links consistent when adding a page.

Shop components share the same four colors through `shop.css`; `shop.js` loads the public catalog and checkout, and `lib/cart.js` manages a persistent cart of product IDs and quantities. All public headers link to the cart with a live quantity badge. The catalog's coming-soon composition appears only when no products are published. Administrator catalog management uses the same brand palette and fonts in `admin/`. Product image colors come from the uploaded photographs.
