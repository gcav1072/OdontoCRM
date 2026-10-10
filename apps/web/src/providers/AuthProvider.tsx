import type {
  LoginInput,
  LoginResponse,
  Permission,
  Role,
  SessionInfo,
} from '@odontocrm/contracts';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { authApi } from '../lib/endpoints';
import { setAccessToken, setSessionLostHandler } from '../lib/api';
import { isPermission, isRole } from '../lib/i18n';
import { APP_SETTINGS_QUERY_KEY, CLINIC_IDENTITY_QUERY_KEY } from '../lib/queryKeys';

/**
 * Sesión de la SPA.
 *
 * El token de acceso **no** se guarda en `localStorage`: vive en la memoria del
 * cliente HTTP y, al cargar la página, se recupera con `POST /auth/refresh`
 * usando la cookie `httpOnly`. Si esa renovación falla y había una sesión
 * abierta, el cliente avisa aquí y se vuelve a `/login` (lo hace `RequireAuth`
 * al quedarse sin usuario, sin navegación imperativa).
 */

export type AuthStatus = 'cargando' | 'autenticado' | 'anonimo';

export type SessionUser = LoginResponse['user'];

export interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  roles: readonly Role[];
  permissions: readonly Permission[];
  mustChangePassword: boolean;
  /**
   * Un odontólogo que aún no completó su perfil profesional: no puede usar el sistema
   * hasta rellenarlo (el servidor le corta todo salvo el onboarding).
   */
  needsProfile: boolean;
  sessionInfo: SessionInfo | null;
  /** La sesión se cayó estando dentro: se avisa en el login. */
  sessionExpired: boolean;
  login: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
  reloadSessionInfo: () => Promise<void>;
  hasPermission: (permission: Permission) => boolean;
  /** Aplica una respuesta de login/refresco/cambio de contraseña (token + usuario). */
  applyLoginResponse: (response: LoginResponse) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * La sesión, o `null` si aún no hay `AuthProvider`. Es para los componentes que se
 * montan **fuera del shell** —los documentos imprimibles, que en las pruebas se pintan
 * sin proveedores— y que solo quieren *mejorar* si hay sesión (p. ej. el odontólogo que
 * imprime), sin reventar por no tenerla.
 */
export const useOptionalAuth = (): AuthContextValue | null => useContext(AuthContext);

export const useAuth = (): AuthContextValue => {
  const contexto = useOptionalAuth();
  if (!contexto) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return contexto;
};

/**
 * Una sola restauración de sesión por carga de página: en desarrollo React
 * monta dos veces los efectos (StrictMode) y el token de refresco es rotativo,
 * así que dos peticiones simultáneas podrían disparar la detección de reuso.
 */
let restauracionEnCurso: Promise<LoginResponse> | null = null;

const restaurarSesion = (): Promise<LoginResponse> => {
  restauracionEnCurso ??= authApi.refresh();
  return restauracionEnCurso;
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const consultas = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('cargando');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const applyLoginResponse = useCallback(
    (response: LoginResponse) => {
      setAccessToken(response.accessToken);
      setUser(response.user);
      setSessionInfo(null);
      setStatus('autenticado');
      setSessionExpired(false);
      /**
       * La identidad del consultorio se pide al montar la aplicación, **antes** de que haya
       * sesión: sin token queda en 401 y, con `retry: false`, nadie la volvía a intentar.
       * El resultado se usaba igual: `titularUsername` en `null` hacía que el titular no
       * fuera reconocido y no viera el bloque del consultorio (y el membrete caía al
       * respaldo del código). Aquí, por donde pasa toda sesión —entrar, recuperarla al
       * recargar y renovarla—, se marca para volver a pedirla.
       */
      void consultas.invalidateQueries({ queryKey: CLINIC_IDENTITY_QUERY_KEY });
      // La configuración de la aplicación (marca y acento, ADR 0060) se pide igual de
      // temprano y con la misma trampa: sin token queda en 401 y nadie la reintenta.
      void consultas.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
    },
    [consultas],
  );

  const clearSession = useCallback((expirada: boolean) => {
    setAccessToken(null);
    setUser(null);
    setSessionInfo(null);
    setStatus('anonimo');
    setSessionExpired(expirada);
  }, []);

  // Si el cliente HTTP no logra renovar la sesión, se cierra aquí.
  useEffect(() => {
    setSessionLostHandler(() => clearSession(true));
    return () => setSessionLostHandler(null);
  }, [clearSession]);

  useEffect(() => {
    let activo = true;

    const arrancar = async () => {
      try {
        const respuesta = await restaurarSesion();
        if (!activo) return;
        applyLoginResponse(respuesta);
        // Los datos del panel inferior son complementarios: si fallan, no se cierra la sesión.
        const info = await authApi.me().catch(() => null);
        if (activo && info) setSessionInfo(info);
      } catch {
        // Sin cookie válida: es una visita nueva, no una sesión caída.
        if (activo) clearSession(false);
      }
    };

    void arrancar();
    return () => {
      activo = false;
    };
  }, [applyLoginResponse, clearSession]);

  const login = useCallback(
    async (input: LoginInput) => {
      const respuesta = await authApi.login(input);
      applyLoginResponse(respuesta);
      const info = await authApi.me().catch(() => null);
      if (info) setSessionInfo(info);
    },
    [applyLoginResponse],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Si el servidor no responde, la sesión local se cierra igual: el usuario
      // pidió salir y no se le puede dejar dentro por un fallo de red.
    } finally {
      clearSession(false);
    }
  }, [clearSession]);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      applyLoginResponse(await authApi.refresh());
      // El token nuevo tiene otra caducidad: se vuelve a pedir el detalle para
      // que el panel inferior no muestre una hora vieja.
      const info = await authApi.me().catch(() => null);
      if (info) setSessionInfo(info);
      return true;
    } catch {
      clearSession(true);
      return false;
    }
  }, [applyLoginResponse, clearSession]);

  // Mientras haya sesión, el detalle se refresca solo: el cliente renueva el
  // token en silencio y, sin esto, la caducidad que enseña el panel quedaría
  // desfasada. Es una consulta cada cinco minutos.
  useEffect(() => {
    if (status !== 'autenticado') return;

    const temporizador = window.setInterval(() => {
      void authApi
        .me()
        .then((info) => setSessionInfo(info))
        .catch(() => undefined);
    }, 5 * 60_000);

    return () => window.clearInterval(temporizador);
  }, [status]);

  const reloadSessionInfo = useCallback(async () => {
    const info = await authApi.me();
    setSessionInfo(info);
  }, []);

  // Los permisos efectivos los manda el servidor; `admin` puede todo igual que
  // en el backend (misma regla que `hasPermission` de los contratos).
  const roles = useMemo<readonly Role[]>(() => (user?.roles ?? []).filter(isRole), [user]);
  const permissions = useMemo<readonly Permission[]>(
    () => (user?.permissions ?? []).filter(isPermission),
    [user],
  );

  const hasPermission = useCallback(
    (permission: Permission): boolean => {
      if (!user) return false;
      return user.roles.includes('admin') || user.permissions.includes(permission);
    },
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      roles,
      permissions,
      mustChangePassword: user?.mustChangePassword ?? false,
      needsProfile: user?.needsProfile ?? false,
      sessionInfo,
      sessionExpired,
      login,
      logout,
      refresh,
      reloadSessionInfo,
      hasPermission,
      applyLoginResponse,
    }),
    [
      status,
      user,
      roles,
      permissions,
      sessionInfo,
      sessionExpired,
      login,
      logout,
      refresh,
      reloadSessionInfo,
      hasPermission,
      applyLoginResponse,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
