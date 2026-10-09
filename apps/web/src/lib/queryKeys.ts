/**
 * Claves de consulta que **comparten módulos distintos**: la usa quien consulta y
 * quien invalida. Viven en un módulo hoja (sin importar proveedores) para que
 * proveedores que se necesitan entre sí —`AuthProvider` invalida la identidad y
 * `ClinicIdentityProvider` pregunta por la sesión— no se importen en círculo.
 */

/**
 * Identidad del consultorio (ADR 0056): nombre, RIF, teléfonos, odontólogos y logo.
 * La consulta el proveedor de identidad y la invalidan el login, el perfil y el
 * onboarding cuando el titular la edita.
 */
export const CLINIC_IDENTITY_QUERY_KEY = ['identidad-consultorio'] as const;
