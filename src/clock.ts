// One clock for the whole desk. In sim mode it runs faster than wall time so a
// full night can be replayed in minutes; in live/paper it is the real clock.
let speed = 1;
let base = Date.now();

export const clock = {
  init(s: number) { speed = Math.max(1, s); base = Date.now(); },
  get speed() { return speed; },
  now() { return Math.round(base + (Date.now() - base) * speed); },
  every(ms: number, fn: () => void) { return setInterval(fn, Math.max(15, ms / speed)); },
  after(ms: number, fn: () => void) { return setTimeout(fn, Math.max(0, ms / speed)); },
  sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, Math.max(0, ms / speed))); },
};

export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s % 60).padStart(2, '0')}s`;
};
