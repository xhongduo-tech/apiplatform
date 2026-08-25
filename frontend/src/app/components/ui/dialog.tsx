import { cn } from "./utils";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { createContext, useContext, useId, useRef, type ReactNode } from "react";
import { useModalFocus } from "../../accessibility";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

export function Dialog({ open, onOpenChange, children, className }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const generatedId = useId().replace(/:/g, "");
  const titleId = `dialog-title-${generatedId}`;
  const descriptionId = `dialog-description-${generatedId}`;
  useModalFocus({
    open,
    containerRef: dialogRef,
    onClose: () => onOpenChange(false),
  });

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain">
      <div
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div
        className="relative z-10 flex min-h-full items-center justify-center p-4"
        onClick={(event) => { if (event.target === event.currentTarget) onOpenChange(false); }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          tabIndex={-1}
          className={cn(
            "relative w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto rounded-block border border-border bg-card p-6 shadow-pop",
            className,
          )}
        >
          <DialogA11yContext.Provider value={{ titleId, descriptionId }}>
            {children}
          </DialogA11yContext.Provider>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const DialogA11yContext = createContext<{ titleId: string; descriptionId: string } | null>(null);

interface DialogContentProps {
  children: ReactNode;
  className?: string;
}

export function DialogContent({ children, className }: DialogContentProps) {
  return <div className={cn("", className)}>{children}</div>;
}

export function DialogHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-4 flex flex-col gap-1.5", className)}>{children}</div>;
}

export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  const ids = useContext(DialogA11yContext);
  return <h2 id={ids?.titleId} className={cn("font-serif text-lg font-medium text-fg", className)}>{children}</h2>;
}

export function DialogDescription({ children, className }: { children: ReactNode; className?: string }) {
  const ids = useContext(DialogA11yContext);
  return <div id={ids?.descriptionId} className={cn("text-sm text-fg-muted", className)}>{children}</div>;
}

export function DialogClose({ onClick, className, ariaLabel = "Close" }: { onClick?: () => void; className?: string; ariaLabel?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(
        "absolute right-4 top-4 rounded-lg p-1 text-fg-muted transition hover:bg-bg-soft hover:text-fg",
        className,
      )}
    >
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
