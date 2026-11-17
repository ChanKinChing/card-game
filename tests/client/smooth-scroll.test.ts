import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `smooth-scroll.ts` is DOM code, so it is exercised against a hand-built window
 * rather than a real one. The fake is deliberately small: it records listeners,
 * queues animation frames so the lerp can be stepped by hand, and lets each
 * element declare its own overflow and scroll sizes so `nearestScrollable` can be
 * driven down every branch.
 */

type Listener = (event: Record<string, unknown>) => void;

interface ElementOptions {
  parent?: FakeElement | null;
  overflowY?: string;
  overflowX?: string;
  scrollHeight?: number;
  clientHeight?: number;
  scrollWidth?: number;
  clientWidth?: number;
}

class FakeElement {
  readonly parentElement: FakeElement | null;
  readonly style: { overflowY: string; overflowX: string };
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  constructor(readonly tagName: string, options: ElementOptions = {}) {
    this.parentElement = options.parent ?? null;
    this.style = { overflowY: options.overflowY ?? 'visible', overflowX: options.overflowX ?? 'visible' };
    this.scrollHeight = options.scrollHeight ?? 0;
    this.clientHeight = options.clientHeight ?? 0;
    this.scrollWidth = options.scrollWidth ?? 0;
    this.clientWidth = options.clientWidth ?? 0;
  }
}

const listeners = new Map<string, Listener>();
let frames: Array<() => void> = [];
let scrollY = 0;
let scrollTo: ReturnType<typeof vi.fn>;
let addListener: ReturnType<typeof vi.fn>;
let win: Record<string, unknown>;
let doc: Record<string, unknown>;

function install(options: {
  reducedMotion?: boolean;
  matchMedia?: boolean;
  scrollY?: number;
  pageHeight?: number;
} = {}): void {
  listeners.clear();
  frames = [];
  scrollY = options.scrollY ?? 0;
  scrollTo = vi.fn((...args: unknown[]) => {
    const [first, second] = args;
    scrollY = typeof first === 'object' && first !== null ? (first as { top: number }).top : (second as number);
  });
  addListener = vi.fn((type: string, listener: Listener) => { listeners.set(type, listener); });
  win = {
    get scrollY() { return scrollY; },
    set scrollY(value: number) { scrollY = value; },
    innerHeight: 800,
    addEventListener: addListener,
    scrollTo,
  };
  if (options.matchMedia !== false) win.matchMedia = () => ({ matches: options.reducedMotion ?? false });
  doc = {
    body: new FakeElement('BODY'),
    documentElement: new FakeElement('HTML', { scrollHeight: options.pageHeight ?? 3000 }),
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('getComputedStyle', (node: FakeElement) => node.style);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length; });
}

/** Step the queued animation frames, so the lerp can be observed frame by frame. */
function runFrames(limit = 500): number {
  let count = 0;
  while (frames.length > 0 && count < limit) {
    frames.shift()!();
    count += 1;
  }
  return count;
}

function wheel(target: unknown, deltaY: number, extra: Record<string, unknown> = {}) {
  const event = { target, deltaY, ctrlKey: false, preventDefault: vi.fn(), ...extra };
  listeners.get('wheel')!(event);
  return event;
}

async function load() {
  vi.resetModules();
  return import('@card-game/ui/smooth-scroll');
}

beforeEach(() => { install(); });
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('smooth scroll installation', () => {
  it('does nothing when there is no window', async () => {
    vi.stubGlobal('window', undefined);
    const { installSmoothScroll } = await load();
    expect(() => installSmoothScroll()).not.toThrow();
  });

  it('does nothing when there is no document', async () => {
    vi.stubGlobal('document', undefined);
    const { installSmoothScroll } = await load();
    expect(() => installSmoothScroll()).not.toThrow();
    expect(addListener).not.toHaveBeenCalled();
  });

  it('leaves the page alone under prefers-reduced-motion', async () => {
    install({ reducedMotion: true });
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    expect(addListener).not.toHaveBeenCalled();
  });

  it('installs when matchMedia is unavailable, treating it as no preference', async () => {
    install({ matchMedia: false });
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    expect(addListener).toHaveBeenCalledTimes(3);
  });

  it('installs the three listeners exactly once', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    installSmoothScroll();
    expect(addListener.mock.calls.map(call => call[0])).toEqual(['wheel', 'resize', 'scroll']);
  });
});

describe('wheel ownership', () => {
  it('leaves a ctrl-wheel to the browser so pinch-zoom still works', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    const event = wheel(new FakeElement('DIV'), 100, { ctrlKey: true });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  it('leaves a wheel over a form control to the browser', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const event = wheel(new FakeElement(tagName), 100);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(frames).toHaveLength(0);
  });

  it('leaves a wheel over a vertically scrollable ancestor to the browser', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    const scroller = new FakeElement('DIV', { overflowY: 'auto', scrollHeight: 500, clientHeight: 100 });
    const event = wheel(new FakeElement('SPAN', { parent: scroller }), 100);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves a wheel over a horizontally scrollable ancestor to the browser', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    const scroller = new FakeElement('DIV', { overflowX: 'scroll', scrollWidth: 500, clientWidth: 100 });
    const event = wheel(new FakeElement('SPAN', { parent: scroller }), 100);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores an element that overflows but has nothing to scroll', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    /* `overflow: auto` with equal scroll and client sizes is not scrollable. */
    const inert = new FakeElement('DIV', { overflowY: 'auto', scrollHeight: 100, clientHeight: 100 });
    const event = wheel(new FakeElement('SPAN', { parent: inert }), 100);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('stops walking at the body and the document element', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    expect(wheel(doc.body, 100).preventDefault).toHaveBeenCalled();
    expect(wheel(doc.documentElement, 100).preventDefault).toHaveBeenCalled();
  });

  it('takes a wheel over a plain element and scrolls the page', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    const event = wheel(new FakeElement('DIV'), 100);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(frames).toHaveLength(1);
  });

  it('takes a wheel whose target is not an element', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    expect(wheel(null, 100).preventDefault).toHaveBeenCalled();
  });
});

describe('the lerp', () => {
  it('glides towards the target and snaps the last fraction', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    wheel(new FakeElement('DIV'), 100);
    const steps = runFrames();
    expect(steps).toBeGreaterThan(1);
    /* The final call is the integer snap, not the eased step. */
    expect(scrollTo).toHaveBeenLastCalledWith(0, 100);
    expect(scrollY).toBe(100);
  });

  it('settles in a single frame when the gap is already under half a pixel', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    wheel(new FakeElement('DIV'), 0.5);
    expect(runFrames()).toBe(1);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0.5);
  });

  it('clamps the target to the bottom of the page', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    wheel(new FakeElement('DIV'), 5000);
    runFrames();
    /* 3000 page height minus the 800 viewport. */
    expect(scrollY).toBe(2200);
  });

  it('clamps the target to the top of the page', async () => {
    install({ scrollY: 0 });
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    wheel(new FakeElement('DIV'), -5000);
    runFrames();
    expect(scrollY).toBe(0);
  });

  it('does not start a second loop while one is running', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    wheel(new FakeElement('DIV'), 100);
    wheel(new FakeElement('DIV'), 100);
    expect(frames).toHaveLength(1);
  });
});

describe('resynchronisation', () => {
  it('re-clamps the target when the page shrinks under it', async () => {
    install({ pageHeight: 3000 });
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    wheel(new FakeElement('DIV'), 5000);
    runFrames();
    expect(scrollY).toBe(2200);
    /* The page is now shorter than the scroll position. */
    (doc.documentElement as FakeElement).style.overflowY = 'visible';
    Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 900, configurable: true });
    listeners.get('resize')!({});
    wheel(new FakeElement('DIV'), 0);
    runFrames();
    expect(scrollY).toBe(100);
  });

  it('adopts a native scroll as the new target while idle', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    scrollY = 640;
    listeners.get('scroll')!({});
    wheel(new FakeElement('DIV'), 0);
    runFrames();
    expect(scrollY).toBe(640);
  });

  it('ignores a native scroll while the loop is running', async () => {
    const { installSmoothScroll } = await load();
    installSmoothScroll();
    wheel(new FakeElement('DIV'), 100);
    scrollY = 640;
    listeners.get('scroll')!({});
    runFrames();
    /* The loop's own target wins; the native position was not adopted. */
    expect(scrollY).toBe(100);
  });
});
