const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const mediaPath = /^\/media\/[a-zA-Z0-9._-]+\.(?:jpg|jpeg|png|webp)$/;
const discountPrice = product => Number.isSafeInteger(product?.sale_price_minor) && product.sale_price_minor >= 0 && product.sale_price_minor < product.price_minor ? product.sale_price_minor : null;
const money = value => new Intl.NumberFormat('ar-PS', { style: 'currency', currency: 'ILS' }).format(value / 100);

function priceToMinor(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= 100000000 ? amount : null;
}

function messageFor(error, fallback) {
  if (error.status === 401) return 'يلزم تسجيل الدخول بحساب الإدارة المصرّح له، ثم المحاولة مرة ثانية.';
  if (error.message === 'product_changed') return 'تغيّر المنتج أو المخزون خلال التعديل. حدّثي البيانات وافتحي المنتج من جديد حتى ما تنحفظ كمية قديمة.';
  if (error.status === 413) return 'حجم الصورة أكبر من المسموح. اختاري صورة أقل من ٥ ميغابايت.';
  if (error.message === 'storage_not_configured' || error.message === 'image_storage_unavailable') return 'خدمة حفظ الصور غير متاحة حاليًا. حاولي مرة ثانية بعد التحقق من الاتصال.';
  return fallback;
}

export function setupProducts({ api, setNotice, onChange }) {
  const form = document.getElementById('product-form');
  const status = document.getElementById('product-status');
  const uploadStatus = document.getElementById('product-upload-status');
  const notice = document.getElementById('products-notice');
  const fileInput = document.getElementById('product-images-input');
  const previews = document.getElementById('product-image-previews');
  const list = document.getElementById('admin-products-list');
  const empty = document.getElementById('products-empty');
  const search = document.getElementById('product-search');
  const filter = document.getElementById('product-filter');
  const newButton = document.getElementById('new-product-button');
  const saleFields = document.getElementById('product-sale-fields');
  let products = [];
  let images = [];
  let busy = false;
  let requestNumber = 0;

  function releaseImages() {
    for (const image of images) if (image.preview) URL.revokeObjectURL(image.preview);
    images = [];
  }

  function syncDiscount() {
    const enabled = form.elements.discountEnabled.checked;
    saleFields.hidden = !enabled;
    form.elements.salePrice.disabled = busy || !enabled;
    form.elements.salePrice.required = enabled;
  }

  function setBusy(value) {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    for (const control of form.querySelectorAll('input, textarea, button')) control.disabled = value;
    newButton.disabled = value;
    syncDiscount();
    renderImages();
  }

  function renderImages() {
    previews.replaceChildren();
    images.forEach((image, index) => {
      const card = document.createElement('div');
      card.className = 'product-image-preview';
      const picture = document.createElement('img');
      picture.src = image.url || image.preview;
      picture.alt = `صورة المنتج ${index + 1}${index === 0 ? '، صورة الغلاف' : ''}`;
      const label = document.createElement('p');
      label.textContent = image.error ? 'تعذّر رفع الصورة' : image.url ? (index === 0 ? 'صورة الغلاف' : `الصورة ${index + 1}`) : 'جاري رفع الصورة…';
      const actions = document.createElement('div');
      actions.className = 'image-preview-actions';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'حذف';
      remove.setAttribute('aria-label', `حذف صورة المنتج ${index + 1}`);
      remove.disabled = busy;
      remove.addEventListener('click', () => {
        if (image.preview) URL.revokeObjectURL(image.preview);
        images.splice(index, 1);
        uploadStatus.textContent = '';
        renderImages();
      });
      actions.append(remove);
      if (index > 0 && image.url) {
        const cover = document.createElement('button');
        cover.type = 'button';
        cover.textContent = 'اجعليها الغلاف';
        cover.disabled = busy;
        cover.addEventListener('click', () => {
          images.splice(index, 1);
          images.unshift(image);
          renderImages();
        });
        actions.append(cover);
      }
      if (image.error) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'إعادة الرفع';
        retry.disabled = busy;
        retry.addEventListener('click', async () => {
          setBusy(true);
          image.error = false;
          try {
            await uploadImage(image);
            uploadStatus.textContent = 'تم رفع الصورة.';
          } catch (error) {
            image.error = true;
            uploadStatus.textContent = messageFor(error, 'ما قدرنا نرفع الصورة. أعيدي المحاولة أو احذفيها واختاري صورة ثانية.');
          } finally {
            setBusy(false);
          }
        });
        actions.append(retry);
      }
      card.append(picture, label, actions);
      previews.append(card);
    });
    fileInput.disabled = busy || images.length >= MAX_IMAGES;
  }

  function open(product = null) {
    if (busy) return;
    releaseImages();
    form.reset();
    form.hidden = false;
    status.textContent = '';
    uploadStatus.textContent = '';
    document.getElementById('product-form-title').textContent = product ? 'تعديل المنتج' : 'إضافة منتج';
    form.elements.id.value = product?.id || '';
    form.elements.version.value = product?.version ?? '';
    form.elements.name.value = product?.name || '';
    form.elements.description.value = product?.description || '';
    form.elements.price.value = product ? (product.price_minor / 100).toFixed(2) : '';
    const sale = discountPrice(product);
    form.elements.discountEnabled.checked = sale !== null;
    form.elements.salePrice.value = sale !== null ? (sale / 100).toFixed(2) : '';
    syncDiscount();
    form.elements.stock.value = product?.stock ?? 1;
    form.elements.published.checked = Boolean(product?.published);
    images = (product?.images || []).filter(url => mediaPath.test(url)).map(url => ({ url }));
    renderImages();
    form.scrollIntoView({ block: 'start', behavior: 'smooth' });
    form.elements.name.focus({ preventScroll: true });
  }

  function close() {
    if (busy) return;
    releaseImages();
    form.hidden = true;
    form.reset();
    syncDiscount();
    status.textContent = '';
    uploadStatus.textContent = '';
    renderImages();
    newButton.focus({ preventScroll: true });
  }

  async function uploadImage(image) {
    const payload = new FormData();
    payload.append('file', image.file);
    const response = await fetch('/api/admin/product-images', {
      method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: payload,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !mediaPath.test(data.url || '')) {
      const error = new Error(data.error || 'invalid_upload_response');
      error.status = response.status;
      throw error;
    }
    image.url = data.url;
    if (image.preview) URL.revokeObjectURL(image.preview);
    delete image.preview;
    delete image.file;
    image.error = false;
  }

  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length || busy) return;
    if (images.length + files.length > MAX_IMAGES) {
      uploadStatus.textContent = 'مسموح لحد ٥ صور للمنتج. احذفي صورة قبل إضافة صور ثانية.';
      return;
    }
    if (files.some(file => !allowedTypes.has(file.type) || file.size > MAX_IMAGE_BYTES || file.size === 0)) {
      uploadStatus.textContent = 'اختاري صور JPG أو PNG أو WebP، وكل صورة أقل من ٥ ميغابايت.';
      return;
    }
    const additions = files.map(file => ({ file, preview: URL.createObjectURL(file), error: false }));
    images.push(...additions);
    status.textContent = '';
    uploadStatus.textContent = 'جاري رفع الصور…';
    setBusy(true);
    let failed = false;
    for (const image of additions) {
      try {
        await uploadImage(image);
      } catch (error) {
        failed = true;
        image.error = true;
        uploadStatus.textContent = messageFor(error, 'تعذّر رفع بعض الصور. أعيدي رفعها من الزر تحت الصورة، أو احذفيها.');
      }
      renderImages();
    }
    if (!failed) uploadStatus.textContent = 'تم رفع الصور. احفظي المنتج لتثبيت التعديلات.';
    setBusy(false);
  });

  function renderProducts() {
    const query = search.value.trim().toLocaleLowerCase();
    const mode = filter.value;
    const visible = products.filter(product => {
      const matchesQuery = `${product.name} ${product.description}`.toLocaleLowerCase().includes(query);
      const matchesMode = !mode || mode === 'published' && Boolean(product.published) || mode === 'draft' && !product.published || mode === 'sold-out' && product.stock === 0;
      return matchesQuery && matchesMode;
    });
    list.replaceChildren();
    empty.hidden = visible.length > 0;
    empty.textContent = products.length ? 'ما في منتجات مطابقة للبحث.' : 'ما في منتجات بعد. أضيفي أول قطعة، وارفعي صورها وحدّدي سعرها.';
    document.getElementById('metric-products').textContent = String(products.filter(product => product.published).length);
    for (const product of visible) {
      const card = document.createElement('article');
      card.className = 'admin-product-card';
      const cover = document.createElement('div');
      cover.className = 'admin-product-cover';
      const url = product.images?.find(image => mediaPath.test(image));
      if (url) {
        const image = document.createElement('img');
        image.src = url;
        image.alt = product.name;
        image.loading = 'lazy';
        cover.append(image);
      } else {
        const placeholder = document.createElement('span');
        placeholder.textContent = 'صورة المنتج';
        cover.append(placeholder);
      }
      const copy = document.createElement('div');
      copy.className = 'admin-product-info';
      const meta = document.createElement('div');
      meta.className = 'admin-product-meta';
      const badge = document.createElement('span');
      badge.className = `product-pill${product.published ? ' is-published' : ''}`;
      badge.textContent = product.published ? (product.stock ? 'منشور' : 'منشور · غير متوفر') : 'مسودة';
      const stock = document.createElement('small');
      stock.textContent = `المتوفر: ${product.stock}`;
      meta.append(badge);
      const sale = discountPrice(product);
      if (sale !== null) {
        const offer = document.createElement('span');
        offer.className = 'product-pill product-offer-pill';
        offer.textContent = 'عرض';
        meta.append(offer);
      }
      meta.append(stock);
      const title = document.createElement('h3');
      title.textContent = product.name;
      const price = document.createElement('div');
      price.className = 'admin-product-price';
      if (sale !== null) {
        const original = document.createElement('del');
        original.textContent = money(product.price_minor);
        original.setAttribute('aria-label', `السعر الأصلي: ${money(product.price_minor)}`);
        const offerPrice = document.createElement('strong');
        offerPrice.textContent = money(sale);
        offerPrice.setAttribute('aria-label', `سعر العرض: ${money(sale)}`);
        price.append(original, offerPrice);
      } else price.textContent = money(product.price_minor);
      const description = document.createElement('p');
      description.textContent = product.description.length > 180 ? `${product.description.slice(0, 180)}…` : product.description;
      const actions = document.createElement('div');
      actions.className = 'admin-product-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'button button-dark';
      edit.textContent = 'تعديل المنتج';
      edit.addEventListener('click', () => open(product));
      const archive = document.createElement('button');
      archive.type = 'button';
      archive.className = 'button button-outline';
      archive.textContent = 'أرشفة';
      archive.setAttribute('aria-label', `أرشفة ${product.name}`);
      archive.addEventListener('click', async () => {
        if (busy || !window.confirm(`أرشفة «${product.name}» وإخفاؤه من المتجر؟ الطلبات السابقة بتبقى محفوظة.`)) return;
        archive.disabled = true;
        edit.disabled = true;
        try {
          await api('/api/admin/products', { method: 'DELETE', body: JSON.stringify({ id: product.id, version: product.version }) });
          if (form.elements.id.value === product.id) close();
          await load();
          setNotice('تمت أرشفة المنتج وإخفاؤه من المتجر.');
          await onChange?.();
        } catch (error) {
          notice.textContent = messageFor(error, 'ما قدرنا نأرشف المنتج. حاولي مرة ثانية.');
          notice.dataset.state = 'error';
        } finally {
          archive.disabled = false;
          edit.disabled = false;
        }
      });
      actions.append(edit, archive);
      copy.append(meta, title, price, description, actions);
      card.append(cover, copy);
      list.append(card);
    }
  }

  async function load() {
    const currentRequest = ++requestNumber;
    notice.textContent = 'جاري تحميل المنتجات…';
    notice.dataset.state = 'ok';
    try {
      const data = await api('/api/admin/products');
      if (currentRequest !== requestNumber) return true;
      products = Array.isArray(data.products) ? data.products : [];
      renderProducts();
      notice.textContent = products.length ? `${products.length} منتج · حدّدي المنتج لتعديل صوره وتفاصيله.` : '';
      return true;
    } catch (error) {
      if (currentRequest !== requestNumber) return false;
      notice.textContent = messageFor(error, 'تعذّر تحميل المنتجات. حدّثي البيانات وحاولي مرة ثانية.');
      notice.dataset.state = 'error';
      if (!products.length) empty.hidden = true;
      return false;
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const priceMinor = priceToMinor(form.elements.price.value);
    const stock = Number(form.elements.stock.value);
    if (priceMinor === null || !Number.isSafeInteger(stock) || stock < 0 || stock > 100000) {
      status.textContent = 'راجعي السعر والكمية. السعر لحد منزلتين عشريتين والكمية عدد صحيح.';
      return;
    }
    const salePriceMinor = form.elements.discountEnabled.checked ? priceToMinor(form.elements.salePrice.value) : null;
    if (form.elements.discountEnabled.checked && (salePriceMinor === null || salePriceMinor >= priceMinor)) {
      status.textContent = 'سعر العرض لازم يكون أقل من السعر الأصلي. راجعي السعرين أو شيلي علامة الخصم.';
      form.elements.salePrice.focus();
      return;
    }
    if (images.some(image => !image.url)) {
      status.textContent = 'أكملي رفع الصور أو احذفي الصور اللي تعذّر رفعها قبل الحفظ.';
      return;
    }
    if (form.elements.published.checked && !images.length) {
      status.textContent = 'أضيفي صورة واحدة على الأقل قبل نشر المنتج.';
      return;
    }
    const id = form.elements.id.value;
    const payload = {
      ...(id ? { id, version: Number(form.elements.version.value) } : {}),
      name: form.elements.name.value.trim(), description: form.elements.description.value.trim(),
      priceMinor, salePriceMinor, stock, published: form.elements.published.checked, images: images.map(image => image.url),
    };
    setBusy(true);
    status.textContent = 'جاري حفظ المنتج…';
    try {
      await api('/api/admin/products', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      setBusy(false);
      close();
      await load();
      setNotice(id ? 'تم حفظ تعديلات المنتج.' : 'تمت إضافة المنتج.');
      await onChange?.();
    } catch (error) {
      status.textContent = messageFor(error, 'ما قدرنا نحفظ المنتج. راجعي البيانات وحاولي مرة ثانية.');
      if (error.message === 'product_changed') await load();
    } finally {
      setBusy(false);
    }
  });

  form.elements.discountEnabled.addEventListener('change', syncDiscount);
  syncDiscount();
  newButton.addEventListener('click', () => open());
  document.getElementById('close-product-form').addEventListener('click', close);
  document.getElementById('cancel-product-form').addEventListener('click', close);
  search.addEventListener('input', renderProducts);
  filter.addEventListener('change', renderProducts);
  document.getElementById('tab-products').addEventListener('click', load);
  return { load };
}
