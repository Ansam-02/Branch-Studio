import { readCart, writeCart, cartCount, cartStorageKey } from './lib/cart.js';

const money = value => new Intl.NumberFormat('ar-PS', { style: 'currency', currency: 'ILS' }).format(value / 100);
const hasOffer = product => Number.isSafeInteger(product.sale_price_minor) && product.sale_price_minor >= 0 && product.sale_price_minor < product.price_minor;
const currentPrice = product => hasOffer(product) ? product.sale_price_minor : product.price_minor;

function fillPrice(node, product) {
  node.classList.add('price-display');
  node.replaceChildren();
  if (hasOffer(product)) {
    const original = element('del', 'price-before', money(product.price_minor));
    original.setAttribute('aria-label', `السعر الأصلي: ${money(product.price_minor)}`);
    node.append(original);
  }
  const actual = element(hasOffer(product) ? 'ins' : 'strong', 'price-now', money(currentPrice(product)));
  actual.setAttribute('aria-label', `${hasOffer(product) ? 'سعر العرض' : 'السعر'}: ${money(currentPrice(product))}`);
  node.append(actual);
  return node;
}
function priceBlock(product, className) { return fillPrice(element('div', className), product); }

const catalog = document.getElementById('product-grid');
const cartMount = document.getElementById('cart-items');
const checkout = document.getElementById('checkout-form');
const detail = document.getElementById('product-detail');
const cartNotification = document.getElementById('cart-notification');
let notificationTimer;
let notificationTrigger;
let products = new Map();
let loading = true;
let catalogReady = false;
let submitting = false;
let completed = false;
const pendingStorageKey = 'branch-pending-checkout';
let pendingCheckout = null;
try {
  const saved = JSON.parse(sessionStorage.getItem(pendingStorageKey) || 'null');
  if (saved && typeof saved.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(saved.requestId) && Array.isArray(saved.items) && saved.items.length && ['name', 'phone', 'city', 'address'].every(key => typeof saved[key] === 'string')) pendingCheckout = saved;
} catch { /* Recovery still works in this tab if session storage is unavailable. */ }
function savePending(payload) {
  pendingCheckout = payload;
  try { if (payload) sessionStorage.setItem(pendingStorageKey, JSON.stringify(payload)); else sessionStorage.removeItem(pendingStorageKey); } catch { /* Memory fallback. */ }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function updateCount() {
  const count = cartCount();
  for (const badge of document.querySelectorAll('[data-cart-count]')) badge.textContent = String(count);
  for (const link of document.querySelectorAll('.cart-link')) link.setAttribute('aria-label', `سلة المشتريات، ${count} قطعة`);
}
updateCount();
window.addEventListener('branch-cart-change', () => { updateCount(); if (cartMount) renderCart(); });
window.addEventListener('storage', event => {
  if (event.key === cartStorageKey || event.key === null) { updateCount(); if (cartMount) renderCart(); }
});

function announcement(message) {
  if (cartNotification) {
    clearTimeout(notificationTimer);
    notificationTrigger = document.activeElement;
    const host = detail?.open ? detail : document.body;
    if (cartNotification.parentElement !== host) host.append(cartNotification);
    cartNotification.hidden = false;
    cartNotification.querySelector('[data-cart-notification-message]').textContent = message;
    scheduleNotificationDismissal();
    return;
  }
  for (const target of document.querySelectorAll('[data-shop-message]')) target.textContent = message;
}

function dismissCartNotification() {
  clearTimeout(notificationTimer);
  const restoreFocus = cartNotification.contains(document.activeElement);
  cartNotification.hidden = true;
  if (restoreFocus && notificationTrigger?.isConnected) notificationTrigger.focus({ preventScroll: true });
}

function scheduleNotificationDismissal() {
  clearTimeout(notificationTimer);
  if (cartNotification.matches(':hover') || cartNotification.contains(document.activeElement)) return;
  notificationTimer = setTimeout(dismissCartNotification, 6000);
}

if (cartNotification) {
  cartNotification.querySelector('[data-dismiss-cart-notification]').addEventListener('click', dismissCartNotification);
  cartNotification.addEventListener('pointerenter', () => clearTimeout(notificationTimer));
  cartNotification.addEventListener('pointerleave', scheduleNotificationDismissal);
  cartNotification.addEventListener('focusin', () => clearTimeout(notificationTimer));
  cartNotification.addEventListener('focusout', event => {
    if (!cartNotification.contains(event.relatedTarget)) scheduleNotificationDismissal();
  });
}

function photo(product, index = 0) {
  const image = element('img');
  const src = product.images?.[index];
  if (typeof src === 'string' && /^\/media\/[a-zA-Z0-9.-]+$/.test(src)) image.src = src;
  image.alt = product.name;
  image.loading = 'lazy';
  image.addEventListener('error', () => image.replaceWith(element('span', 'product-image-missing', 'الصورة غير متاحة')));
  return image;
}

function addProduct(product) {
  const items = readCart();
  const current = items.find(item => item.productId === product.id);
  if (!product.stock || (current?.quantity || 0) >= Math.min(product.stock, 99)) {
    announcement('وصلتي للكمية المتاحة من هذه القطعة.');
    return;
  }
  if (!current && items.length >= 20) { announcement('السلة بتستوعب ٢٠ نوع قطعة بالطلب الواحد.'); return; }
  if (current) current.quantity++;
  else items.push({ productId: product.id, quantity: 1 });
  writeCart(items);
  announcement(`انضاف ${product.name} للعربة.`);
}

function addButton(product) {
  const button = element('button', 'button button-dark', product.stock ? 'أضيفي للسلة ＋' : 'نفدت الكمية');
  button.type = 'button';
  button.disabled = !product.stock;
  button.addEventListener('click', () => addProduct(product));
  return button;
}

function showProduct(product) {
  const gallery = detail.querySelector('.product-detail-gallery');
  gallery.replaceChildren(...product.images.map((_, index) => photo(product, index)));
  detail.querySelector('#product-detail-title').textContent = product.name;
  detail.querySelector('.product-detail-description').textContent = product.description;
  fillPrice(detail.querySelector('.product-detail-price'), product);
  detail.querySelector('.product-detail-stock').textContent = product.stock ? `المتوفر: ${product.stock} قطعة` : 'نفدت الكمية حاليًا';
  detail.querySelector('.product-detail-action').replaceChildren(addButton(product));
  detail.showModal();
  if (cartNotification && !cartNotification.hidden) detail.append(cartNotification);
}
if (detail) {
  detail.addEventListener('close', () => {
    if (cartNotification && cartNotification.parentElement === detail) document.body.append(cartNotification);
  });
  detail.querySelector('[data-close-product]').addEventListener('click', () => detail.close());
  detail.addEventListener('click', event => { if (event.target === detail) { const box = detail.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) detail.close(); } });
}

function renderCatalog() {
  if (!catalog) return;
  catalog.replaceChildren();
  document.getElementById('shop-catalog').hidden = products.size === 0;
  document.querySelector('.catalog-coming-soon').hidden = products.size > 0;
  document.getElementById('catalog-load-status').hidden = true;
  for (const product of products.values()) {
    const card = element('article', 'product-card');
    const imageButton = element('button', 'product-image-button');
    imageButton.type = 'button';
    imageButton.setAttribute('aria-label', `تفاصيل ${product.name}`);
    imageButton.append(photo(product));
    imageButton.addEventListener('click', () => showProduct(product));
    const copy = element('div', 'product-card-copy');
    copy.append(element('p', 'product-availability', !product.stock ? 'نفدت الكمية' : hasOffer(product) ? 'عرض على هذه القطعة' : 'مصنوعة بإيدينا'), element('h2', '', product.name), element('p', 'product-card-description', product.description), priceBlock(product, 'product-price'));
    const actions = element('div', 'product-card-actions');
    const more = element('button', 'text-link', 'تفاصيل القطعة');
    more.type = 'button'; more.addEventListener('click', () => showProduct(product));
    actions.append(addButton(product), more);
    copy.append(actions); card.append(imageButton, copy); catalog.append(card);
  }
}

function cartInfo() {
  const items = readCart();
  let subtotal = 0;
  let valid = items.length > 0 && !loading && catalogReady;
  for (const item of items) {
    const product = products.get(item.productId);
    if (!product || item.quantity > product.stock) valid = false;
    if (product) subtotal += currentPrice(product) * item.quantity;
  }
  return { items, subtotal, valid };
}

function renderCart() {
  if (!cartMount) return;
  const { items, subtotal, valid } = cartInfo();
  const empty = document.getElementById('cart-empty');
  empty.hidden = items.length > 0 || loading || completed || Boolean(pendingCheckout);
  document.getElementById('cart-layout').hidden = items.length === 0 || loading || completed;
  document.getElementById('cart-subtotal').textContent = money(subtotal);
  checkout.querySelector('button[type=submit]').disabled = !valid || submitting || Boolean(pendingCheckout);
  checkout.hidden = Boolean(pendingCheckout);
  document.getElementById('checkout-recovery').hidden = !pendingCheckout || completed;
  document.getElementById('retry-checkout').disabled = submitting;
  cartMount.replaceChildren();
  for (const item of items) {
    const product = products.get(item.productId);
    const row = element('article', 'cart-row');
    const image = element('div', 'cart-row-photo');
    if (product) image.append(photo(product));
    else image.append(element('span', 'product-image-missing', 'غير متوفرة'));
    const content = element('div', 'cart-row-content');
    content.append(element('h2', '', product?.name || 'قطعة لم تعد متوفرة'), product ? priceBlock(product, 'cart-unit-price') : element('p', '', 'احذفي القطعة لتكملي الطلب.'));
    if (product && item.quantity > product.stock) content.append(element('p', 'cart-availability-note', product.stock ? `المتاح ${product.stock} فقط؛ عدّلي الكمية.` : 'نفدت الكمية؛ احذفي القطعة لتكملي الطلب.'));
    const controls = element('div', 'cart-row-controls');
    const label = element('label', '', 'الكمية');
    const quantity = element('input');
    quantity.setAttribute('form', 'checkout-form');
    quantity.type = 'number'; quantity.min = '1'; quantity.max = String(Math.max(1, Math.min(99, product?.stock || 1))); quantity.value = String(item.quantity);
    quantity.setAttribute('aria-label', `كمية ${product?.name || 'القطعة'}`);
    quantity.disabled = !product || !product.stock || submitting;
    quantity.addEventListener('change', () => {
      if (!quantity.reportValidity()) return;
      const value = Number(quantity.value);
      const current = readCart(); const target = current.find(candidate => candidate.productId === item.productId);
      if (target) target.quantity = value;
      writeCart(current);
    });
    label.append(quantity);
    const remove = element('button', 'text-link', 'إزالة'); remove.type = 'button'; remove.disabled = submitting;
    remove.setAttribute('aria-label', `إزالة ${product?.name || 'القطعة'}`);
    remove.addEventListener('click', () => writeCart(readCart().filter(candidate => candidate.productId !== item.productId)));
    controls.append(label, remove); content.append(controls);
    row.append(image, content, element('strong', 'cart-line-total', product ? money(currentPrice(product) * item.quantity) : '—'));
    cartMount.append(row);
  }
  document.getElementById('cart-stock-note').hidden = valid || loading || items.length === 0;
}

async function loadProducts() {
  loading = true;
  catalogReady = false;
  try {
    const response = await fetch('/api/products', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('catalog unavailable');
    const data = await response.json();
    if (!Array.isArray(data.products)) throw new Error('invalid catalog');
    products = new Map(data.products.map(product => [product.id, product]));
    loading = false;
    catalogReady = true;
    renderCatalog(); renderCart();
    const loadStatus = document.getElementById('cart-load-status'); if (loadStatus) loadStatus.hidden = true;
    return true;
  } catch {
    loading = false;
    const status = document.getElementById(catalog ? 'catalog-load-status' : 'cart-load-status');
    status.hidden = false;
    status.replaceChildren(document.createTextNode('تعذّر تحميل المنتجات. '));
    const retry = element('button', 'text-link', 'حاولي مرة ثانية'); retry.type = 'button'; retry.addEventListener('click', loadProducts); status.append(retry);
    if (checkout) checkout.querySelector('button[type=submit]').disabled = true;
    return false;
  }
}

function validReceipt(result) {
  return typeof result.orderId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.orderId) &&
    Number.isSafeInteger(result.subtotalMinor) && result.subtotalMinor >= 0 && result.currency === 'ILS';
}

function completeOrder(result, orderedItems) {
  completed = true;
  savePending(null);
  const current = readCart();
  for (const ordered of orderedItems) { const remaining = current.find(item => item.productId === ordered.productId); if (remaining) remaining.quantity -= ordered.quantity; }
  writeCart(current.filter(item => item.quantity > 0));
  const confirmation = document.getElementById('checkout-confirmation');
  confirmation.hidden = false;
  confirmation.querySelector('[data-order-number]').textContent = result.orderId;
  confirmation.querySelector('[data-order-subtotal]').textContent = money(result.subtotalMinor);
  confirmation.focus(); checkout.reset();
  document.getElementById('checkout-status').textContent = '';
}

async function sendCheckout(payload) {
  if (submitting) return;
  submitting = true;
  savePending(payload);
  renderCart();
  const status = document.getElementById('checkout-status');
  const recovery = document.getElementById('checkout-recovery-status');
  recovery.textContent = 'عم نتأكد من إرسال طلبك…';
  try {
    const response = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json().catch(() => null);
    if (response.ok) {
      if (!result || !validReceipt(result)) throw new Error('incomplete_receipt');
      completeOrder(result, payload.items);
      return;
    }
    // A network/server failure may have followed a committed order. Keep the
    // exact payload and key; recovery must not depend on newer stock or prices.
    if (response.status >= 500 || !result) throw new Error('uncertain_response');
    if (result.error === 'idempotency_conflict') {
      recovery.textContent = 'رقم المحاولة مرتبط بطلب سابق بتفاصيل مختلفة. تواصلي معنا للتأكد قبل إرسال طلب جديد.';
      return;
    }
    savePending(null);
    if (response.status === 409) {
      await loadProducts();
      status.textContent = 'تغيّر سعر أو توفر إحدى القطع. راجعي السلة وحدّثي الكميات قبل إعادة الإرسال.';
    } else status.textContent = response.status === 429 ? 'وصلتنا طلبات كثيرة بسرعة. جربي بعد دقيقة.' : 'ما قدرنا نحفظ الطلب. راجعي البيانات وحاولي مرة ثانية.';
  } catch {
    recovery.textContent = 'الاتصال انقطع قبل ما نتأكد. اضغطي «تحققي من الطلب»؛ بنعيد نفس المحاولة بدون تكرار الطلب أو خصم الكمية مرتين.';
  } finally { submitting = false; renderCart(); }
}

if (checkout) {
  if (pendingCheckout) {
    for (const key of ['name', 'phone', 'city', 'address']) checkout.elements[key].value = pendingCheckout[key];
    renderCart();
  }
  document.getElementById('retry-checkout').addEventListener('click', () => { if (pendingCheckout) sendCheckout(pendingCheckout); });
  checkout.addEventListener('submit', async event => {
    event.preventDefault();
    const { items, valid } = cartInfo();
    if (submitting || pendingCheckout || !valid || !checkout.reportValidity()) return;
    const values = new FormData(checkout);
    const payload = {
      requestId: crypto.randomUUID(),
      name: String(values.get('name') || '').trim(), phone: String(values.get('phone') || '').trim(),
      city: String(values.get('city') || '').trim(), address: String(values.get('address') || '').trim(),
      privacyAccepted: values.get('privacyAccepted') === 'on', website: String(values.get('website') || ''),
      items: items.map(item => ({ ...item, priceMinor: currentPrice(products.get(item.productId)) })),
    };
    await sendCheckout(payload);
  });
}

if (catalog || cartMount) loadProducts();
