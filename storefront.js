import { palestineMonthKey } from './lib/palestine-time.js';

const requestTabs = [...document.querySelectorAll('[data-request-tab]')];
const requestForms = [...document.querySelectorAll('[data-order-form]')];

function selectRequest(type, updateUrl = false) {
  if (!requestForms.some(form => form.dataset.orderType === type)) return;
  for (const tab of requestTabs) {
    tab.setAttribute('aria-pressed', String(tab.dataset.requestTab === type));
  }
  for (const form of requestForms) {
    form.hidden = form.dataset.orderType !== type;
  }
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('type', type);
    window.history.replaceState(null, '', url);
  }
}

selectRequest(new URLSearchParams(window.location.search).get('type'));

// Keep links to sections of the former one-page storefront useful.
const legacySections = {
  '#studio': '/services/', '#workshops': '/workshops/',
  '#gallery': '/gallery/', '#story': '/about/', '#request': '/request/',
};
if (document.body.classList.contains('landing-page') && legacySections[window.location.hash]) {
  window.location.replace(legacySections[window.location.hash]);
}

for (const tab of requestTabs) {
  tab.addEventListener('click', () => selectRequest(tab.dataset.requestTab, true));
}

document.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('[data-select-request]') : null;
  if (link) selectRequest(link.dataset.selectRequest);
});

for (const form of requestForms) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('[role="status"]');
    const values = new FormData(form);
    const payload = {
      type: form.dataset.orderType,
      name: String(values.get('name') || '').trim(),
      phone: String(values.get('phone') || '').trim(),
      city: String(values.get('city') || '').trim(),
      address: String(values.get('address') || '').trim(),
      details: String(values.get('details') || '').trim(),
      quantity: Number(values.get('quantity') || 1),
      eventDate: String(values.get('eventDate') || ''),
      privacyAccepted: values.get('privacyAccepted') === 'on',
      website: String(values.get('website') || ''),
    };

    button.disabled = true;
    status.textContent = '';
    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        status.textContent = response.status === 429
          ? 'وصلتنا طلبات كثيرة بسرعة. جربي مرة ثانية بعد دقيقة.'
          : 'ما قدرنا نحفظ الطلب. تأكدي من البيانات وجربي مرة ثانية.';
        return;
      }
      status.textContent = `وصل طلبك برقم ${result.orderId}. بنتواصل معك للتأكيد، وهذا مش تأكيد نهائي للسعر أو الموعد.`;
      form.reset();
    } catch {
      status.textContent = 'تعذّر الاتصال بخدمة الطلبات. تحققي من الإنترنت وحاولي مرة ثانية.';
    } finally {
      button.disabled = false;
    }
  });
}

function addField(form, name, labelText, type = 'text', options = {}) {
  const label = document.createElement('label');
  label.append(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.name = name;
  input.type = type;
  input.required = options.required !== false;
  if (options.autocomplete) input.autocomplete = options.autocomplete;
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  if (options.maxLength) input.maxLength = options.maxLength;
  label.append(input);
  form.append(label);
  return input;
}

function addPrivacyConsent(form) {
  const label = document.createElement('label');
  label.className = 'consent field-wide';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.name = 'privacyAccepted';
  checkbox.required = true;
  label.append(checkbox, document.createTextNode(' أوافق على استخدام بياناتي وأسماء المشاركين لإدارة هذا الحجز والتواصل بشأنه.'));
  form.append(label);
}

function addHoneypot(form) {
  const label = document.createElement('label');
  label.className = 'trap-field';
  label.setAttribute('aria-hidden', 'true');
  label.append(document.createTextNode('اتركي هذا الحقل فارغًا'));
  const input = document.createElement('input');
  input.name = 'website';
  input.type = 'text';
  input.tabIndex = -1;
  input.autocomplete = 'off';
  label.append(input);
  form.append(label);
}

for (const form of requestForms) addHoneypot(form);

function addWorkshopCalendar(container) {
  const toolbar = document.createElement('div');
  toolbar.className = 'calendar-toolbar';
  const monthTitle = document.createElement('h3');
  monthTitle.className = 'calendar-month';
  const controls = document.createElement('div');
  controls.className = 'calendar-controls';
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'calendar-arrow';
  previous.setAttribute('aria-label', 'الشهر السابق');
  previous.textContent = '→';
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'calendar-arrow';
  next.setAttribute('aria-label', 'الشهر التالي');
  next.textContent = '←';
  controls.append(previous, next);
  toolbar.append(monthTitle, controls);

  const layout = document.createElement('div');
  layout.className = 'calendar-layout';
  const grid = document.createElement('div');
  grid.className = 'calendar-grid';
  grid.setAttribute('role', 'grid');
  const events = document.createElement('div');
  events.className = 'calendar-events';
  events.setAttribute('aria-live', 'polite');
  const booking = document.createElement('div');
  booking.className = 'calendar-booking';
  booking.hidden = true;
  layout.append(grid, events);
  container.replaceChildren(toolbar, layout, booking);

  const [currentYear, currentMonth] = palestineMonthKey().split('-').map(Number);
  let monthDate = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
  let sessions = [];
  let selectedDate = dateKey(new Date());
  let monthRequest = 0;

  function dateKey(value) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(value));
    const get = name => parts.find(part => part.type === name).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function monthKey() {
    return `${monthDate.getUTCFullYear()}-${String(monthDate.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function renderEvents() {
    events.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = `ورش ${new Intl.DateTimeFormat('ar-PS', {
      timeZone: 'Asia/Hebron', dateStyle: 'full',
    }).format(new Date(`${selectedDate}T12:00:00Z`))}`;
    events.append(heading);
    const matches = sessions.filter(session => dateKey(session.starts_at) === selectedDate);
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'calendar-empty';
      empty.textContent = sessions.length ? 'ما في ورش بهذا اليوم.' : 'ما في ورش معلنة بهذا الشهر حاليًا.';
      events.append(empty);
      return;
    }

    for (const session of matches) {
      const item = document.createElement('article');
      item.className = 'calendar-event';
      const title = document.createElement('h4');
      title.textContent = session.title;
      const time = new Intl.DateTimeFormat('ar-PS', {
        timeZone: 'Asia/Hebron', hour: 'numeric', minute: '2-digit',
      }).format(new Date(session.starts_at));
      const meta = document.createElement('p');
      meta.textContent = `${time} · ${session.city}${session.venue ? ` · ${session.venue}` : ''}`;
      const seats = document.createElement('p');
      seats.className = 'calendar-seats';
      seats.textContent = session.seats_left > 0 ? `متبقي ${session.seats_left} مقاعد` : 'اكتملت المقاعد';
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'button button-dark';
      action.textContent = 'اطلبي حجز مقعد';
      action.disabled = session.seats_left < 1 || new Date(session.starts_at) <= new Date();
      action.addEventListener('click', () => showBookingForm(session));
      item.append(title, meta, seats, action);
      events.append(item);
    }
  }

  function renderCalendar() {
    monthTitle.textContent = new Intl.DateTimeFormat('ar-PS', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(monthDate);
    grid.replaceChildren();
    const weekdays = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
    for (const weekday of weekdays) {
      const label = document.createElement('span');
      label.className = 'calendar-weekday';
      label.setAttribute('role', 'columnheader');
      label.textContent = weekday;
      grid.append(label);
    }
    const firstWeekday = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0)).getUTCDate();
    const cells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
    const today = dateKey(new Date());
    for (let index = 0; index < cells; index += 1) {
      const dayNumber = index - firstWeekday + 1;
      if (dayNumber < 1 || dayNumber > daysInMonth) {
        const blank = document.createElement('span');
        blank.className = 'calendar-day calendar-day-empty';
        blank.setAttribute('aria-hidden', 'true');
        grid.append(blank);
        continue;
      }
      const key = `${monthKey()}-${String(dayNumber).padStart(2, '0')}`;
      const count = sessions.filter(session => dateKey(session.starts_at) === key).length;
      const day = document.createElement('button');
      day.type = 'button';
      day.className = 'calendar-day';
      day.textContent = String(dayNumber);
      day.setAttribute('aria-label', `${key}${count ? `، ${count} ورش` : ''}`);
      day.setAttribute('aria-pressed', String(selectedDate === key));
      if (count) day.classList.add('has-workshop');
      if (key === today) day.classList.add('is-today');
      day.addEventListener('click', () => {
        selectedDate = key;
        booking.hidden = true;
        renderCalendar();
        renderEvents();
      });
      grid.append(day);
    }
    renderEvents();
  }

  function showBookingForm(session) {
    booking.replaceChildren();
    booking.hidden = false;
    const heading = document.createElement('h3');
    heading.textContent = `طلب حجز: ${session.title}`;
    const info = document.createElement('p');
    info.textContent = `${new Intl.DateTimeFormat('ar-PS', {
      timeZone: 'Asia/Hebron', dateStyle: 'full', timeStyle: 'short',
    }).format(new Date(session.starts_at))} · ${session.city}${session.venue ? ` · ${session.venue}` : ''}`;
    const price = document.createElement('p');
    price.className = 'calendar-price';
    price.textContent = session.price_minor === null
      ? 'السعر يُؤكّد معك قبل تثبيت الحجز.'
      : `السعر للفرد: ${new Intl.NumberFormat('ar-PS', {
        style: 'currency', currency: 'ILS',
      }).format(session.price_minor / 100)}`;

    const form = document.createElement('form');
    form.className = 'booking-form';
    const seatsInput = addField(form, 'seats', 'عدد المقاعد', 'number', {
      min: 1, max: Math.min(8, session.seats_left),
    });
    seatsInput.value = '1';
    const attendeeFieldset = document.createElement('fieldset');
    attendeeFieldset.className = 'attendee-fields';
    const attendeeLegend = document.createElement('legend');
    attendeeLegend.textContent = 'اسم لكل مقعد';
    const attendeeGrid = document.createElement('div');
    attendeeGrid.className = 'attendee-name-grid';
    attendeeFieldset.append(attendeeLegend, attendeeGrid);
    form.append(attendeeFieldset);

    function renderAttendeeFields() {
      const names = [...attendeeGrid.querySelectorAll('input')].map(input => input.value);
      attendeeGrid.replaceChildren();
      const count = Number(seatsInput.value);
      if (!Number.isSafeInteger(count) || count < 1 || count > Number(seatsInput.max)) return;
      for (let index = 0; index < count; index += 1) {
        const label = document.createElement('label');
        label.append(document.createTextNode(`اسم الشخص ${index + 1}`));
        const input = document.createElement('input');
        input.name = 'attendeeNames';
        input.type = 'text';
        input.maxLength = 80;
        input.autocomplete = 'off';
        input.required = true;
        input.value = names[index] || '';
        label.append(input);
        attendeeGrid.append(label);
      }
    }

    seatsInput.addEventListener('input', renderAttendeeFields);
    seatsInput.addEventListener('change', renderAttendeeFields);
    renderAttendeeFields();
    addField(form, 'name', 'اسم الشخص المسؤول عن الحجز', 'text', { autocomplete: 'name', maxLength: 80 });
    addField(form, 'phone', 'رقم الهاتف للتواصل', 'tel', { autocomplete: 'tel', maxLength: 30 });
    addPrivacyConsent(form);
    addHoneypot(form);
    const button = document.createElement('button');
    button.type = 'submit';
    button.className = 'button button-dark';
    button.textContent = 'إرسال طلب الحجز';
    const status = document.createElement('p');
    status.className = 'form-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    form.append(button, status);
    let submitted = false;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submitted || button.disabled || !form.reportValidity()) return;
      const values = new FormData(form);
      button.disabled = true;
      try {
        const response = await fetch('/api/workshop-bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workshopId: session.id,
            name: String(values.get('name') || '').trim(),
            phone: String(values.get('phone') || '').trim(),
            seats: Number(values.get('seats')),
            attendeeNames: values.getAll('attendeeNames').map(value => String(value).trim()),
            privacyAccepted: values.get('privacyAccepted') === 'on',
            website: String(values.get('website') || ''),
          }),
        });
        const result = await response.json();
        if (response.status === 409) {
          status.textContent = 'اكتملت المقاعد أو لم يعد الموعد متاحًا. حدّثي التقويم واختاري موعدًا آخر.';
          await loadMonth();
        } else if (!response.ok) {
          status.textContent = response.status === 429
            ? 'وصلتنا طلبات كثيرة بسرعة. جربي مرة ثانية بعد دقيقة.'
            : 'ما قدرنا نرسل طلب الحجز. راجعي البيانات وحاولي مرة ثانية.';
        } else {
          submitted = true;
          status.textContent = `وصل طلبك برقم ${result.bookingId}. بنتواصل معك لتأكيد التفاصيل.`;
          button.textContent = 'تم إرسال طلب الحجز';
          for (const field of form.elements) field.disabled = true;
          await loadMonth();
          await loadWorkshopCards();
        }
      } catch {
        status.textContent = 'تعذّر الاتصال بخدمة الحجز. تحققي من الإنترنت وحاولي مرة ثانية.';
      } finally {
        button.disabled = submitted;
      }
    });
    booking.append(heading, info, price, form);
    booking.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function loadMonth() {
    const requestNumber = ++monthRequest;
    const requestedMonth = monthKey();
    grid.inert = true;
    grid.setAttribute('aria-busy', 'true');
    events.textContent = 'لحظة، بنحمّل المواعيد…';
    try {
      const response = await fetch(`/api/workshops?month=${encodeURIComponent(requestedMonth)}`, {
        cache: 'no-store', headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('schedule unavailable');
      const result = await response.json();
      if (requestNumber !== monthRequest) return false;
      sessions = Array.isArray(result.workshops) ? result.workshops : [];
      if (selectedDate.slice(0, 7) !== monthKey()) selectedDate = `${monthKey()}-01`;
      if (!sessions.some(session => dateKey(session.starts_at) === selectedDate) && sessions.length) {
        selectedDate = dateKey(sessions[0].starts_at);
      }
      renderCalendar();
      return true;
    } catch {
      if (requestNumber !== monthRequest) return false;
      grid.replaceChildren();
      events.textContent = 'جدول الورش غير متاح حاليًا. حاولي تحديث الصفحة لاحقًا.';
      return false;
    } finally {
      if (requestNumber === monthRequest) {
        grid.inert = false;
        grid.setAttribute('aria-busy', 'false');
      }
    }
  }

  previous.addEventListener('click', () => {
    monthDate.setUTCMonth(monthDate.getUTCMonth() - 1);
    booking.hidden = true;
    loadMonth();
  });
  next.addEventListener('click', () => {
    monthDate.setUTCMonth(monthDate.getUTCMonth() + 1);
    booking.hidden = true;
    loadMonth();
  });
  loadMonth();

  return async session => {
    selectedDate = dateKey(session.starts_at);
    const [year, month] = selectedDate.split('-').map(Number);
    monthDate = new Date(Date.UTC(year, month - 1, 1));
    booking.hidden = true;
    if (!await loadMonth()) return;
    const currentSession = sessions.find(candidate => candidate.id === session.id);
    if (currentSession) showBookingForm(currentSession);
  };
}

const calendarMount = document.getElementById('calendar-mount');
const openCalendarBooking = calendarMount ? addWorkshopCalendar(calendarMount) : null;

function monthAtOffset(offset) {
  const [year, month] = palestineMonthKey().split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function renderWorkshopCards(container, sessions) {
  container.replaceChildren();
  const privateWorkshop = document.querySelector('.private-workshop');
  if (!sessions.length) {
    if (privateWorkshop) privateWorkshop.hidden = true;
    const empty = document.createElement('div');
    empty.className = 'workshop-empty';
    const message = document.createElement('p');
    message.textContent = 'ما في مواعيد معلنة حاليًا. اتركي رقمك ونخبرك أول ما نحدد الورشة الجاية.';
    const actions = document.createElement('div');
    actions.className = 'workshop-empty-actions';
    const interest = document.createElement('a');
    interest.className = 'button button-dark';
    interest.href = '/request/?type=workshop';
    interest.dataset.selectRequest = 'workshop';
    interest.textContent = 'خبروني عن الورشة الجاية';
    const privateWorkshopLink = document.createElement('a');
    privateWorkshopLink.className = 'text-link';
    privateWorkshopLink.href = '/request/?type=workshop';
    privateWorkshopLink.dataset.selectRequest = 'workshop';
    privateWorkshopLink.textContent = 'رتّبي ورشة خاصة';
    actions.append(interest, privateWorkshopLink);
    empty.append(message, actions);
    container.append(empty);
    return;
  }
  if (privateWorkshop) privateWorkshop.hidden = false;

  const images = ['/assets/workshop-group.jpg', '/assets/workshop-table.jpg', '/assets/cup-painting.jpg'];
  for (const [index, session] of sessions.entries()) {
    const card = document.createElement('article');
    card.className = 'workshop-card';
    const image = document.createElement('img');
    image.src = images[index % images.length];
    image.alt = 'لقطة حقيقية من ورش برانش';
    image.loading = 'lazy';
    const content = document.createElement('div');
    content.className = 'workshop-card-copy';
    const date = document.createElement('p');
    date.className = 'workshop-card-date';
    date.textContent = new Intl.DateTimeFormat('ar-PS', {
      timeZone: 'Asia/Hebron', dateStyle: 'full', timeStyle: 'short',
    }).format(new Date(session.starts_at));
    const title = document.createElement('h2');
    title.textContent = session.title;
    const location = document.createElement('p');
    location.textContent = `${session.city}${session.venue ? ` · ${session.venue}` : ''}`;
    const price = document.createElement('p');
    price.textContent = session.price_minor === null
      ? 'السعر يُؤكّد قبل الحجز'
      : `السعر للفرد: ${new Intl.NumberFormat('ar-PS', {
        style: 'currency', currency: 'ILS',
      }).format(session.price_minor / 100)}`;
    const seats = document.createElement('p');
    seats.className = 'calendar-seats';
    seats.textContent = session.seats_left > 0 ? `متبقي ${session.seats_left} مقاعد` : 'اكتملت المقاعد';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-dark';
    button.textContent = session.seats_left > 0 ? 'احجزي مقعدك' : 'اكتملت المقاعد';
    button.disabled = session.seats_left < 1 || new Date(session.starts_at) <= new Date();
    button.addEventListener('click', () => {
      document.getElementById('calendar-details').open = true;
      openCalendarBooking?.(session);
    });
    content.append(date, title, location, price, seats, button);
    card.append(image, content);
    container.append(card);
  }
}

async function loadWorkshopCards() {
  const container = document.getElementById('workshop-cards');
  if (!container) return;
  try {
    const months = Array.from({ length: 6 }, (_, index) => monthAtOffset(index));
    const responses = await Promise.all(months.map(month => fetch(
      `/api/workshops?month=${encodeURIComponent(month)}`,
      { cache: 'no-store', headers: { Accept: 'application/json' } },
    )));
    if (responses.some(response => !response.ok)) throw new Error('schedule unavailable');
    const monthlyResults = await Promise.all(responses.map(response => response.json()));
    const uniqueSessions = new Map();
    for (const result of monthlyResults) {
      for (const session of Array.isArray(result.workshops) ? result.workshops : []) {
        uniqueSessions.set(session.id, session);
      }
    }
    const sessions = [...uniqueSessions.values()]
      .sort((left, right) => new Date(left.starts_at) - new Date(right.starts_at))
      .slice(0, 6);
    renderWorkshopCards(container, sessions);
  } catch {
    container.replaceChildren();
    const error = document.createElement('p');
    error.className = 'calendar-empty';
    error.textContent = 'المواعيد غير متاحة حاليًا. حاولي تحديث الصفحة لاحقًا.';
    container.append(error);
  }
}

loadWorkshopCards();
