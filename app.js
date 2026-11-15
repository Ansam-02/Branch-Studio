function addField(form, id, labelText, type = 'text', options = {}) {
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  const field = type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
  field.id = id;
  field.name = id;
  if (type !== 'textarea') field.type = type;
  field.required = options.required !== false;
  field.maxLength = options.maxLength || 300;
  field.autocomplete = options.autocomplete || 'off';
  if (options.min) field.min = options.min;
  if (options.max) field.max = options.max;
  if (options.placeholder) field.placeholder = options.placeholder;
  form.append(label, field);
  return field;
}

function addPrivacyConsent(form, id) {
  const label = document.createElement('label');
  label.className = 'privacy-consent';
  label.htmlFor = id;
  const checkbox = document.createElement('input');
  checkbox.id = id;
  checkbox.type = 'checkbox';
  checkbox.name = 'privacyAccepted';
  checkbox.required = true;
  label.append(checkbox, document.createTextNode(' أوافق على استخدام بياناتي للتواصل بخصوص هذا الطلب.'));
  form.append(label);
}

function addWorkshopCalendar(container) {
  const oldPrompt = container.querySelector(':scope > .workshop');
  oldPrompt?.remove();

  const calendar = document.createElement('section');
  calendar.className = 'workshop-calendar';
  calendar.id = 'workshop-calendar';

  const toolbar = document.createElement('div');
  toolbar.className = 'calendar-toolbar';
  const title = document.createElement('h3');
  title.className = 'calendar-month';
  const controls = document.createElement('div');
  controls.className = 'calendar-controls';
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'calendar-arrow';
  previous.setAttribute('aria-label', 'الشهر السابق');
  previous.textContent = '←';
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'calendar-arrow';
  next.setAttribute('aria-label', 'الشهر التالي');
  next.textContent = '→';
  controls.append(previous, next);
  toolbar.append(title, controls);

  const content = document.createElement('div');
  content.className = 'calendar-content';
  const grid = document.createElement('div');
  grid.className = 'calendar-grid';
  grid.setAttribute('role', 'grid');
  const events = document.createElement('div');
  events.className = 'calendar-events';
  events.setAttribute('aria-live', 'polite');
  const booking = document.createElement('div');
  booking.className = 'calendar-booking';
  booking.hidden = true;
  content.append(grid, events);
  calendar.append(toolbar, content, booking);
  container.querySelector('.section-head').after(calendar);

  const monthDate = new Date();
  monthDate.setDate(1);
  let sessions = [];
  let selectedDate = null;
  let selectedSession = null;
  let bookingForm;

  const dayFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hebron', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateKey = value => {
    const parts = dayFormatter.formatToParts(new Date(value));
    const get = type => parts.find(part => part.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
  const monthKey = () => `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;

  function showBookingForm(session) {
    selectedSession = session;
    booking.replaceChildren();
    booking.hidden = false;
    const heading = document.createElement('h3');
    heading.textContent = `حجز مقاعد: ${session.title}`;
    const info = document.createElement('p');
    const dateText = new Intl.DateTimeFormat('ar-PS', {
      timeZone: 'Asia/Hebron', dateStyle: 'full', timeStyle: 'short',
    }).format(new Date(session.starts_at));
    info.textContent = `${dateText} · ${session.city}${session.venue ? ` · ${session.venue}` : ''}`;
    const price = document.createElement('p');
    price.className = 'note';
    price.textContent = session.price_minor === null
      ? 'السعر يُؤكّد معك قبل تثبيت الحجز.'
      : `السعر للفرد: ${new Intl.NumberFormat('ar-PS', { style: 'currency', currency: 'ILS' }).format(session.price_minor / 100)}`;

    bookingForm = document.createElement('form');
    bookingForm.className = 'form';
    bookingForm.id = 'workshop-booking-form';
    addField(bookingForm, 'booking-name', 'اسمك', 'text', { maxLength: 80, autocomplete: 'name' }).name = 'name';
    addField(bookingForm, 'booking-phone', 'رقم الهاتف للتواصل', 'tel', { maxLength: 30, autocomplete: 'tel' }).name = 'phone';
    addField(bookingForm, 'booking-seats', 'عدد المقاعد', 'number', { min: 1, max: Math.min(8, session.seats_left), maxLength: 1 }).name = 'seats';
    addPrivacyConsent(bookingForm, 'booking-privacy');
    const button = document.createElement('button');
    button.type = 'submit';
    button.className = 'btn';
    button.textContent = 'إرسال طلب حجز المقاعد';
    const status = document.createElement('p');
    status.id = 'workshop-booking-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    bookingForm.append(button, status);
    bookingForm.addEventListener('submit', async event => {
      event.preventDefault();
      button.disabled = true;
      status.textContent = '';
      const values = new FormData(bookingForm);
      const payload = {
        workshopId: selectedSession.id,
        name: String(values.get('name') || '').trim(),
        phone: String(values.get('phone') || '').trim(),
        seats: Number(values.get('seats')),
        privacyAccepted: values.get('privacyAccepted') === 'on',
      };

      try {
        const response = await fetch('/api/workshop-bookings', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (response.status === 409) {
          status.textContent = 'اكتملت المقاعد أو لم يعد الموعد متاحًا. حدّثي التقويم واختاري موعدًا آخر.';
          await loadMonth();
        } else if (response.status === 429) {
          status.textContent = 'وصلت طلبات كثيرة بسرعة. انتظري دقيقة وجربي مرة ثانية.';
        } else if (!response.ok) {
          status.textContent = 'ما قدرنا إرسال الحجز. راجعي البيانات وجربي مرة ثانية.';
        } else {
          status.textContent = `وصل طلب حجز ${payload.seats} مقعد. رقم الطلب ${result.bookingId}. سنتواصل معك لتأكيد التفاصيل.`;
          bookingForm.reset();
          await loadMonth();
        }
      } catch {
        status.textContent = 'تعذّر الاتصال بخدمة الحجز. تحققي من اتصال الإنترنت وحاولي مجددًا.';
      } finally {
        button.disabled = false;
      }
    });
    booking.append(heading, info, price, bookingForm);
    booking.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderEvents() {
    events.replaceChildren();
    const heading = document.createElement('h3');
    const chosenDate = selectedDate || dateKey(new Date());
    heading.textContent = `ورش ${new Intl.DateTimeFormat('ar-PS', { dateStyle: 'full', timeZone: 'Asia/Hebron' }).format(new Date(`${chosenDate}T12:00:00Z`))}`;
    events.append(heading);
    const matches = sessions.filter(session => dateKey(session.starts_at) === chosenDate);
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'calendar-empty';
      empty.textContent = sessions.length ? 'ما في ورش مجدولة بهذا اليوم.' : 'ما في ورش مجدولة بهذا الشهر حاليًا.';
      events.append(empty);
      booking.hidden = true;
      selectedSession = null;
      return;
    }

    for (const session of matches) {
      const card = document.createElement('article');
      card.className = 'calendar-event';
      const eventTitle = document.createElement('h4');
      eventTitle.textContent = session.title;
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
      action.className = 'btn';
      action.textContent = 'اختاري هذه الورشة';
      action.disabled = session.seats_left < 1 || new Date(session.starts_at) <= new Date();
      action.addEventListener('click', () => showBookingForm(session));
      card.append(eventTitle, meta, seats, action);
      events.append(card);
    }
  }

  function renderCalendar() {
    title.textContent = new Intl.DateTimeFormat('ar-PS', { month: 'long', year: 'numeric' }).format(monthDate);
    grid.replaceChildren();
    const weekdays = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
    for (const weekday of weekdays) {
      const label = document.createElement('span');
      label.className = 'calendar-weekday';
      label.setAttribute('role', 'columnheader');
      label.textContent = weekday;
      grid.append(label);
    }
    const firstWeekday = new Date(Date.UTC(monthDate.getFullYear(), monthDate.getMonth(), 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(monthDate.getFullYear(), monthDate.getMonth() + 1, 0)).getUTCDate();
    const cells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
    const todayKey = dateKey(new Date());
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
      const readableDate = new Intl.DateTimeFormat('ar-PS', {
        dateStyle: 'full', timeZone: 'Asia/Hebron',
      }).format(new Date(`${key}T12:00:00Z`));
      day.setAttribute('aria-label', `${readableDate}${count ? `، ${count} ورش` : ''}`);
      day.setAttribute('aria-pressed', String(selectedDate === key));
      day.textContent = String(dayNumber);
      if (count) {
        day.classList.add('has-workshop');
        const marker = document.createElement('span');
        marker.className = 'calendar-marker';
        marker.setAttribute('aria-hidden', 'true');
        marker.textContent = String(count);
        day.append(marker);
      }
      if (key === todayKey) day.classList.add('is-today');
      day.addEventListener('click', () => {
        selectedDate = key;
        booking.hidden = true;
        renderCalendar();
        renderEvents();
      });
      grid.append(day);
    }
  }

  async function loadMonth() {
    events.textContent = 'جاري تحميل المواعيد…';
    try {
      const response = await fetch(`/api/workshops?month=${encodeURIComponent(monthKey())}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('schedule unavailable');
      const result = await response.json();
      sessions = Array.isArray(result.workshops) ? result.workshops : [];
      if (!selectedDate && sessions.length) {
        selectedDate = dateKey(sessions[0].starts_at);
      }
      renderCalendar();
      renderEvents();
    } catch {
      grid.replaceChildren();
      events.textContent = 'جدول الورش غير متاح حاليًا. حاولي تحديث الصفحة لاحقًا.';
    }
  }

  previous.addEventListener('click', () => {
    monthDate.setMonth(monthDate.getMonth() - 1);
    selectedDate = null;
    booking.hidden = true;
    loadMonth();
  });
  next.addEventListener('click', () => {
    monthDate.setMonth(monthDate.getMonth() + 1);
    selectedDate = null;
    booking.hidden = true;
    loadMonth();
  });
  loadMonth();
}

const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = 'app.css';
document.head.append(stylesheet);
const calendarStylesheet = document.createElement('link');
calendarStylesheet.rel = 'stylesheet';
calendarStylesheet.href = 'calendar.css';
document.head.append(calendarStylesheet);

function createOrderForm(container, id, type, fields, buttonText) {
  const form = document.createElement('form');
  form.id = id;
  form.className = 'form';
  form.noValidate = false;
  for (const field of fields) {
    const control = addField(form, `${id}-${field.id}`, field.label, field.type, field.options);
    control.name = field.id;
  }
  addPrivacyConsent(form, `${id}-privacy`);
  const button = document.createElement('button');
  button.className = 'btn';
  button.type = 'submit';
  button.textContent = buttonText;
  const status = document.createElement('p');
  status.id = `${id}-status`;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  form.append(button, status);
  container.append(form);
  attachOrderForm(form, type, status, button);
  return form;
}

function attachOrderForm(form, type, status, button) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    status.textContent = '';
    button.disabled = true;

    const values = new FormData(form);
    const payload = {
      type,
      name: String(values.get('name') || '').trim(),
      phone: String(values.get('phone') || '').trim(),
      city: String(values.get('city') || '').trim(),
      address: String(values.get('address') || '').trim(),
      details: String(values.get('details') || '').trim(),
      quantity: Number(values.get('quantity') || 1),
      eventDate: String(values.get('eventDate') || ''),
      privacyAccepted: values.get('privacyAccepted') === 'on',
    };

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.error === 'rate_limited') {
          status.textContent = 'وصلت طلبات كثيرة بسرعة. انتظري دقيقة وجربي مرة ثانية.';
        } else if (result.error === 'service_unavailable') {
          status.textContent = 'نموذج الطلبات غير جاهز بعد. جرّبي لاحقًا.';
        } else {
          status.textContent = 'ما قدرنا نحفظ الطلب. راجعي البيانات وجربي مرة ثانية.';
        }
        return;
      }

      status.textContent = type === 'product'
        ? `تم استلام طلب التوفر رقم ${result.orderId}. سنتواصل لتأكيد توفر القطعة والتوصيل والدفع عند الاستلام.`
        : `تم استلام الطلب رقم ${result.orderId}. سنتواصل معك لمراجعة التفاصيل؛ هذا ليس تأكيدًا نهائيًا للحجز أو السعر.`;
      form.reset();
    } catch {
      status.textContent = 'تعذّر الاتصال بخدمة الطلبات. تحققي من اتصال الإنترنت وحاولي مجددًا.';
    } finally {
      button.disabled = false;
    }
  }, true);
}

function addCommonFields(form, prefix, submitText, type, detailsField, quantityField, eventDateField) {
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('[role="status"]');
  const additions = document.createDocumentFragment();
  const fields = [
    ['phone', 'رقم الهاتف للتواصل', 'tel', { autocomplete: 'tel', maxLength: 30 }],
    ['city', 'المدينة', 'text', { autocomplete: 'address-level2', maxLength: 80 }],
  ];
  for (const [fieldId, labelText, inputType, options] of fields) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.id = `${prefix}-${fieldId}`;
    input.name = fieldId;
    input.type = inputType;
    input.autocomplete = options.autocomplete;
    input.maxLength = options.maxLength;
    input.required = true;
    label.htmlFor = input.id;
    label.textContent = labelText;
    additions.append(label, input);
  }
  const details = form.querySelector(detailsField);
  details.name = 'details';
  if (quantityField) quantityField.name = 'quantity';
  if (eventDateField) eventDateField.name = 'eventDate';
  const consent = document.createElement('label');
  consent.className = 'privacy-consent';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.name = 'privacyAccepted';
  checkbox.required = true;
  consent.append(checkbox, document.createTextNode(' أوافق على استخدام بياناتي للتواصل بخصوص هذا الطلب.'));
  additions.append(consent);
  form.insertBefore(additions, button);
  button.textContent = submitText;
  status.setAttribute('aria-live', 'polite');
  attachOrderForm(form, type, status, button);
}

for (const link of document.querySelectorAll('a[href*="wa.me"]')) {
  const label = link.textContent.trim();
  link.href = label.includes('منتجات') || label.includes('المتوفر') || label.includes('البوكس')
    ? '#product-order'
    : '#workshops';
  link.removeAttribute('target');
  link.removeAttribute('rel');
  if (link.closest('header')) link.textContent = 'قدّمي طلبًا';
  if (link.closest('footer')) link.textContent = 'طلبات واستفسارات';
}
for (const imageInput of document.querySelectorAll('#reference, #favors-image, #remove, #favors-remove, #preview, #favors-preview, #file-error, #favors-error')) {
  imageInput.remove();
}
for (const uploadLabel of document.querySelectorAll('label[for="reference"], label[for="favors-image"]')) uploadLabel.remove();
for (const note of document.querySelectorAll('#order .note, #favors-order .note')) {
  note.textContent = 'لا نرفع الصور إلى الموقع. سنطلب أي مرجع بصري عند مراجعة طلبك.';
}
document.querySelector('#custom .design > div > p:nth-of-type(1)').textContent = 'احكيلنا عن الألوان والاسم وأي تفاصيل بتحبيها. بنراجع الفكرة معك ونحدّد السعر ووقت التجهيز.';
document.querySelector('#custom .design > div > p:nth-of-type(2)').textContent = 'مدة استلام الطلبات الخاصة من ١٠ إلى ١٤ يوم. بنؤكد السعر وموعد التجهيز قبل اعتماد الطلب.';
document.querySelector('#favors .design > div > p:nth-of-type(1)').textContent = 'احكيلنا عن القطعة اللي ببالك ومناسبتك والعدد المطلوب. بنراجع معك التفاصيل وإمكانية التنفيذ والسعر. مدة استلام الطلبات الخاصة من ١٠ إلى ١٤ يوم.';
document.querySelector('#favors .design > div > p.note').textContent = 'أي صورة مرجعية لا تُرفع أو تُخزن مع الطلب.';
document.querySelector('#workshops .workshop > div > p').textContent = 'أرسلي طلب الحجز مع المدينة والموعد المناسب، وسنتواصل معك لتأكيد التفاصيل والتوفر.';
document.querySelector('.private > div > p').textContent = 'طلعة صاحبات، مناسبة حلوة، أو نشاط لمجموعتكم؟ أرسلي طلب ورشة مع المدينة وعدد الأشخاص والموعد المقترح.';
document.querySelector('.private').insertAdjacentHTML('beforeend', '<a class="btn outline" href="#workshop-order">قدّمي طلب ورشة خاصة ←</a>');
document.querySelector('#products .workshop > div > p').textContent = 'أرسلي اسم القطعة المطلوبة والكمية والعنوان. سنتواصل لتأكيد توفرها وكلفة التوصيل قبل التجهيز.';
document.querySelector('#products .workshop > a').textContent = 'اطلبي قطعة جاهزة ←';
document.querySelector('.offering:first-child a').href = '#product-order';
document.querySelector('.offering:first-child a').textContent = 'اطلبي بوكس الطين ←';
const requestButtons = [...document.querySelectorAll('[data-request]')];
function selectRequest(type) {
  for (const button of requestButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.request === type));
  }
  document.getElementById('custom').hidden = type !== 'custom';
  document.getElementById('favors').hidden = type !== 'favors';
}
selectRequest(location.hash === '#favors' ? 'favors' : 'custom');
for (const button of requestButtons) {
  button.addEventListener('click', () => {
    const type = button.dataset.request;
    selectRequest(type);
    history.replaceState(null, '', `#${type}`);
  });
}
for (const link of document.querySelectorAll('a[href="#custom"], a[href="#favors"]')) {
  link.addEventListener('click', () => selectRequest(link.hash.slice(1)));
}
window.addEventListener('hashchange', () => {
  if (['#custom', '#favors'].includes(location.hash)) selectRequest(location.hash.slice(1));
});
const imageFaq = [...document.querySelectorAll('.faq-section details')].find(item => item.querySelector('summary')?.textContent.includes('الصورة'));
if (imageFaq) imageFaq.remove();
const customSteps = document.querySelector('.order-steps');
customSteps.replaceChildren(...[
  'اكتبي الاسم وتفاصيل الكوب الذي تتخيّلينه.',
  'نراجع الطلب ونتواصل معك على رقم الهاتف.',
  'نؤكد السعر وموعد التجهيز قبل اعتماد الطلب.',
].map(text => {
  const item = document.createElement('li');
  item.textContent = text;
  return item;
}));

const customForm = document.getElementById('order');
document.querySelector('#custom .order-steps li:first-child').textContent = 'اكتبي الاسم وتفاصيل الكوب الذي تتخيّلينه.';
document.getElementById('name').name = 'name';
customForm.querySelector('textarea').name = 'details';
addCommonFields(customForm, 'custom', 'إرسال طلب الكوب', 'custom', 'textarea', null, null);

const favorsForm = document.getElementById('favors-order');
document.getElementById('favors-name').name = 'name';
document.getElementById('favors-description').name = 'details';
addCommonFields(
  favorsForm,
  'favors',
  'إرسال طلب التوزيعات',
  'favor',
  '#favors-description',
  document.getElementById('favors-quantity'),
  document.getElementById('favors-date'),
);

const productSection = document.getElementById('products');
const productForm = createOrderForm(productSection, 'product-order', 'product', [
  { id: 'name', label: 'اسمك' },
  { id: 'phone', label: 'رقم الهاتف للتواصل', type: 'tel', options: { autocomplete: 'tel', maxLength: 30 } },
  { id: 'city', label: 'المدينة', options: { autocomplete: 'address-level2', maxLength: 80 } },
  { id: 'address', label: 'عنوان التوصيل', options: { maxLength: 300 } },
  { id: 'details', label: 'اسم القطعة أو وصفها', type: 'textarea', options: { maxLength: 500 } },
  { id: 'quantity', label: 'الكمية', type: 'number', options: { min: 1, max: 10000, maxLength: 5 } },
], 'طلب توفر ودفع عند الاستلام');
const productNote = document.createElement('p');
productNote.className = 'note';
productNote.textContent = 'لا يتم تحصيل أي مبلغ إلكتروني. نؤكد توفر القطعة وكلفة التوصيل قبل تجهيز الطلب.';
productForm.prepend(productNote);

const workshopSection = document.getElementById('workshops');
addWorkshopCalendar(workshopSection);
const privateWorkshopHeading = document.createElement('h3');
privateWorkshopHeading.className = 'private-workshop-heading';
privateWorkshopHeading.textContent = 'تنظيم ورشة خاصة لمجموعتك';
const privateWorkshopDescription = document.createElement('p');
privateWorkshopDescription.textContent = 'لطلعة أو مناسبة خاصة، اتركي تفاصيل المجموعة والموعد المقترح وسنتواصل معك.';
workshopSection.append(privateWorkshopHeading, privateWorkshopDescription);
createOrderForm(workshopSection, 'workshop-order', 'workshop', [
  { id: 'name', label: 'اسمك' },
  { id: 'phone', label: 'رقم الهاتف للتواصل', type: 'tel', options: { autocomplete: 'tel', maxLength: 30 } },
  { id: 'city', label: 'المدينة', options: { autocomplete: 'address-level2', maxLength: 80 } },
  { id: 'quantity', label: 'عدد المشاركين', type: 'number', options: { min: 1, max: 10000, maxLength: 5 } },
  { id: 'eventDate', label: 'الموعد المناسب، اختياري', type: 'date', options: { required: false } },
  { id: 'details', label: 'تفاصيل إضافية', type: 'textarea', options: { required: false, maxLength: 500 } },
], 'طلب ورشة خاصة');
const privateWorkshopLink = document.createElement('a');
privateWorkshopLink.className = 'btn outline';
privateWorkshopLink.href = '#workshop-order';
privateWorkshopLink.textContent = 'قدّمي طلب ورشة خاصة ←';
document.querySelector('.private').append(privateWorkshopLink);

