// Motion is optional: the page remains visible until observers are ready.
const root = document.documentElement;
const revealElements = [...document.querySelectorAll('[data-reveal]')];
const parallaxElements = [...document.querySelectorAll('[data-parallax]')];

if ('IntersectionObserver' in window && 'matchMedia' in window) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const narrowScreen = window.matchMedia('(max-width: 850px)');
  const coarsePointer = window.matchMedia('(pointer: coarse)');
  const nearby = new Set();
  const parallaxState = new Map(parallaxElements.map(element => {
    const suppliedSpeed = Number(element.dataset.parallax);
    const speed = element.dataset.parallax && Number.isFinite(suppliedSpeed)
      ? Math.max(-0.25, Math.min(0.25, suppliedSpeed))
      : 0.08;
    return [element, { speed, offset: 0 }];
  }));
  let revealObserver;
  let parallaxObserver;
  let frame = 0;
  let parallaxEnabled = false;

  function reveal(element) {
    element.classList.add('is-revealed');
    revealObserver?.unobserve(element);
  }

  function revealAll() {
    revealElements.forEach(reveal);
    root.classList.remove('reveal-ready');
  }

  function revealAround(target) {
    if (!(target instanceof Element) || target === document.body || target === root) return;
    for (const element of revealElements) {
      if (element.contains(target) || target.contains(element)) reveal(element);
    }
  }

  function revealHashTarget() {
    try {
      revealAround(document.getElementById(decodeURIComponent(location.hash.slice(1))));
    } catch {
      // A malformed hash should not affect page content or navigation.
    }
  }

  function updateParallax() {
    frame = 0;
    if (!parallaxEnabled || document.hidden) return;
    // Read every position before writing styles, avoiding repeated layout work.
    const positions = [...nearby].map(element => {
      const state = parallaxState.get(element);
      const rect = element.getBoundingClientRect();
      const center = rect.top + rect.height / 2 - state.offset;
      const offset = Math.max(-36, Math.min(36, (innerHeight / 2 - center) * state.speed));
      return { element, state, offset };
    });
    for (const { element, state, offset } of positions) {
      state.offset = offset;
      element.style.setProperty('--parallax-y', `${offset.toFixed(2)}px`);
    }
  }

  function scheduleParallax() {
    if (!frame && parallaxEnabled && !document.hidden && nearby.size) {
      frame = requestAnimationFrame(updateParallax);
    }
  }

  function resetParallax() {
    cancelAnimationFrame(frame);
    frame = 0;
    nearby.clear();
    for (const [element, state] of parallaxState) {
      state.offset = 0;
      element.style.removeProperty('--parallax-y');
    }
  }

  function updatePreferences() {
    if (reducedMotion.matches) {
      revealAll();
      revealObserver.disconnect();
    }
    const enabled = !reducedMotion.matches && !narrowScreen.matches && !coarsePointer.matches;
    if (enabled !== parallaxEnabled) {
      parallaxEnabled = enabled;
      parallaxObserver.disconnect();
      resetParallax();
      if (enabled) parallaxElements.forEach(element => parallaxObserver.observe(element));
    }
    scheduleParallax();
  }

  try {
    revealObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) reveal(entry.target);
      }
    }, { threshold: 0.08 });
    parallaxObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) nearby.add(entry.target);
        else nearby.delete(entry.target);
      }
      scheduleParallax();
    }, { rootMargin: '160px' });

    if (!reducedMotion.matches && revealElements.length) {
      revealElements.forEach(element => revealObserver.observe(element));
      root.classList.add('reveal-ready');
    }
    updatePreferences();
    revealHashTarget();
    revealAround(document.activeElement);

    document.addEventListener('focusin', event => revealAround(event.target));
    window.addEventListener('hashchange', revealHashTarget);
    window.addEventListener('scroll', scheduleParallax, { passive: true });
    window.addEventListener('resize', scheduleParallax, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else scheduleParallax();
    });
    for (const preference of [reducedMotion, narrowScreen, coarsePointer]) {
      preference.addEventListener('change', updatePreferences);
    }
  } catch {
    // Older or restricted browsers receive the complete, static experience.
    revealAll();
    revealObserver?.disconnect();
    parallaxObserver?.disconnect();
    parallaxEnabled = false;
    resetParallax();
  }
}
