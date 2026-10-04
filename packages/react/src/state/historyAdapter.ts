import type { UrlStateAdapter } from "../types.js";

/**
 * The default adapter of `syncWithUrl: true`. For apps that do not use a
 * router, it works over `window.history` and `location.search`. A page change
 * is written with `pushState` and other changes with `replaceState`; the
 * back/forward button is listened to through `popstate`. When there is no
 * `window` (rendering on the server), it returns empty parameters and writes
 * nothing.
 */
export function createHistoryAdapter(): UrlStateAdapter {
  return {
    get: () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search),
    set: (params, options) => {
      if (typeof window === "undefined") return;
      const query = params.toString();
      const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
      // `history.state` is kept, so that the state of an app without a router is not overwritten.
      if (options?.replace) window.history.replaceState(window.history.state, "", url);
      else window.history.pushState(window.history.state, "", url);
    },
    subscribe: (onChange) => {
      if (typeof window === "undefined") return () => {};
      window.addEventListener("popstate", onChange);
      return () => window.removeEventListener("popstate", onChange);
    },
  };
}
