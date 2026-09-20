// Setup file for DOM-based React component tests using happy-dom.
// Preloaded via bun test --preload (or bunfig.toml [test].preload).
//
// React 19 only exports `act` from its development build; the production build
// omits it entirely. `@testing-library/react` resolves `act` lazily at import
// time and falls back to `react-dom/test-utils`, whose `act` itself delegates
// to `React.act` — which is `undefined` under a production React build. That
// surfaces as `TypeError: React.act is not a function` in every component test.
//
// `bun test` only defaults NODE_ENV to "test" when it is unset, so an ambient
// NODE_ENV=production (e.g. in a run pod or a shell profile) makes React
// resolve to the production entrypoint and breaks the whole component suite.
// Force the test environment here, before any test file imports React, so the
// suite is reproducible regardless of the surrounding environment.
process.env.NODE_ENV = 'test';

// happy-dom must install `document` before anything imports
// `@testing-library/dom`. That package freezes `screen` at module-eval time;
// if document is missing, every screen.* query permanently throws. jest-dom@7
// made `@testing-library/dom` a required peer, so it must be loaded via
// dynamic import after the DOM globals below — not a static top-level import.

import { Window } from 'happy-dom';

const window = new Window();
const doc = window.document;

// Set up the minimal DOM globals that React and testing-library need.
globalThis.window = window as unknown as Window & typeof globalThis;
globalThis.document = doc;
globalThis.Document = window.Document as unknown as typeof Document;
globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement;
globalThis.HTMLDivElement = window.HTMLDivElement as unknown;
globalThis.HTMLSpanElement = window.HTMLSpanElement as unknown;
globalThis.HTMLButtonElement = window.HTMLButtonElement as unknown;
globalThis.SVGElement = window.SVGElement as unknown;
globalThis.Element = window.Element as unknown as typeof Element;
globalThis.Node = window.Node as unknown as typeof Node;
globalThis.EventTarget = window.EventTarget as unknown as typeof EventTarget;
globalThis.Event = window.Event as unknown as typeof Event;
globalThis.KeyboardEvent = window.KeyboardEvent as unknown as typeof KeyboardEvent;
globalThis.MouseEvent = window.MouseEvent as unknown as typeof MouseEvent;
globalThis.FocusEvent = window.FocusEvent as unknown as typeof FocusEvent;
globalThis.CustomEvent = window.CustomEvent as unknown as typeof CustomEvent;
globalThis.DOMException = window.DOMException as unknown as typeof DOMException;

// Storage (localStorage)
globalThis.localStorage = window.localStorage as unknown as Storage;
globalThis.sessionStorage = window.sessionStorage as unknown as Storage;

// CSSStyleDeclaration for element styles
globalThis.CSSStyleDeclaration = window.CSSStyleDeclaration as unknown;

// MutationObserver
globalThis.MutationObserver = window.MutationObserver as unknown as typeof MutationObserver;

// IntersectionObserver
globalThis.IntersectionObserver =
  window.IntersectionObserver as unknown as typeof IntersectionObserver;

// ResizeObserver
globalThis.ResizeObserver = window.ResizeObserver as unknown as typeof ResizeObserver;

// fetch, Request, Response, Headers
globalThis.fetch = window.fetch as unknown as typeof fetch;
globalThis.Request = window.Request as unknown as typeof Request;
globalThis.Response = window.Response as unknown as typeof Response;
globalThis.Headers = window.Headers as unknown as typeof Headers;

// URL, URLSearchParams
globalThis.URL = window.URL as unknown as typeof URL;
globalThis.URLSearchParams = window.URLSearchParams as unknown as typeof URLSearchParams;

// console – keep Node.js console, not happy-dom's virtual console
// Image (used by React for preloading)
globalThis.Image = window.Image as unknown as typeof Image;

// Selection
globalThis.getSelection = () => window.getSelection();

// innerWidth / innerHeight for responsive logic
Object.defineProperty(globalThis, 'innerWidth', {
  get: () => window.innerWidth,
  configurable: true,
});
Object.defineProperty(globalThis, 'innerHeight', {
  get: () => window.innerHeight,
  configurable: true,
});

// matchMedia
globalThis.matchMedia = window.matchMedia.bind(window) as unknown as typeof matchMedia;

// getComputedStyle (used by Radix UI @radix-ui/react-presence layout effects)
globalThis.getComputedStyle = window.getComputedStyle.bind(
  window,
) as unknown as typeof getComputedStyle;

// requestAnimationFrame / cancelAnimationFrame (happy-dom has these)
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

await import('@testing-library/jest-dom');
