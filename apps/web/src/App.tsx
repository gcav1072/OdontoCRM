import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/shell/AppShell';
import { MustChangePasswordGate } from './components/shell/MustChangePasswordGate';
import { RequireAuth } from './components/shell/RequireAuth';
import { RequirePermission } from './components/shell/RequirePermission';
import { MODULES } from './lib/nav';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { ConsultorioPage } from './pages/ConsultorioPage';
import { FlujoPage } from './pages/FlujoPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { MedicalRecordPrintPage } from './pages/MedicalRecordPrintPage';
import { ModulePlaceholder } from './pages/ModulePlaceholder';
import { NotFoundPage } from './pages/NotFoundPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OdontogramHistoryPage } from './pages/OdontogramHistoryPage';
import { OdontogramPrintPage } from './pages/OdontogramPrintPage';
import { PatientDetailPage } from './pages/PatientDetailPage';
import { PatientRegistryPage } from './pages/PatientRegistryPage';
import { PatientsPage } from './pages/PatientsPage';
import { ReportesPage } from './pages/ReportesPage';
import { AuditoriaPage } from './pages/AuditoriaPage';
import { SchedulingPage } from './pages/SchedulingPage';
import { ScreensPage } from './pages/ScreensPage';
import { ScreenConsultorioPage } from './pages/ScreenConsultorioPage';
import { ScreenLobbyPage } from './pages/ScreenLobbyPage';
import { SecretariaPage } from './pages/SecretariaPage';
import { UsersPage } from './pages/UsersPage';
import { VerifyPrescriptionPage } from './pages/VerifyPrescriptionPage';

/**
 * Rutas de la SPA.
 *
 * - `/login` vive fuera del shell.
 * - `/cambiar-contrasena` también, y por eso el gate puede empujar ahí sin
 *   ofrecer navegación mientras la contraseña siga siendo temporal.
 * - `/pantalla/lobby` y `/pantalla/consultorio` son **kiosko**: sin shell, sin
 *   sesión de usuario, con el token de dispositivo de la pantalla.
 * - Todo lo demás pasa por `RequireAuth` → `MustChangePasswordGate` → `AppShell`
 *   y, cuando corresponde, por `RequirePermission`.
 * - Los módulos de fases siguientes ya tienen ruta y permiso: se ven como
 *   placeholder en lugar de dar un 404 al personal.
 */
export const App = () => {
  const modulosFuturos = Object.values(MODULES).filter(
    (modulo) =>
      ![
        'inicio',
        'usuarios',
        'registro',
        'pacientes',
        'programacion',
        'notificaciones',
        'secretaria',
        'pantallas',
        'consultorio',
        'flujo',
        'reportes',
        'auditoria',
      ].includes(modulo.id),
  );

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* El QR del récipe lo abre cualquiera con el papel en la mano (el paciente,
          una farmacia): fuera del shell y sin sesión. Lo que muestra no lleva datos
          clínicos (ADR 0015). */}
      <Route path="/verificar/:code" element={<VerifyPrescriptionPage />} />

      {/* Kiosko: la pantalla se configura con su token y no usa la sesión del
          personal. Se monta fuera del shell para que no haya navegación. */}
      <Route path="/pantalla/lobby" element={<ScreenLobbyPage />} />
      <Route path="/pantalla/consultorio" element={<ScreenConsultorioPage />} />

      <Route
        path="/cambiar-contrasena"
        element={
          <RequireAuth>
            <ChangePasswordPage />
          </RequireAuth>
        }
      />

      {/* Vista de impresión de la historia clínica: fuera del shell para que el
          papel no lleve navegación. La secretaría entra con `clinical:read`. */}
      <Route
        path="/consultorio/:id/imprimir"
        element={
          <RequireAuth>
            <RequirePermission permission="clinical:read">
              <MedicalRecordPrintPage />
            </RequirePermission>
          </RequireAuth>
        }
      />

      {/* Fase 6B: la impresión del odontograma también sale del shell y la
          comparte la secretaría (`odontogram:read`, decisión 23: imprimir es
          leer; `odontogram:write` sigue siendo del odontólogo y del admin). */}
      <Route
        path="/consultorio/:patientId/odontograma/imprimir"
        element={
          <RequireAuth>
            <RequirePermission permission="odontogram:read">
              <OdontogramPrintPage />
            </RequirePermission>
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

        {/* Fase 4: la bandeja del bot se abre a quien puede consultar la agenda;
            reintentar, marcar contacto, plantillas y canales exigen
            `scheduling:notify` y se comprueban dentro de la pantalla. */}
        <Route
          path="notificaciones"
          element={
            <RequirePermission permission="scheduling:read">
              <NotificationsPage />
            </RequirePermission>
          }
        />

        {/* Fase 5: la secretaría se abre a quien puede consultar la agenda; las
            acciones del flujo exigen `scheduling:write` y se comprueban dentro. */}
        <Route
          path="secretaria"
          element={
            <RequirePermission permission="scheduling:read">
              <SecretariaPage />
            </RequirePermission>
          }
        />

        {/* Fase 5: administración de las pantallas kiosko. */}
        <Route
          path="pantallas"
          element={
            <RequirePermission permission="screens:manage">
              <ScreensPage />
            </RequirePermission>
          }
        />

        {/* Fase 6: historia clínica. Se entra con `clinical:read`; escribir
            (guardar, firmar, adendas y consentimiento) exige `clinical:write` y
            se comprueba dentro de la pantalla. */}
        <Route
          path="consultorio"
          element={
            <RequirePermission permission="clinical:read">
              <ConsultorioPage />
            </RequirePermission>
          }
        />

        {/* Fase 8: el día completo en una sola pantalla. Se entra con
            `clinical:read` (el centro es el expediente); las acciones de la barra
            superior —agenda y escritura clínica— se comprueban dentro. */}
        <Route
          path="flujo"
          element={
            <RequirePermission permission="clinical:read">
              <FlujoPage />
            </RequirePermission>
          }
        />

        {/* Fase 6B: evolución del odontograma del paciente (histórico
            append-only). Se entra con `odontogram:read`. */}
        <Route
          path="consultorio/:patientId/odontograma/historial"
          element={
            <RequirePermission permission="odontogram:read">
              <OdontogramHistoryPage />
            </RequirePermission>
          }
        />

        {/* Fase 9: reportes y KPIs. Se entra con `reports:read` (los reportes
            operativos) y los clínicos —perfil clínico, salud bucal y recetas—
            se comprueban dentro con `reports:clinical` (ADR 0039). */}
        <Route
          path="reportes"
          element={
            <RequirePermission permission="reports:read">
              <ReportesPage />
            </RequirePermission>
          }
        />

        {/* Fase 9: auditoría. Solo `admin` tiene `audit:read`; el diff
            antes/después y el motivo se ven en la propia lista. */}
        <Route
          path="auditoria"
          element={
            <RequirePermission permission="audit:read">
              <AuditoriaPage />
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
