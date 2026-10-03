import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/shell/AppShell';
import { MustChangePasswordGate } from './components/shell/MustChangePasswordGate';
import { RequireAuth } from './components/shell/RequireAuth';
import { RequirePermission } from './components/shell/RequirePermission';
import { MODULES } from './lib/nav';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { ModulePlaceholder } from './pages/ModulePlaceholder';
import { NotFoundPage } from './pages/NotFoundPage';
import { PatientDetailPage } from './pages/PatientDetailPage';
import { PatientRegistryPage } from './pages/PatientRegistryPage';
import { PatientsPage } from './pages/PatientsPage';
import { SchedulingPage } from './pages/SchedulingPage';
import { UsersPage } from './pages/UsersPage';

/**
 * Rutas de la SPA.
 *
 * - `/login` vive fuera del shell.
 * - `/cambiar-contrasena` también, y por eso el gate puede empujar ahí sin
 *   ofrecer navegación mientras la contraseña siga siendo temporal.
 * - Todo lo demás pasa por `RequireAuth` → `MustChangePasswordGate` → `AppShell`
 *   y, cuando corresponde, por `RequirePermission`.
 * - Los módulos de fases siguientes ya tienen ruta y permiso: se ven como
 *   placeholder en lugar de dar un 404 al personal.
 */
export const App = () => {
  const modulosFuturos = Object.values(MODULES).filter(
    (modulo) =>
      !['inicio', 'usuarios', 'registro', 'pacientes', 'programacion'].includes(modulo.id),
  );

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/cambiar-contrasena"
        element={
          <RequireAuth>
            <ChangePasswordPage />
          </RequireAuth>
        }
      />

      <Route
        element={
          <RequireAuth>
            <MustChangePasswordGate>
              <AppShell />
            </MustChangePasswordGate>
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/inicio" replace />} />
        <Route path="inicio" element={<HomePage />} />

        <Route
          path="usuarios"
          element={
            <RequirePermission permission="users:manage">
              <UsersPage />
            </RequirePermission>
          }
        />

        {/* Fase 2: el registro se abre a quien puede consultar pacientes (el
            odontólogo entra a ver la ficha en solo lectura); las acciones de
            escritura se comprueban dentro de cada pantalla. */}
        <Route
          path="registro"
          element={
            <RequirePermission permission="patients:read">
              <PatientRegistryPage />
            </RequirePermission>
          }
        />

        <Route
          path="pacientes"
          element={
            <RequirePermission permission="patients:read">
              <PatientsPage />
            </RequirePermission>
          }
        />

        <Route
          path="pacientes/:id"
          element={
            <RequirePermission permission="patients:read">
              <PatientDetailPage />
            </RequirePermission>
          }
        />

        {/* Fase 3: la jornada se abre a quien puede consultar la agenda; las
            acciones (asignar, cupos, notificar, sobrecupo) se comprueban dentro. */}
        <Route
          path="programacion"
          element={
            <RequirePermission permission="scheduling:read">
              <SchedulingPage />
            </RequirePermission>
          }
        />

        {modulosFuturos.map((modulo) => (
          <Route
            key={modulo.id}
            path={modulo.path.replace(/^\//, '')}
            element={
              modulo.permission === null ? (
                <ModulePlaceholder module={modulo.id} />
              ) : (
                <RequirePermission permission={modulo.permission}>
                  <ModulePlaceholder module={modulo.id} />
                </RequirePermission>
              )
            }
          />
        ))}

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
};
