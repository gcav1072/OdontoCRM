import type { Permission } from '@odontocrm/contracts';
import {
  BellRing,
  CalendarRange,
  ChartColumn,
  ClipboardList,
  ContactRound,
  House,
  IdCard,
  MonitorPlay,
  ScrollText,
  Stethoscope,
  Users,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { TranslationKey } from './i18n';

/**
 * Catálogo de módulos del shell. Cada módulo declara la ruta y el permiso que lo
 * habilita: de aquí salen el menú lateral y los accesos del tablero.
 *
 * Las fases del plan **no** aparecen aquí: son un detalle interno del desarrollo y en
 * la interfaz confundían al personal («Fase 3», «Fase 9» no significan nada para quien
 * atiende el consultorio). Se quitaron en la Fase 10.
 */

export type ModuleId =
  | 'inicio'
  | 'registro'
  | 'pacientes'
  | 'programacion'
  | 'notificaciones'
  | 'secretaria'
  | 'consultorio'
  | 'flujo'
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
}

export const MODULES: Readonly<Record<ModuleId, ModuleDefinition>> = {
  inicio: {
    id: 'inicio',
    path: '/inicio',
    labelKey: 'modulo.inicio.titulo',
    descriptionKey: 'modulo.inicio.descripcion',
    icon: House,
    permission: null,
  },
  registro: {
    id: 'registro',
    path: '/registro',
    labelKey: 'modulo.registro.titulo',
    descriptionKey: 'modulo.registro.descripcion',
    icon: IdCard,
    // El módulo registra pacientes además de consultarlos (Fase 2).
    permission: 'patients:write',
  },
  pacientes: {
    id: 'pacientes',
    path: '/pacientes',
    labelKey: 'modulo.pacientes.titulo',
    descriptionKey: 'modulo.pacientes.descripcion',
    icon: ContactRound,
    // Consultar la ficha no exige poder registrarla: el odontólogo entra aquí.
    permission: 'patients:read',
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
  },
  secretaria: {
    id: 'secretaria',
    path: '/secretaria',
    labelKey: 'modulo.secretaria.titulo',
    descriptionKey: 'modulo.secretaria.descripcion',
    icon: ClipboardList,
    permission: 'scheduling:read',
  },
  consultorio: {
    id: 'consultorio',
    path: '/consultorio',
    labelKey: 'modulo.consultorio.titulo',
    descriptionKey: 'modulo.consultorio.descripcion',
    icon: Stethoscope,
    permission: 'clinical:read',
  },
  flujo: {
    id: 'flujo',
    path: '/flujo',
    labelKey: 'modulo.flujo.titulo',
    descriptionKey: 'modulo.flujo.descripcion',
    icon: Workflow,
    // La página unificada necesita las dos mitades del día: la agenda (cola,
    // llamados y estados) y la clínica (historia y sesión). Sin `clinical:read`
    // el centro de la pantalla no tendría nada que mostrar.
    permission: 'clinical:read',
  },
  reportes: {
    id: 'reportes',
    path: '/reportes',
    labelKey: 'modulo.reportes.titulo',
    descriptionKey: 'modulo.reportes.descripcion',
    icon: ChartColumn,
    permission: 'reports:read',
  },
  auditoria: {
    id: 'auditoria',
    path: '/auditoria',
    labelKey: 'modulo.auditoria.titulo',
    descriptionKey: 'modulo.auditoria.descripcion',
    icon: ScrollText,
    permission: 'audit:read',
  },
  usuarios: {
    id: 'usuarios',
    path: '/usuarios',
    labelKey: 'modulo.usuarios.titulo',
    descriptionKey: 'modulo.usuarios.descripcion',
    icon: Users,
    permission: 'users:manage',
  },
  pantallas: {
    id: 'pantallas',
    path: '/pantallas',
    labelKey: 'modulo.pantallas.titulo',
    descriptionKey: 'modulo.pantallas.descripcion',
    icon: MonitorPlay,
    permission: 'screens:manage',
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
      'flujo',
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
