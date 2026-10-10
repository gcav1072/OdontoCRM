import { cn } from '@odontocrm/ui';
import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';

import { STORAGE_KEYS, readFlag, writeFlag } from '../../lib/storage';
import { AppHeader } from './AppHeader';
import { BottomPanel } from './BottomPanel';
import { MobileNav } from './MobileNav';
import { Sidebar } from './Sidebar';

/**
 * Armazón de la aplicación: menú lateral (filtrado por permiso), cabecera con
 * el usuario, área de contenido y **panel inferior ocultable**.
 *
 * El atajo `Ctrl + J` alterna el panel desde cualquier pantalla del shell, y el
 * estado abierto/cerrado se recuerda en `localStorage`.
 *
 * **Al imprimir** (Fase 9: el botón «Imprimir» de `/reportes`) el armazón
 * desaparece —menú, cabecera y panel— para que el papel lleve el documento y no
 * la navegación; los rellenos pensados para el panel fijo se anulan porque en
 * papel no hay nada que tapar. Las vistas de impresión que viven **fuera** del
 * shell (historia, odontograma) no necesitan nada de esto.
 */
export const AppShell = () => {
  const [menuColapsado, setMenuColapsado] = useState(
    () => readFlag(STORAGE_KEYS.menuLateral) ?? false,
  );
  const [panelAbierto, setPanelAbierto] = useState(
    () => readFlag(STORAGE_KEYS.panelInferior) ?? false,
  );
  // Cajón de navegación para móvil: en pantallas pequeñas el raíl lateral desaparece
  // y las secciones se abren aquí, con sus etiquetas completas.
  const [menuMovilAbierto, setMenuMovilAbierto] = useState(false);

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
      <Sidebar
        collapsed={menuColapsado}
        onToggle={() => setMenuColapsado((valor) => !valor)}
        panelAbierto={panelAbierto}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader onOpenMenu={() => setMenuMovilAbierto(true)} />
        {/* El relleno inferior deja sitio al panel fijo: sin él, el final de las
            tablas quedaría tapado cuando el panel está desplegado. En papel no
            hay panel, así que el relleno se anula con `print:pb-0`.

            Es además el **contenedor de consulta** (`@container`) de todas las
            pantallas: los diseños de varias columnas se resuelven contra el ancho
            real de esta columna, no contra el de la ventana. Importa porque el raíl
            lateral le come ~16rem al contenido: con breakpoints de ventana, `lg`
            (1024 px) disparaba cuando a la columna le quedaban ~768 y los
            formularios salían apretados (laptop de 1366 y iPad apaisado). */}
        <main
          className={cn(
            '@container mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-8 print:max-w-none print:px-0 print:py-0',
            panelAbierto ? 'pb-[32rem] sm:pb-[24rem] lg:pb-[20rem]' : 'pb-20',
            'print:pb-0',
          )}
        >
          <Outlet />
        </main>
      </div>

      <div className="print:hidden">
        <MobileNav open={menuMovilAbierto} onClose={() => setMenuMovilAbierto(false)} />
      </div>

      <div className="print:hidden">
        <BottomPanel open={panelAbierto} onToggle={() => setPanelAbierto((valor) => !valor)} />
      </div>
    </div>
  );
};
