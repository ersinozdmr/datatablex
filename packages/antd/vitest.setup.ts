import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import type { RenderOptions } from "@testing-library/react";

// The automatic cleanup of @testing-library/react requires `globals: true`;
// because the test files import from `vitest` explicitly (no globals), the
// cleanup is registered by hand here. Otherwise the DOM and timers that one test
// mounts would pollute the results of the next one.
afterEach(() => {
  cleanup();
});

// The scrollbar measurement of `@rc-component/util` calls getComputedStyle(el, "::-webkit-scrollbar");
// jsdom throws "Not implemented" for the pseudo-element argument and prints a
// stack trace to stderr in every test. Because this noise in the test output
// masks REAL errors, the pseudo-element argument is swallowed. jsdom does not
// compute pseudo-element styles anyway, so no behavior is lost; only the noise
// goes away.
if (typeof window !== "undefined") {
  const original = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((element: Element, pseudoElement?: string | null) =>
    pseudoElement ? original(element) : original(element, pseudoElement)) as typeof window.getComputedStyle;
}

// Ant Design's pop-ups (popover, dropdown, select) close through `@rc-component/motion`:
// the "leave" animation ends and the element is hidden with the `*-hidden`
// class. Because jsdom 29's CSS module recognizes `WebkitAnimation` and
// `WebkitTransition`, `@rc-component/motion` decides that animations are supported, but
// jsdom does not run animations, so `animationend` never arrives: a closed menu
// stays visible in the DOM and role queries keep finding it. Every `render` is
// therefore wrapped with Ant Design's own switch-off, the `motion: false` token.
// If a test has its own `wrapper`, that one is used.
vi.mock("@testing-library/react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@testing-library/react")>();
  const { createElement } = await import("react");
  const { ConfigProvider } = await import("antd");
  const NoMotion = ({ children }: { children?: ReactNode }) =>
    createElement(ConfigProvider, { theme: { token: { motion: false } } }, children);
  const render = ((ui: ReactNode, options?: RenderOptions) => mod.render(ui, { wrapper: NoMotion, ...options })) as typeof mod.render;
  return { ...mod, render };
});

// Node 25 and later define a `localStorage` and a `sessionStorage` of their own on `globalThis`. Without
// `--localstorage-file` they are unusable, and because vitest does not overwrite a global that already exists,
// they hide jsdom's: `window.localStorage` is `undefined` in the tests. jsdom's own storage is put back.
const dom = (globalThis as { jsdom?: { window: Pick<Window, "localStorage" | "sessionStorage"> } }).jsdom;
if (dom) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, enumerable: true, writable: true, value: dom.window[key] });
  }
}

// AntD reads window.matchMedia (responsive grid) — jsdom doesn't implement it.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}

// Ant Design 6 measures elements with `ResizeObserver` (through `@rc-component/resize-observer`), which jsdom does
// not implement. jsdom does no layout either, so an observer that never reports a size loses nothing.
if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  class NoResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: NoResizeObserver });
}


// The default `pointerEventsCheck` of `userEvent` calls `getComputedStyle` from
// the target element up to the root on EVERY pointer action. In jsdom this call
// re-evaluates the hundreds of rules that Ant Design injects with CSS-in-JS each
// time, so a single click takes ~1 s and the two-step header menu tests
// regularly exceeded the 5 s budget. When the check is switched off, the
// "Filter -> type -> Apply" chain drops from ~2.1 s to ~0.4 s as measured. What
// is switched off is only the check that REJECTS a click on an element with
// `pointer-events: none`; the tests already verify visibility with
// `findBy*` / `toBeVisible`.
vi.mock("@testing-library/user-event", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@testing-library/user-event")>();
  const setup: typeof mod.default.setup = (options) =>
    mod.default.setup({ pointerEventsCheck: mod.PointerEventsCheckLevel.Never, ...options });
  return { ...mod, default: { ...mod.default, setup } };
});

// NOTE: because of the same `getComputedStyle` cost, a `*ByRole({ name })` query
// can take 1-2 s on its own in an Ant Design tree. Where the role semantics are
// NOT being verified (only finding an element), prefer `*ByLabelText` or
// `*ByText`; use a role query only when the role itself is under test (for
// example the `menuitem` roles of the header menu).
