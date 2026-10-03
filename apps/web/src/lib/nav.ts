import type { Permission } from '@odontocrm/contracts';
import {
  BellRing,
  CalendarRange,
  ChartColumn,
  ClipboardList,
  ClipboardPlus,
  ContactRound,
  House,
  IdCard,
  MonitorPlay,
  ScrollText,
  Stethoscope,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { TranslationKey } from './i18n';

/**
 * Catálogo de módulos del shell. Cada módulo declara la ruta, el permiso que lo
 * habilita y la fase del plan en la que se construye: de aquí salen el menú
 * lateral, los accesos del tablero y los placeholders de lo que aún no existe.
 */

export type ModuleId =
  | 'inicio'
  | 'recepcion'
  | 'registro'
  | 'pacientes'
  | 'programacion'
  | 'notificaciones'
  | 'secretaria'
  | 'consultorio'
  | 'reportes'
  | 'auditoria'
  | 'usuarios'
  | 'pantallas';

export interface ModuleDefinition {
  id: ModuleId;
  path: string;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: LucideIcon;
  /** Permiso necesario para ver el módulo; `null` = basta con tener sesión. */
  permission: Permission | null;
  /** Fase del plan en la que se construye la funcionalidad. */
  phase: number;
}

export const MODULES: Readonly<Record<ModuleId, ModuleDefinition>> = {
  inicio: {
    id: 'inicio',
    path: '/inicio',
    labelKey: 'modulo.inicio.titulo',
    descriptionKey: 'modulo.inicio.descripcion',
    icon: House,
    permission: null,
    phase: 1,
  },
  recepcion: {
    id: 'recepcion',
    path: '/recepcion',
    labelKey: 'modulo.recepcion.titulo',
    descriptionKey: 'modulo.recepcion.descripcion',
    icon: ClipboardPlus,
    permission: 'scheduling:write',
    phase: 3,
  },
  registro: {
    id: 'registro',
    path: '/registro',
    labelKey: 'modulo.registro.titulo',
    descriptionKey: 'modulo.registro.descripcion',
    icon: IdCard,
    // El módulo registra pacientes además de consultarlos (Fase 2).
    permission: 'patients:write',
    phase: 2,
  },
  pacientes: {
    id: 'pacientes',
    path: '/pacientes',
    labelKey: 'modulo.pacientes.titulo',
    descriptionKey: 'modulo.pacientes.descripcion',
    icon: ContactRound,
    // Consultar la ficha no exige poder registrarla: el odontólogo entra aquí.
    permission: 'patients:read',
    phase: 2,
  },
  programacion: {
    id: 'programacion',
    path: '/programacion',
    labelKey: 'modulo.programacion.titulo',
    descriptionKey: 'modulo.programacion.descripcion',
    icon: CalendarRange,
    // Consultar la jornada basta para entrar (el odontólogo la lee); las
    // acciones de escritura se comprueban dentro de la pantalla.
    permission: 'scheduling:read',
    phase: 3,
  },
  notificaciones: {
    id: 'notificaciones',
    path: '/notificaciones',
    labelKey: 'modulo.notificaciones.titulo',
    descriptionKey: 'modulo.notificaciones.descripcion',
    icon: BellRing,
    // Ver la bandeja de envíos basta para entrar (el odontólogo solo mira);
    // reintentar, editar plantillas y desvincular exigen `scheduling:notify` y
    // se comprueban dentro de la pantalla.
    permission: 'scheduling:read',
    phase: 4,
  },
  secretaria: {
    id: 'secretaria',
    path: '/secretaria',
    labelKey: 'modulo.secretaria.titulo',
    descriptionKey: 'modulo.secretaria.descripcion',
    icon: ClipboardList,
    permission: 'scheduling:read',
    phase: 5,
  },
  consultorio: {
    id: 'consultorio',
    path: '/consultorio',
    labelKey: 'modulo.consultorio.titulo',
    descriptionKey: 'modulo.consultorio.descripcion',
    icon: Stethoscope,
    permission: 'clinical:read',
    phase: 6,
  },
  reportes: {
    id: 'reportes',
    path: '/reportes',
    labelKey: 'modulo.reportes.titulo',
    descriptionKey: 'modulo.reportes.descripcion',
    icon: ChartColumn,
    permission: 'reports:read',
    phase: 9,
  },
  auditoria: {
    id: 'auditoria',
    path: '/auditoria',
    labelKey: 'modulo.auditoria.titulo',
    descriptionKey: 'modulo.auditoria.descripcion',
    icon: ScrollText,
    permission: 'audit:read',
    phase: 9,
  },
  usuarios: {
    id: 'usuarios',
    path: '/usuarios',
    labelKey: 'modulo.usuarios.titulo',
    descriptionKey: 'modulo.usuarios.descripcion',
    icon: Users,
    permission: 'users:manage',
    phase: 1,
  },
  pantallas: {
    id: 'pantallas',
    path: '/pantallas',
    labelKey: 'modulo.pantallas.titulo',
    descriptionKey: 'modulo.pantallas.descripcion',
    icon: MonitorPlay,
    permission: 'screens:manage',
    phase: 5,
  },
};

export interface NavSection {
  titleKey: TranslationKey;
  modules: readonly ModuleId[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  { titleKey: 'menu.seccion.principal', modules: ['inicio'] },
  {
    titleKey: 'menu.seccion.operacion',
    modules: [
      'recepcion',
      'registro',
      'pacientes',
      'programacion',
      'notificaciones',
      'secretaria',
      'consultorio',
    ],
  },
  { titleKey: 'menu.seccion.analisis', modules: ['reportes', 'auditoria'] },
  { titleKey: 'menu.seccion.admin', modules: ['usuarios', 'pantallas'] },
];

/** Módulo al que pertenece una ruta; `null` si es una pantalla sin módulo. */
export const moduleForPath = (pathname: string): ModuleDefinition | null =>
  Object.values(MODULES).find(
    (modulo) => pathname === modulo.path || pathname.startsWith(`${modulo.path}/`),
  ) ?? null;
