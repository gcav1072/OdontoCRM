import { useEffect, useId, useRef, type ReactNode } from 'react';

import { cn } from '../lib/cn';

export type DialogSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<DialogSize, string> = {
  sm: 'w-[min(94vw,26rem)]',
  md: 'w-[min(94vw,38rem)]',
  lg: 'w-[min(94vw,56rem)]',
};

export interface DialogProps {
  open: boolean;
  /** Se llama al cerrar: Escape, clic en el fondo, botón de cerrar o `close()` nativo. */
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  /** Evita el cierre al pulsar el fondo (formularios con datos sin guardar). */
  dismissOnBackdrop?: boolean;
  closeLabel?: string;
}

/**
 * Diálogo modal sobre el elemento nativo `<dialog>`: el navegador aporta el
 * foco atrapado, el `::backdrop` y el cierre con Escape, sin dependencias.
 * El componente solo sincroniza ese estado con React.
 */
export const Dialog = ({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissOnBackdrop = true,
  closeLabel = 'Cerrar',
}: DialogProps) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      // `showModal` es lo que activa el foco atrapado y el fondo inerte.
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // Cualquier cierre nativo (por ejemplo el botón «cerrar» del navegador)
    // tiene que reflejarse en el estado de React.
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Escape: se controla desde React para poder ignorarlo si conviene.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (dismissOnBackdrop && event.target === dialogRef.current) onClose();
      }}
      className={cn(
        'm-auto max-h-[90dvh] overflow-hidden rounded-card border border-border bg-surface p-0 text-ink shadow-panel',
        'backdrop:bg-overlay',
        SIZE_CLASSES[size],
      )}
    >
      <div className="flex max-h-[90dvh] flex-col">
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-0.5 text-sm text-ink-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="-mr-1 rounded-control p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
              className="size-4"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-muted px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </dialog>
  );
};
