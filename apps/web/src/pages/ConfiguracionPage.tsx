import {
  DEFAULT_UI_ACCENT,
  type AppSettingsView,
  type ScreenTexts,
  type UIAccentId,
} from '@odontocrm/contracts';
import { Alert, Card, CardContent, CardHeader, CardTitle, Spinner } from '@odontocrm/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AcentoSection } from '../components/config/AcentoSection';
import { CanalesSection } from '../components/config/CanalesSection';
import { MarcaSection } from '../components/config/MarcaSection';
import { PantallasSection } from '../components/config/PantallasSection';
import { NoticeBanner } from '../components/NoticeBanner';
import { CancellationPolicyCard } from '../components/notifications/CancellationPolicyCard';
import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import { settingsApi } from '../lib/endpoints';
import { t } from '../lib/i18n';
import { APP_SETTINGS_QUERY_KEY } from '../lib/queryKeys';

/**
 * `/configuracion` (ADR 0060): el panel desde el que el **administrador** ajusta toda la
 * clínica —la marca de los imprimibles, el color de la interfaz, los textos de las
 * pantallas, los sillones y los canales— y, de paso, la política de cancelación del
 * paciente (que antes vivía en `/notificaciones`).
 *
 * El acceso lo corta la ruta (`RequirePermission permission="settings:manage"`) y la API
 * lo vuelve a comprobar: esta pantalla no se ve sin el permiso, pero tampoco se podría
 * guardar saltándosela.
 */
export const ConfiguracionPage = () => {
  const { notice, mostrar, exito, limpiar } = useNotice();
  const consultas = useQueryClient();

  const avisar = (variant: 'success' | 'danger', message: string): void =>
    mostrar({ variant, message });

  const vistaQuery = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: ({ signal }) => settingsApi.get(signal),
  });

  const vista: AppSettingsView | undefined = vistaQuery.data;

  /** Estado del acento y los textos: los dos viajan en el MISMO `PUT /settings/app`. */
  const [acento, setAcento] = useState<UIAccentId | null>(null);
  const [textos, setTextos] = useState<ScreenTexts>({});

  useEffect(() => {
    if (vista === undefined) return;
    setAcento(vista.accent);
    setTextos(vista.screenTexts);
  }, [vista]);

  const guardarApp = useMutation({
    mutationFn: () => settingsApi.updateApp({ accent: acento, screenTexts: textos }),
    onSuccess: () => {
      void consultas.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
      exito(t('config.guardado'));
    },
    onError: (fallo) => mostrar({ variant: 'danger', message: apiErrorMessage(fallo) }),
  });

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="flex items-center gap-2">
            <Settings2 className="size-4 text-primary" aria-hidden="true" />
            {t('config.titulo')}
          </CardTitle>
          <p className="pt-1 text-sm text-ink-muted">{t('config.descripcion')}</p>
        </CardHeader>
        <CardContent>
          <Alert variant={vista?.brandFromDatabase === true ? 'info' : 'warning'}>
            {vista?.brandFromDatabase === true ? t('config.desdeBase') : t('config.desdeCodigo')}
          </Alert>
        </CardContent>
      </Card>

      {vistaQuery.isError ? (
        <Alert variant="danger" title={t('config.error')}>
          {apiErrorMessage(vistaQuery.error)}
        </Alert>
      ) : vistaQuery.isPending || vista === undefined ? (
        <div className="py-10">
          <Spinner label={t('comun.cargando')} showLabel />
        </div>
      ) : (
        <>
          <MarcaSection vista={vista} onNotice={avisar} />
          <AcentoSection
            acento={acento ?? DEFAULT_UI_ACCENT}
            onAcento={setAcento}
            guardando={guardarApp.isPending}
            onGuardar={() => guardarApp.mutate()}
          />
          <PantallasSection
            textos={textos}
            onTextos={setTextos}
            guardando={guardarApp.isPending}
            onGuardar={() => guardarApp.mutate()}
            onNotice={avisar}
          />
          <CanalesSection vista={vista} onNotice={avisar} />
          <CancellationPolicyCard onNotice={(variant, message) => mostrar({ variant, message })} />
        </>
      )}
    </div>
  );
};
