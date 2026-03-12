/**
 * Node-safe DOM-lite types shared across browser-adjacent modules.
 * Avoids duplicating inline type definitions for page.evaluate() contexts.
 */

export interface FridayDomElementLike {
  id?: string;
  tagName?: string;
  className?: unknown;
  textContent?: string | null;
  parentElement?: { children: Iterable<FridayDomElementLike> } | null;
  getAttribute?: (name: string) => string | null;
  querySelector?: (selector: string) => FridayDomElementLike | null;
  querySelectorAll?: (selector: string) => Iterable<FridayDomElementLike>;
  closest?: (selector: string) => FridayDomElementLike | null;
}

export interface FridayDomDocumentLike {
  cookie?: string;
  querySelector: (selector: string) => FridayDomElementLike | null;
  querySelectorAll: (selector: string) => Iterable<FridayDomElementLike>;
}

export interface FridayDomWindowLike {
  scrollBy: (x: number, y: number) => void;
}
