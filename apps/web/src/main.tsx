import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { z } from 'zod';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { queryClient } from './lib/queryClient';
import { AuthProvider } from './providers/AuthProvider';
import { ThemeProvider, aplicarTemaGuardado } from './providers/ThemeProvider';

import './index.css';

/**
 * Arranque de la SPA: se aplica el tema guardado antes del primer render (para
 * no ver un destello blanco), se ponen los mensajes de Zod en español (los
 * esquemas compartidos con el backend no siempre traen el suyo) y se montan los
 * proveedores: tema, datos del servidor, router y sesión.
 */
z.config(z.locales.es());

aplicarTemaGuardado();

const contenedor = document.getElementById('root');
if (!contenedor) throw new Error('No se encontró el contenedor #root de index.html');

createRoot(contenedor).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
