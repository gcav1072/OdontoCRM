import { cn } from '@odontocrm/ui';
import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';

import { STORAGE_KEYS, readFlag, writeFlag } from '../../lib/storage';
import { AppHeader } from './AppHeader';
import { BottomPanel } from './BottomPanel';
import { Sidebar } from './Sidebar';

/**
 * Armazón de la aplicación: menú lateral (filtrado por permiso), cabecera con
 * el usuario, área de contenido y **panel inferior ocultable**.
 *
 * El atajo `Ctrl + J` alterna el panel desde cualquier pantalla del shell, y el
 * estado abierto/cerrado se recuerda en `localStorage`.
 */
export const AppShell = () => {
  const [menuColapsado, setMenuColapsado] = useState(
    () => readFlag(STORAGE_KEYS.menuLateral) ?? false,
  );
  const [panelAbierto, setPanelAbierto] = useState(
    () => readFlag(STORAGE_KEYS.panelInferior) ?? false,
  );

  useEffect(() => {
    writeFlag(STORAGE_KEYS.menuLateral, menuColapsado);
  }, [menuColapsado]);

  useEffect(() => {
    writeFlag(STORAGE_KEYS.panelInferior, panelAbierto);
  }, [panelAbierto]);

  useEffect(() => {
    const alPulsar = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setPanelAbierto((abierto) => !abierto);
      }
    };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, []);

  return (
    <div className="flex min-h-dvh bg-canvas text-ink">
      <Sidebar collapsed={menuColapsado} onToggle={() => setMenuColapsado((valor) => !valor)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader />
        {/* El relleno inferior deja sitio al panel fijo: sin él, el final de las
            tablas quedaría tapado cuando el panel está desplegado. */}
        <main
          className={cn(
            'mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-8',
            panelAbierto ? 'pb-[32rem] sm:pb-[24rem] lg:pb-[20rem]' : 'pb-20',
          )}
        >
          <Outlet />
        </main>
      </div>

      <BottomPanel open={panelAbierto} onToggle={() => setPanelAbierto((valor) => !valor)} />
    </div>
  );
};
