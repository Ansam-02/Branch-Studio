const key = 'branch-studio-cart-v1';
let memory = [];
let storageAvailable = true;

function normalize(value) {
  if (!Array.isArray(value)) return [];
  const items = new Map();
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item.productId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(item.productId) ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1) continue;
    items.set(item.productId, { productId: item.productId, quantity: Math.min(99, item.quantity) });
  }
  return [...items.values()];
}

export function readCart() {
  if (storageAvailable) {
    try { memory = normalize(JSON.parse(localStorage.getItem(key) || '[]')); } catch { storageAvailable = false; }
  }
  return memory.map(item => ({ ...item }));
}

export function writeCart(items) {
  memory = normalize(items);
  if (storageAvailable) {
    try { localStorage.setItem(key, JSON.stringify(memory)); } catch { storageAvailable = false; }
  }
  window.dispatchEvent(new Event('branch-cart-change'));
}

export function cartCount() { return readCart().reduce((sum, item) => sum + item.quantity, 0); }
export const cartStorageKey = key;
