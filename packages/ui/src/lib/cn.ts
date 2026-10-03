import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Une clases de Tailwind resolviendo conflictos: la última clase utilizable gana.
 * Todo el sistema de diseño compone estilos con esta función.
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
