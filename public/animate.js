// Retro digital-readout count-up: when a metric's underlying number
// changes, tween the displayed text from the old value to the new one
// instead of snapping — like an odometer or a split-flap clock catching up
// to the current time. Skips the tween entirely when the value hasn't
// actually moved, so a 5s poll that returns the same numbers doesn't set
// anything in motion — only real changes animate.

const state = new WeakMap(); // el -> { raw: number, raf: number|null }

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// key: an element to hold both the visible text and the tween's own memory
// of "where it last was" (so the next update tweens from there, not from
// scratch). toValue: the new raw number. formatFn(number) -> string.
export function animateNumber(el, toValue, formatFn, opts = {}) {
  if (!el || toValue == null || Number.isNaN(toValue)) return;
  const duration = opts.duration ?? 520;
  const prev = state.get(el);

  if (prev?.raf) cancelAnimationFrame(prev.raf);

  // First paint for this element, or the value didn't move — no animation,
  // just render it (also covers the initial page load, where counting up
  // from zero would be noise, not signal).
  if (!prev || prev.raw === toValue) {
    el.textContent = formatFn(toValue);
    state.set(el, { raw: toValue, raf: null });
    return;
  }

  const fromValue = prev.raw;
  const start = performance.now();
  el.classList.add('digit-roll');

  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const current = fromValue + (toValue - fromValue) * easeOutCubic(t);
    el.textContent = formatFn(current);
    if (t < 1) {
      state.set(el, { raw: toValue, raf: requestAnimationFrame(tick) });
    } else {
      el.textContent = formatFn(toValue);
      el.classList.remove('digit-roll');
      state.set(el, { raw: toValue, raf: null });
    }
  }
  state.set(el, { raw: toValue, raf: requestAnimationFrame(tick) });
}
