import { useEffect, useRef, type RefObject } from "react";

/**
 * Keep the selector deliberately conservative: hidden/disabled elements are
 * filtered after querying so focus never escapes to an inert control.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isVisible(element: HTMLElement): boolean {
  return !element.hidden && element.getAttribute("aria-hidden") !== "true"
    && (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
}

export function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}

/** Pure keyboard-navigation rule shared by disclosure menus and unit tests. */
export function nextMenuItemIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | null {
  if (itemCount <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") return (Math.max(currentIndex, -1) + 1) % itemCount;
  if (key === "ArrowUp") return currentIndex <= 0 ? itemCount - 1 : currentIndex - 1;
  return null;
}

interface ModalFocusOptions {
  open: boolean;
  containerRef: RefObject<HTMLElement>;
  onClose?: () => void;
  initialFocusRef?: RefObject<HTMLElement>;
  lockScroll?: boolean;
}

/**
 * Dialog focus lifecycle used by both public and admin modals:
 * focus enters the dialog, Tab wraps inside it, Escape closes it, and the
 * trigger receives focus again after unmount. The latest callbacks are kept in
 * refs so inline handlers do not restart the focus lifecycle on every render.
 */
export function useModalFocus({
  open,
  containerRef,
  onClose,
  initialFocusRef,
  lockScroll = true,
}: ModalFocusOptions): void {
  const closeRef = useRef(onClose);
  const initialRef = useRef(initialFocusRef);
  closeRef.current = onClose;
  initialRef.current = initialFocusRef;

  useEffect(() => {
    if (!open) return;

    const restoreTarget = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = "hidden";

    const frame = window.requestAnimationFrame(() => {
      const preferred = initialRef.current?.current;
      const target = preferred && isVisible(preferred)
        ? preferred
        : getFocusableElements(containerRef.current)[0] ?? containerRef.current;
      target?.focus({ preventScroll: true });
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && closeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const items = getFocusableElements(containerRef.current);
      if (items.length === 0) {
        event.preventDefault();
        containerRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !containerRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      if (lockScroll) document.body.style.overflow = previousOverflow;
      if (restoreTarget?.isConnected) restoreTarget.focus({ preventScroll: true });
    };
  }, [containerRef, lockScroll, open]);
}
