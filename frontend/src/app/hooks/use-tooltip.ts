import { useState, useEffect, useRef, useCallback, type CSSProperties } from "react";

interface UseTooltipOptions {
  /** Custom position override. Default: centered below trigger, 6px gap. */
  position?: (rect: DOMRect) => CSSProperties;
}

/**
 * Shared portal tooltip positioning hook.
 * Avoids duplicating scroll/resize listeners across the four badge components in ModelPlaza.
 */
export function useTooltip(opts?: UseTooltipOptions) {
  const [active, setActive] = useState(false);
  const [tipStyle, setTipStyle] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLElement>(null);

  const posFn = opts?.position ?? defaultPosition;

  useEffect(() => {
    if (!active) {
      setTipStyle(null);
      return;
    }
    const update = () => {
      const el = ref.current;
      if (!el) return;
      setTipStyle(posFn(el.getBoundingClientRect()));
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [active, posFn]);

  const on = useCallback(() => setActive(true), []);
  const off = useCallback(() => setActive(false), []);

  const triggerProps = { ref, onMouseEnter: on, onMouseLeave: off, onFocus: on, onBlur: off, tabIndex: 0 } as const;

  return { active, tipStyle, triggerProps };
}

function defaultPosition(rect: DOMRect): CSSProperties {
  return {
    position: "fixed",
    top: rect.bottom + 6,
    left: rect.left + rect.width / 2,
    transform: "translateX(-50%)",
    zIndex: 10000,
  };
}
