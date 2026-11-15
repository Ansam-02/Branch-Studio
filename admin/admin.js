import { palestineLocalFromUtc, palestineLocalToUtc } from '../lib/palestine-time.js';
import { setupProducts } from './products.js';

const notice = document.getElementById('admin-notice');
const orderStatuses = [
  ['new', 'جديد'], ['reviewing', 'قيد المراجعة'], ['confirmed', 'مؤكد'],
  ['completed', 'مكتمل'], ['cancelled', 'ملغي'],
];
const bookingStatuses = [['requested', 'بانتظار الرد'], ['confirmed', 'مؤكد'], ['cancelled', 'ملغي']];
const state = { orders: [], bookings: [], workshops: [] };
const pagination = {
  orders: { page: 1, limit: 50, total: 0, pages: 0 },
  bookings: { page: 1, limit: 50, total: 0, pages: 0 },
};
const requestNumbers = { orders: 0, bookings: 0 };

function reportLoadError(error) {
  setNotice(error.status === 401
    ? 'يلزم تسجيل الدخول عبر Cloudflare Access بالبريد المصرح.'
    : 'تعذّر تحميل البيانات. حدّثي الصفحة أو حاولي مرة ثانية.', true);
}

function addPagination(kind, load) {
  const nav = document.createElement('nav');
  nav.className = 'table-pagination';
  nav.setAttribute('aria-label', kind === 'orders' ? 'صفحات الطلبات' : 'صفحات الحجوزات');
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'button button-outline';
  previous.textContent = '→';
  previous.title = 'الصفحة السابقة';
  previous.setAttribute('aria-label', previous.title);
  const summary = document.createElement('span');
  summary.setAttribute('role', 'status');
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'button button-outline';
  next.textContent = '←';
  next.title = 'الصفحة التالية';
  next.setAttribute('aria-label', next.title);
  for (const [button, direction] of [[previous, -1], [next, 1]]) {
    button.addEventListener('click', async () => {
      previous.disabled = true;
      next.disabled = true;
      pagination[kind].page += direction;
      try {
        await load();
      } catch (error) {
        pagination[kind].page -= direction;
        reportLoadError(error);
        pagination[kind].render();
      }
    });
  }
  nav.append(previous, summary, next);
  document.querySelector(`[data-admin-panel="${kind}"]`).append(nav);
  pagination[kind].render = () => {
    const { page, limit, total, pages } = pagination[kind];
    const first = total ? (page - 1) * limit + 1 : 0;
    const last = Math.min(page * limit, total);
    summary.textContent = `${first}–${last} من ${total}`;
    previous.disabled = page <= 1;
    next.disabled = page >= pages;
    nav.hidden = total <= limit;
  };
  pagination[kind].render();
}

function setNotice(message, isError = false) {
  notice.textContent = message;
  notice.dataset.state = isError ? 'error' : 'ok';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function formatDate(value, options = { dateStyle: 'medium' }) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ar-PS', { timeZone: 'Asia/Hebron', ...options }).format(new Date(value));
}

function createStatusSelect(statuses, selected, onChange) {
  const select = document.createElement('select');
  select.className = 'status-select';
  select.setAttribute('aria-label', 'تغيير الحالة');
  for (const [value, label] of statuses) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === selected;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value, select));
  return select;
}

function createCell(content, detail = '') {
  const cell = document.createElement('td');
  if (content instanceof Node) cell.append(content);
  else {
    const main = document.createElement('strong');
    main.textContent = content || '—';
    cell.append(main);
  }
  if (detail) {
    const small = document.createElement('small');
    small.textContent = detail;
    cell.append(small);
  }
  return cell;
}

function orderDetails(order) {
  if (!Array.isArray(order.items) || !order.items.length) return order.details;
  const details = document.createElement('div');
  const items = document.createElement('ul');
  items.className = 'order-line-items';
  for (const item of order.items) {
    const line = document.createElement('li');
    const price = Number(item.unit_price_minor);
    const total = Number.isSafeInteger(price)
      ? ` · ${new Intl.NumberFormat('ar-PS', { style: 'currency', currency: 'ILS' }).format(price * item.quantity / 100)}`
      : '';
    line.textContent = `${item.name || item.product_name || 'منتج'} × ${item.quantity}${total}`;
    items.append(line);
  }
  details.append(items);
  if (Number.isSafeInteger(order.subtotal_minor)) {
    const total = document.createElement('strong');
    total.className = 'order-total';
    total.textContent = `مجموع القطع: ${new Intl.NumberFormat('ar-PS', { style: 'currency', currency: 'ILS' }).format(order.subtotal_minor / 100)}`;
    details.append(total);
  }
  const payment = document.createElement('small');
  payment.textContent = 'الدفع عند الاستلام · التوصيل والمجموع النهائي يُؤكّدان بالتواصل.';
  details.append(payment);
  return details;
}

function renderOrders() {
  const body = document.getElementById('orders-body');
  const empty = document.getElementById('orders-empty');
  const statusFilter = document.getElementById('order-filter').value;
  const query = document.getElementById('order-search').value.trim().toLocaleLowerCase();
  const rows = state.orders.filter(order => {
    const statusMatch = !statusFilter || order.status === statusFilter;
    const haystack = `${order.name} ${order.phone} ${order.city} ${order.details}`.toLocaleLowerCase();
    return statusMatch && (!query || haystack.includes(query));
  });
  body.replaceChildren();
  empty.hidden = rows.length > 0;

  for (const order of rows) {
    const row = document.createElement('tr');
    row.append(
      createCell(({ product: 'قطعة جاهزة', custom: 'كوب خاص', favor: 'توزيعات', workshop: 'ورشة خاصة' })[order.type] || 'طلب', `#${order.id.slice(0, 8)}`),
      createCell(order.name, `${order.phone} · ${order.city}`),
      createCell(orderDetails(order), order.address || ''),
      createCell(String(order.quantity), order.event_date ? `الموعد: ${formatDate(`${order.event_date}T12:00:00Z`)}` : ''),
      createCell(formatDate(order.created_at, { dateStyle: 'medium', timeStyle: 'short' })),
    );
    const statusCell = document.createElement('td');
    statusCell.append(createStatusSelect(orderStatuses, order.status, async (status, select) => {
      select.disabled = true;
      try {
        await api('/api/admin/orders', {
          method: 'PATCH', body: JSON.stringify({ id: order.id, status }),
        });
        order.status = status;
        setNotice('تم تحديث حالة الطلب.');
        await Promise.all([loadOverview(), loadOrders(), productManager.load()]);
      } catch (error) {
        select.value = order.status;
        setNotice(error.status === 409 ? 'الكمية المتوفرة ما بتكفي لإعادة تفعيل الطلب. راجعي المخزون أولًا.' : 'ما قدرنا نحدّث حالة الطلب.', true);
      } finally {
        select.disabled = false;
      }
    }));
    row.append(statusCell);
    body.append(row);
  }
}

function renderBookings() {
  const body = document.getElementById('bookings-body');
  const empty = document.getElementById('bookings-empty');
  const filter = document.getElementById('booking-filter').value;
  const rows = state.bookings.filter(booking => !filter || booking.status === filter);
  body.replaceChildren();
  empty.hidden = rows.length > 0;

  for (const booking of rows) {
    const row = document.createElement('tr');
    row.append(
      createCell(booking.workshop_title, `${booking.city}${booking.venue ? ` · ${booking.venue}` : ''}`),
      createCell(formatDate(booking.starts_at, { dateStyle: 'medium', timeStyle: 'short' })),
      createCell(booking.name, booking.phone),
      createCell((booking.attendeeNames || []).join('، ') || 'غير مسجلة'),
      createCell(String(booking.seats)),
      createCell(formatDate(booking.created_at, { dateStyle: 'medium', timeStyle: 'short' })),
    );
    const statusCell = document.createElement('td');
    statusCell.append(createStatusSelect(bookingStatuses, booking.status, async (status, select) => {
      select.disabled = true;
      try {
        await api('/api/admin/bookings', {
          method: 'PATCH', body: JSON.stringify({ id: booking.id, status }),
        });
        booking.status = status;
        setNotice('تم تحديث حالة الحجز.');
        await Promise.all([loadOverview(), loadWorkshops(), loadBookings()]);
      } catch (error) {
        select.value = booking.status;
        setNotice(error.status === 409
          ? 'ما في مقاعد كافية لإعادة تفعيل هذا الحجز.'
          : 'ما قدرنا نحدّث حالة الحجز.', true);
      } finally {
        select.disabled = false;
      }
    }));
    row.append(statusCell);
    body.append(row);
  }
}

function renderWorkshops() {
  const body = document.getElementById('workshops-body');
  const empty = document.getElementById('workshops-empty');
  body.replaceChildren();
  empty.hidden = state.workshops.length > 0;

  for (const workshop of state.workshops) {
    const row = document.createElement('tr');
    row.append(
      createCell(workshop.title, `${workshop.city}${workshop.price_minor === null ? '' : ` · ${new Intl.NumberFormat('ar-PS', { style: 'currency', currency: 'ILS' }).format(workshop.price_minor / 100)}`}`),
      createCell(formatDate(workshop.starts_at, { dateStyle: 'medium', timeStyle: 'short' })),
      createCell(workshop.venue || '—'),
      createCell(`${workshop.booked} / ${workshop.capacity}`, `${Math.max(0, workshop.capacity - workshop.booked)} مقعد متاح`),
      createCell(workshop.published ? 'منشورة' : 'مسودة'),
    );
    const actionCell = document.createElement('td');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'button button-outline';
    edit.textContent = 'تعديل';
    edit.addEventListener('click', () => openWorkshopForm(workshop));
    actionCell.append(edit);
    row.append(actionCell);
    body.append(row);
  }
}

async function loadOverview() {
  const data = await api('/api/admin/overview');
  document.getElementById('metric-orders').textContent = String(data.pendingOrders);
  document.getElementById('metric-bookings').textContent = String(data.pendingBookings);
  document.getElementById('metric-workshops').textContent = String(data.upcomingWorkshops);
}

async function loadOrders() {
  const requestNumber = ++requestNumbers.orders;
  const params = new URLSearchParams();
  params.set('page', String(pagination.orders.page));
  params.set('limit', String(pagination.orders.limit));
  const status = document.getElementById('order-filter').value;
  const query = document.getElementById('order-search').value.trim();
  if (status) params.set('status', status);
  if (query) params.set('q', query);
  const data = await api(`/api/admin/orders?${params}`);
  if (requestNumber !== requestNumbers.orders) return;
  if (pagination.orders.page > Math.max(1, data.pagination.pages)) {
    pagination.orders.page = Math.max(1, data.pagination.pages);
    return loadOrders();
  }
  Object.assign(pagination.orders, data.pagination);
  state.orders = data.orders;
  renderOrders();
  pagination.orders.render();
}

async function loadBookings() {
  const requestNumber = ++requestNumbers.bookings;
  const status = document.getElementById('booking-filter').value;
  const params = new URLSearchParams({ page: String(pagination.bookings.page), limit: String(pagination.bookings.limit) });
  if (status) params.set('status', status);
  const data = await api(`/api/admin/bookings?${params}`);
  if (requestNumber !== requestNumbers.bookings) return;
  if (pagination.bookings.page > Math.max(1, data.pagination.pages)) {
    pagination.bookings.page = Math.max(1, data.pagination.pages);
    return loadBookings();
  }
  Object.assign(pagination.bookings, data.pagination);
  state.bookings = data.bookings;
  renderBookings();
  pagination.bookings.render();
}

async function loadWorkshops() {
  const data = await api('/api/admin/workshops');
  state.workshops = data.workshops;
  renderWorkshops();
}

const productManager = setupProducts({
  api,
  setNotice,
  onChange: async () => {
    const results = await Promise.allSettled([loadOverview(), loadOrders()]);
    if (results.some(result => result.status === 'rejected')) {
      setNotice('تم حفظ التغيير، لكن تعذّر تحديث ملخص الطلبات. استخدمي زر تحديث البيانات.', true);
    }
  },
});

async function refreshAll() {
  setNotice('جاري تحديث البيانات…');
  void productManager.load();
  try {
    await Promise.all([loadOverview(), loadOrders(), loadBookings(), loadWorkshops()]);
    setNotice('البيانات محدثة.');
  } catch (error) {
    setNotice(error.status === 401
      ? 'يلزم تسجيل الدخول عبر Cloudflare Access بالبريد المصرح.'
      : 'تعذّر تحميل البيانات. حدّثي الصفحة أو راجعي إعدادات الاتصال.', true);
  }
}

const adminTabs = [...document.querySelectorAll('[data-admin-tab]')];
function selectAdminTab(tab, focus = false) {
  for (const candidate of adminTabs) {
    const active = candidate === tab;
    candidate.setAttribute('aria-selected', String(active));
    candidate.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('[data-admin-panel]')) {
    panel.hidden = panel.dataset.adminPanel !== tab.dataset.adminTab;
  }
  if (focus) tab.focus();
}
for (const [index, tab] of adminTabs.entries()) {
  tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
  tab.addEventListener('click', () => selectAdminTab(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowLeft') next = (index + 1) % adminTabs.length;
    if (event.key === 'ArrowRight') next = (index - 1 + adminTabs.length) % adminTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = adminTabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    adminTabs[next].click();
    adminTabs[next].focus();
  });
}

addPagination('orders', loadOrders);
addPagination('bookings', loadBookings);
document.getElementById('order-filter').addEventListener('change', () => {
  pagination.orders.page = 1;
  loadOrders().catch(reportLoadError);
});
document.getElementById('booking-filter').addEventListener('change', () => {
  pagination.bookings.page = 1;
  loadBookings().catch(reportLoadError);
});
let searchTimer;
document.getElementById('order-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  pagination.orders.page = 1;
  searchTimer = setTimeout(() => loadOrders().catch(reportLoadError), 180);
});
document.getElementById('refresh-button').addEventListener('click', refreshAll);

const workshopForm = document.getElementById('workshop-form');
const workshopStatus = document.getElementById('workshop-status');

function openWorkshopForm(workshop = null) {
  workshopForm.hidden = false;
  workshopForm.reset();
  workshopStatus.textContent = '';
  document.getElementById('workshop-form-title').textContent = workshop ? 'تعديل موعد' : 'إضافة موعد';
  workshopForm.elements.id.value = workshop?.id || '';
  workshopForm.elements.title.value = workshop?.title || '';
  workshopForm.elements.city.value = workshop?.city || '';
  workshopForm.elements.venue.value = workshop?.venue || '';
  workshopForm.elements.capacity.value = workshop?.capacity || 12;
  workshopForm.elements.price.value = workshop?.price_minor === null || workshop?.price_minor === undefined
    ? '' : String(workshop.price_minor / 100);
  workshopForm.elements.published.checked = workshop ? Boolean(workshop.published) : true;
  if (workshop?.starts_at) {
    workshopForm.elements.startsAt.value = palestineLocalFromUtc(workshop.starts_at);
  }
  workshopForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closeWorkshopForm() {
  workshopForm.hidden = true;
  workshopForm.reset();
  workshopStatus.textContent = '';
}

document.getElementById('new-workshop-button').addEventListener('click', () => openWorkshopForm());
document.getElementById('close-workshop-form').addEventListener('click', closeWorkshopForm);
document.getElementById('cancel-workshop-form').addEventListener('click', closeWorkshopForm);
workshopForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!workshopForm.reportValidity()) return;
  const values = new FormData(workshopForm);
  const id = String(values.get('id') || '');
  const price = String(values.get('price') || '').trim();
  let startsAt;
  try {
    startsAt = palestineLocalToUtc(String(values.get('startsAt')));
  } catch {
    workshopStatus.textContent = 'اختاري تاريخ ووقت صالحين بتوقيت فلسطين.';
    return;
  }
  const payload = {
    id,
    title: String(values.get('title') || '').trim(),
    startsAt,
    city: String(values.get('city') || '').trim(),
    venue: String(values.get('venue') || '').trim(),
    capacity: Number(values.get('capacity')),
    priceMinor: price ? Math.round(Number(price) * 100) : null,
    published: values.get('published') === 'on',
  };
  const submit = workshopForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  workshopStatus.textContent = '';
  try {
    await api('/api/admin/workshops', {
      method: id ? 'PUT' : 'POST', body: JSON.stringify(payload),
    });
    closeWorkshopForm();
    await Promise.all([loadWorkshops(), loadOverview()]);
    setNotice(id ? 'تم حفظ تعديلات الورشة.' : 'تمت إضافة الورشة.');
  } catch (error) {
    workshopStatus.textContent = error.status === 409
      ? 'عدد المقاعد لا يمكن أن يقل عن الحجوزات الحالية.'
      : 'ما قدرنا نحفظ الورشة. راجعي البيانات وحاولي مرة ثانية.';
  } finally {
    submit.disabled = false;
  }
});

refreshAll();
