import { cn } from '../lib/cn';

export type SpinnerSize = 'sm' | 'md' | 'lg';

const SIZES: Record<SpinnerSize, string> = {
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-8',
};

export interface SpinnerProps {
  size?: SpinnerSize;
  /** Texto que leen los lectores de pantalla; visible solo si se pide con `showLabel`. */
  label?: string;
  showLabel?: boolean;
  className?: string;
}

/**
 * Indicador de carga. Se dibuja con SVG propio (sin dependencias) y hereda el
 * color del texto, así funciona sobre botones, tablas o pantallas completas.
 */
export const Spinner = ({ size = 'md', label, showLabel = false, className }: SpinnerProps) => (
  <span
    role="status"
    aria-live="polite"
    className={cn('inline-flex items-center gap-2 text-current', className)}
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn('animate-spin', SIZES[size])}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
    <span className={showLabel ? 'text-sm text-ink-muted' : 'sr-only'}>{label ?? 'Cargando…'}</span>
  </span>
);
