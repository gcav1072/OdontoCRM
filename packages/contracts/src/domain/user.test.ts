import { describe, expect, it } from 'vitest';

import { diffSensitiveFields } from './audit.js';
import { PERMISSIONS } from './enums.js';
import {
  changePasswordSchema,
  createUserSchema,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  permissionsForRoles,
  updateUserSchema,
  usernameSchema,
} from './user.js';

describe('permisos por rol', () => {
  it('admin puede todo lo declarado', () => {
    for (const permission of PERMISSIONS) {
      expect(hasPermission(['admin'], permission)).toBe(true);
    }
  });

  it('secretario gestiona pacientes y agenda, pero no usuarios ni auditoría', () => {
    expect(hasPermission(['secretario'], 'patients:write')).toBe(true);
    expect(hasPermission(['secretario'], 'scheduling:notify')).toBe(true);
    expect(hasPermission(['secretario'], 'users:manage')).toBe(false);
    expect(hasPermission(['secretario'], 'audit:read')).toBe(false);
  });

  it('odontologo escribe lo clínico y no administra usuarios', () => {
    expect(hasPermission(['odontologo'], 'clinical:write')).toBe(true);
    expect(hasPermission(['odontologo'], 'odontogram:write')).toBe(true);
    expect(hasPermission(['odontologo'], 'users:manage')).toBe(false);
    expect(hasPermission(['odontologo'], 'audit:read')).toBe(false);
  });

  it('odontologo escribe el flujo del día cuando trabaja solo (2026-10-04)', () => {
    // Fase 8: la odontóloga sin asistente lleva la jornada desde `/flujo`.
    expect(hasPermission(['odontologo'], 'scheduling:write')).toBe(true);
    // Notificar y autorizar sobrecupo siguen fuera de su alcance.
    expect(hasPermission(['odontologo'], 'scheduling:notify')).toBe(false);
    expect(hasPermission(['odontologo'], 'scheduling:overbook')).toBe(false);
  });

  it('la política de cancelación del paciente es del admin y del odontólogo (ADR 0057)', () => {
    // El corte de días lo deciden quien lleva la clínica; el mostrador no lo cambia.
    expect(hasPermission(['admin'], 'scheduling:cancel_policy')).toBe(true);
    expect(hasPermission(['odontologo'], 'scheduling:cancel_policy')).toBe(true);
    expect(hasPermission(['secretario'], 'scheduling:cancel_policy')).toBe(false);
    expect(hasPermission(['pantalla'], 'scheduling:cancel_policy')).toBe(false);
  });

  it('odontologo registra y edita pacientes, pero no los borra (2026-10-03)', () => {
    expect(hasPermission(['odontologo'], 'patients:read')).toBe(true);
    expect(hasPermission(['odontologo'], 'patients:write')).toBe(true);
    expect(hasPermission(['odontologo'], 'patients:edit_sensitive')).toBe(true);
    expect(hasPermission(['odontologo'], 'patients:delete')).toBe(false);
  });

  it('borrar un paciente es exclusivo del admin', () => {
    expect(hasPermission(['admin'], 'patients:delete')).toBe(true);
    expect(hasPermission(['secretario'], 'patients:delete')).toBe(false);
    expect(hasPermission(['pantalla'], 'patients:delete')).toBe(false);
  });

  it('pantalla solo puede mostrar las pantallas kiosko', () => {
    expect(permissionsForRoles(['pantalla'])).toEqual(['screens:display']);
  });

  it('la secretaría lleva la caja entera y el odontólogo solo mira (Fase 11)', () => {
    // §3.5 del plan de facturación: la secretaría atiende sola el mostrador, así que anula también
    // (`billing:void`), siempre con motivo; el odontólogo ve lo que se cobró de sus tratamientos.
    const deFacturacion = [
      'billing:read',
      'billing:write',
      'billing:collect',
      'billing:rates',
      'billing:void',
    ] as const;

    for (const permiso of deFacturacion) {
      expect(hasPermission(['admin'], permiso), `admin debería tener ${permiso}`).toBe(true);
      expect(hasPermission(['secretario'], permiso), `secretaría debería tener ${permiso}`).toBe(
        true,
      );
    }
    expect(hasPermission(['odontologo'], 'billing:read')).toBe(true);
    for (const permiso of deFacturacion.filter((p) => p !== 'billing:read')) {
      expect(hasPermission(['odontologo'], permiso), `odontólogo no debería tener ${permiso}`).toBe(
        false,
      );
    }
    // La pantalla kiosko no ve dinero.
    expect(hasPermission(['pantalla'], 'billing:read')).toBe(false);
  });

  it('acumula permisos cuando hay varios roles y no repite', () => {
    const combined = permissionsForRoles(['secretario', 'odontologo']);
    expect(new Set(combined).size).toBe(combined.length);
    expect(combined).toContain('scheduling:write');
    expect(combined).toContain('clinical:write');
  });

  it('trabaja con listas de permisos', () => {
    expect(hasAnyPermission(['secretario'], ['users:manage', 'patients:read'])).toBe(true);
    expect(hasAllPermissions(['secretario'], ['patients:read', 'users:manage'])).toBe(false);
  });
});

describe('validación de usuarios', () => {
  it('normaliza el nombre de usuario a minúsculas', () => {
    expect(usernameSchema.parse('  Recepcion  ')).toBe('recepcion');
    expect(usernameSchema.safeParse('ab').success).toBe(false);
    expect(usernameSchema.safeParse('con espacios').success).toBe(false);
  });

  it('exige al menos un rol y contraseña de 10 caracteres', () => {
    const valid = createUserSchema.safeParse({
      username: 'recepcion',
      fullName: 'María Pérez',
      password: 'consultorio-2026',
      roles: ['secretario'],
    });
    expect(valid.success).toBe(true);

    expect(
      createUserSchema.safeParse({
        username: 'recepcion',
        fullName: 'María Pérez',
        password: 'corta',
        roles: ['secretario'],
      }).success,
    ).toBe(false);

    expect(
      createUserSchema.safeParse({
        username: 'recepcion',
        fullName: 'María Pérez',
        password: 'consultorio-2026',
        roles: [],
      }).success,
    ).toBe(false);
  });

  it('exige motivo al modificar un usuario', () => {
    expect(updateUserSchema.safeParse({ fullName: 'Otro Nombre' }).success).toBe(false);
    expect(
      updateUserSchema.safeParse({ fullName: 'Otro Nombre', reason: 'corrección de nombre' })
        .success,
    ).toBe(true);
  });

  it('el cambio de contraseña exige coincidencia y que sea distinta', () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'consultorio-2026',
        newPassword: 'nueva-clave-2026',
        repeatPassword: 'nueva-clave-2026',
      }).success,
    ).toBe(true);

    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'consultorio-2026',
        newPassword: 'nueva-clave-2026',
        repeatPassword: 'otra-clave-2026',
      }).success,
    ).toBe(false);

    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'consultorio-2026',
        newPassword: 'consultorio-2026',
        repeatPassword: 'consultorio-2026',
      }).success,
    ).toBe(false);
  });
});

describe('diferencia de campos sensibles', () => {
  it('detecta solo lo que cambió y guarda antes y después', () => {
    const before = { fullName: 'María Pérez', isActive: true, email: null };
    const after = { fullName: 'María Pérez Gómez', isActive: true, email: null };

    const diff = diffSensitiveFields(before, after, ['fullName', 'isActive', 'email']);

    expect(diff.changedFields).toEqual(['fullName']);
    expect(diff.before).toEqual({ fullName: 'María Pérez' });
    expect(diff.after).toEqual({ fullName: 'María Pérez Gómez' });
  });

  it('no genera registro cuando no hay cambios', () => {
    const value = { fullName: 'María Pérez', isActive: true };
    const diff = diffSensitiveFields(value, { ...value }, ['fullName', 'isActive']);

    expect(diff.changedFields).toEqual([]);
    expect(diff.before).toBeNull();
    expect(diff.after).toBeNull();
  });

  it('trata la ausencia de valor como nulo', () => {
    const diff = diffSensitiveFields<Record<string, unknown>>(
      { email: null },
      { email: 'correo@ejemplo.com' },
      ['email'],
    );

    expect(diff.changedFields).toEqual(['email']);
    expect(diff.before).toEqual({ email: null });
  });
});
