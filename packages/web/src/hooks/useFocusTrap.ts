/**
 * Minimal keyboard focus trap for modal-like surfaces (drawers, dialogs).
 *
 * Behavior when `active`:
 *   - On mount: stash the previously-focused element; focus the first
 *     tabbable descendant of `ref.current` (or `ref.current` itself if
 *     it's tabbable).
 *   - Tab / Shift+Tab inside the ref: cycle within the trapped tree.
 *   - Escape: invoke `onEscape` (caller closes).
 *   - On unmount / active->false: return focus to the previously-focused
 *     element.
 *
 * Not a substitute for a real a11y library, but enough for our admin
 * surfaces (drawer + edit modal). Avoids pulling in a 30 kB focus-trap
 * dep for two call sites.
 */

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getTabbable(container: HTMLElement): HTMLElement[] {
  // The selector already excludes `[disabled]` and `[tabindex="-1"]`;
  // an extra runtime filter would just re-check what the CSS selector
  // already excluded. Keep the surface minimal.
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export function useFocusTrap(active: boolean, ref: React.RefObject<HTMLElement | null>, onEscape: () => void) {
  // Capture the element that had focus when the trap activated; return
  // focus to it when the trap deactivates. Without this, closing a modal
  // would drop focus to <body>, which screen readers + keyboard users
  // both find disorienting.
  const previousActiveRef = useRef<HTMLElement | null>(null);

  // Stash `onEscape` in a ref so callers can pass an inline arrow
  // (`onEscape={() => setRow(null)}`) without retearing the main
  // effect on every parent re-render. Reading via ref means the
  // keydown handler always sees the latest callback while the
  // listener installation runs only when `active` / `ref` change.
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    previousActiveRef.current = (document.activeElement as HTMLElement | null) ?? null;

    const initial = getTabbable(container)[0] ?? container;
    initial.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const tabbables = getTabbable(container!);
      if (tabbables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = tabbables[0];
      const last = tabbables[tabbables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      } else if (activeEl && !container!.contains(activeEl)) {
        // Stray focus outside the trapped tree -- pull it back in.
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousActiveRef.current?.focus?.();
    };
  }, [active, ref]);
}
