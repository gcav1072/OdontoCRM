import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { z } from 'zod';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { aplicarFuentesDocumento } from './lib/fuentes';
import { queryClient } from './lib/queryClient';
import { AuthProvider } from './providers/AuthProvider';
import { ClinicIdentityProvider } from './providers/ClinicIdentityProvider';
import { RealtimeSyncProvider } from './providers/RealtimeSyncProvider';
import { SettingsProvider } from './providers/SettingsProvider';
import { ThemeProvider, aplicarTemaGuardado } from './providers/ThemeProvider';

import './index.css';

/**
 * Arranque de la SPA: se aplica el tema guardado antes del primer render (para
 * no ver un destello blanco), se ponen los mensajes de Zod en español (los
 * esquemas compartidos con el backend no siempre traen el suyo) y se montan los
 * proveedores: tema, datos del servidor, router y sesión.
 *
 * **Nunca una pantalla en negro**: si el arranque falla (error de módulo, un
 * `import` que revienta, el contenedor que no existe), se pinta un aviso legible
 * con el error y un botón de recarga en lugar de dejar el `#root` vacío. Eso es
 * lo que ocurría cuando el servidor de desarrollo que se estaba mirando no era el
 * que se acababa de arrancar.
 */
z.config(z.locales.es());

const contenedor = document.getElementById('root');

/** Aviso de arranque fallido, sin React: tiene que funcionar justo cuando React no. */
const mostrarFalloDeArranque = (mensaje: string, detalle?: string): void => {
  const contenedorSeguro = contenedor ?? document.body;
  contenedorSeguro.innerHTML = '';

  const caja = document.createElement('div');
  caja.setAttribute('role', 'alert');
  caja.style.cssText =
    'min-height:100dvh;display:grid;place-content:center;gap:0.75rem;padding:2rem;' +
    "background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center";

  const titulo = document.createElement('p');
  titulo.style.cssText = 'margin:0;font-size:1.15rem;font-weight:600';
  titulo.textContent = `OdontoCRM no pudo arrancar: ${mensaje}`;
  caja.append(titulo);

  const ayuda = document.createElement('p');
  ayuda.style.cssText = 'margin:0;font-size:0.9rem;color:#94a3b8;max-width:38rem';
  ayuda.textContent =
    'Suele ser un servidor de desarrollo viejo en el puerto 5173 o la aplicación recién compilada sin recargar. ' +
    'Comprueba los puertos con «npm run dev:check» y vuelve a arrancar con «npm run dev».';
  caja.append(ayuda);

  if (detalle !== undefined && detalle !== '') {
    const codigo = document.createElement('pre');
    codigo.style.cssText =
      'margin:0;max-width:48rem;overflow:auto;padding:0.75rem;border-radius:0.5rem;' +
      'background:#020617;color:#fca5a5;font-size:0.8rem;text-align:left;white-space:pre-wrap';
    codigo.textContent = detalle;
    caja.append(codigo);
  }

  const boton = document.createElement('button');
  boton.type = 'button';
  boton.textContent = 'Recargar la página';
  boton.style.cssText =
    'justify-self:center;padding:0.6rem 1.2rem;border:0;border-radius:0.5rem;cursor:pointer;' +
    'background:#38bdf8;color:#0f172a;font-size:0.95rem;font-weight:600';
  boton.addEventListener('click', () => window.location.reload());
  caja.append(boton);

  contenedorSeguro.append(caja);
};

// Errores previos al montaje (módulos que no cargan, promesas sueltas): se
// muestran en pantalla en vez de quedarse solo en la consola del navegador.
const alFallar = (evento: ErrorEvent): void => {
  mostrarFalloDeArranque('error de carga', evento.message);
};
const alRechazar = (evento: PromiseRejectionEvent): void => {
  const razon = evento.reason as { message?: string } | undefined;
  mostrarFalloDeArranque('error inesperado', razon?.message ?? String(evento.reason));
};
window.addEventListener('error', alFallar);
window.addEventListener('unhandledrejection', alRechazar);

try {
  if (contenedor === null) throw new Error('No se encontró el contenedor #root de index.html');

  // El aviso de reserva desaparece en cuanto React toma el contenedor.
  aplicarTemaGuardado();
  // Las fuentes del consultorio (los mismos .woff2 que el servidor mete en los PDF),
  // antes del primer render para que el membrete impreso ya salga con su tipografía.
  aplicarFuentesDocumento();
  createRoot(contenedor).render(
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <AuthProvider>
                {/* La identidad del consultorio (ADR 0056): la lee una vez y la
                    reparten el membrete y la marca de agua de los imprimibles del
                    navegador. Va dentro de AuthProvider porque solo se pide **con
                    sesión**: sin ella la consulta daría 401 (ver el proveedor). */}
                <ClinicIdentityProvider>
                  {/* La configuración de la aplicación (ADR 0060): aplica el acento y la
                      marca al documento y los reparte por contexto. Dentro de
                      AuthProvider porque solo se pide con sesión. */}
                  <SettingsProvider>
                    {/* Dentro de AuthProvider (necesita saber si hay sesión) y de
                        QueryClientProvider (invalida consultas): es el canal en vivo del
                        personal, y sin sesión no abre nada. */}
                    <RealtimeSyncProvider>
                      <App />
                    </RealtimeSyncProvider>
                  </SettingsProvider>
                </ClinicIdentityProvider>
              </AuthProvider>
            </BrowserRouter>
          </QueryClientProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
} catch (error) {
  mostrarFalloDeArranque(
    'error al montar la interfaz',
    error instanceof Error ? error.message : String(error),
  );
}
