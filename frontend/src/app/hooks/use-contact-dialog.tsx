import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface ContactDialogContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  openDialog: () => void;
  closeDialog: () => void;
}

const ContactDialogContext = createContext<ContactDialogContextValue | null>(null);

export function ContactDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const openDialog = useCallback(() => setOpen(true), []);
  const closeDialog = useCallback(() => setOpen(false), []);

  const value = useMemo<ContactDialogContextValue>(
    () => ({ open, setOpen, openDialog, closeDialog }),
    [open, openDialog, closeDialog],
  );

  return (
    <ContactDialogContext.Provider value={value}>
      {children}
    </ContactDialogContext.Provider>
  );
}

export function useContactDialog(): ContactDialogContextValue {
  const ctx = useContext(ContactDialogContext);
  if (!ctx) throw new Error("useContactDialog 必须在 <ContactDialogProvider> 内使用");
  return ctx;
}
