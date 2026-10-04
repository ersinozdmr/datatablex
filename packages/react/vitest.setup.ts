import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The automatic cleanup of @testing-library/react requires `globals: true`;
// because the test files import from `vitest` explicitly (we do not use
// globals), we register it by hand here. Otherwise the DOM and timers that a
// test mounts would pollute the results of the next test.
afterEach(() => {
  cleanup();
});

// The scrollbar measurement of rc-util calls getComputedStyle(el, "::-webkit-scrollbar");
// jsdom throws "Not implemented" for the pseudo-element argument and prints a
// stack trace to stderr in every test. Because this noise in the test output
// masks REAL errors, the pseudo-element argument is swallowed. jsdom does not
// compute pseudo-element styles anyway, so no behavior is lost; only the noise goes away.
if (typeof window !== "undefined") {
  const original = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((element: Element, pseudoElement?: string | null) =>
    pseudoElement ? original(element) : original(element, pseudoElement)) as typeof window.getComputedStyle;
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


// The default `pointerEventsCheck` of `userEvent` calls `getComputedStyle`
// from the target element up to the root on EVERY pointer action. In jsdom
// this call re-evaluates the hundreds of rules that AntD injects with
// CSS-in-JS each time, so a single click takes ~1 s and the tests of the
// two-step header menu regularly exceeded the 5 s budget. When the check is
// turned off, the "Filter -> type -> Apply" chain drops from ~2.1 s to ~0.4 s
// in measurements. What is turned off is only the check that REFUSES a click
// on an element with `pointer-events: none`; the tests already verify
// visibility with `findBy*`/`toBeVisible`.
vi.mock("@testing-library/user-event", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@testing-library/user-event")>();
  const setup: typeof mod.default.setup = (options) =>
    mod.default.setup({ pointerEventsCheck: mod.PointerEventsCheckLevel.Never, ...options });
  return { ...mod, default: { ...mod.default, setup } };
});

// NOTE: because of the same `getComputedStyle` cost, `*ByRole({ name })`
// queries can take 1-2 s on their own in the AntD tree. Where the role
// semantics are NOT being verified (only to find an element), prefer
// `*ByLabelText`/`*ByText`; use a role query only when the role itself is the
// subject of the test (for example the `menuitem` roles of the header menu).
