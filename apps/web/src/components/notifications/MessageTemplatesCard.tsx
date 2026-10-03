import {
  DEFAULT_MESSAGE_TEMPLATES,
  messageTemplateInputSchema,
  type MessageTemplate,
} from '@odontocrm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  EmptyState,
  Field,
  Spinner,
} from '@odontocrm/ui';
import { FileText, RotateCcw, Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { apiErrorMessage, isApiError } from '../../lib/api';
import { notificationsApi, type MessageTemplateList } from '../../lib/endpoints';
import { t, templateName } from '../../lib/i18n';
import { notificationKeys, templatePreview } from '../../lib/notifications';
import { TemplateResetDialog } from './TemplateResetDialog';

export interface MessageTemplatesCardProps {
  /** `scheduling:notify`: sin él la sección se ve, pero no se edita. */
  canNotify: boolean;
  onSaved: (mensaje: string) => void;
  onError: (mensaje: string) => void;
}

/** ¿El texto guardado difiere del que trae el sistema de fábrica? */
const estaModificada = (plantilla: MessageTemplate): boolean => {
  const original = DEFAULT_MESSAGE_TEMPLATES.find((defecto) => defecto.key === plantilla.key);
  if (original === undefined) return false;
  return original.body !== plantilla.body || (original.subject ?? null) !== plantilla.subject;
};

/** Valores del formulario del editor. */
interface Borrador {
  subject: string;
  body: string;
}

const borradorDe = (plantilla: MessageTemplate): Borrador => ({
  subject: plantilla.subject ?? '',
  body: plantilla.body,
});

const LARGO_MAXIMO = 2000;

/**
 * Plantillas editables del bot (Fase 4).
 *
 * A la izquierda la lista con las modificadas marcadas; a la derecha el editor:
 * asunto (solo en las plantillas de avisos), texto, los marcadores que admite
 * —se insertan donde esté el cursor—, la vista previa con datos de ejemplo y los
 * botones de guardar y restaurar. Los textos viajan tal cual por Telegram: no hay
 * HTML.
 */
export const MessageTemplatesCard = ({
  canNotify,
  onSaved,
  onError,
}: MessageTemplatesCardProps) => {
  const cliente = useQueryClient();
  const [claveElegida, setClaveElegida] = useState<string | null>(null);
  const [borrador, setBorrador] = useState<Borrador | null>(null);
  const [errorCampo, setErrorCampo] = useState<string | null>(null);
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [restaurando, setRestaurando] = useState<MessageTemplate | null>(null);
  const cuerpoRef = useRef<HTMLTextAreaElement | null>(null);

  const plantillasQuery = useQuery({
    queryKey: notificationKeys.templates,
    queryFn: ({ signal }) => notificationsApi.templates(signal),
    staleTime: 60_000,
  });

  const plantillas = useMemo(
    () => [...(plantillasQuery.data?.items ?? [])].sort((a, b) => a.key.localeCompare(b.key)),
    [plantillasQuery.data],
  );

  const elegida = plantillas.find((plantilla) => plantilla.key === claveElegida) ?? null;
  const cuerpoGuardado = elegida?.body ?? null;
  const asuntoGuardado = elegida?.subject ?? null;
  const actualizadaEn = elegida?.updatedAt ?? null;

  // El borrador arranca del texto guardado cuando cambia la plantilla elegida o
  // cuando el texto guardado cambia (guardar o restaurar); así no se pisa lo que
  // se está escribiendo en cada dibujado.
  useEffect(() => {
    setBorrador(
      cuerpoGuardado === null ? null : { body: cuerpoGuardado, subject: asuntoGuardado ?? '' },
    );
    setErrorCampo(null);
    setErrorGeneral(null);
  }, [claveElegida, cuerpoGuardado, asuntoGuardado, actualizadaEn]);

  const defecto = DEFAULT_MESSAGE_TEMPLATES.find((valor) => valor.key === elegida?.key) ?? null;
  const marcadores = defecto?.placeholders ?? [];
  const admiteAsunto = defecto !== null && defecto.subject !== null;

  const sinCambios =
    elegida === null ||
    borrador === null ||
    (borrador.body === elegida.body && borrador.subject === (elegida.subject ?? ''));

  const guardar = useMutation({
    mutationFn: (input: { key: string; subject: string | null; body: string }) =>
      notificationsApi.updateTemplate(input.key, { subject: input.subject, body: input.body }),
    onSuccess: (guardada) => {
      cliente.setQueryData<MessageTemplateList>(notificationKeys.templates, (actual) =>
        actual === undefined
          ? actual
          : {
              ...actual,
              items: actual.items.map((plantilla) =>
                plantilla.key === guardada.key ? guardada : plantilla,
              ),
            },
      );
    },
  });

  const restaurar = useMutation({
    mutationFn: (key: string) => notificationsApi.resetTemplate(key),
    onSuccess: (restaurada) => {
      setRestaurando(null);
      cliente.setQueryData<MessageTemplateList>(notificationKeys.templates, (actual) =>
        actual === undefined
          ? actual
          : {
              ...actual,
              items: actual.items.map((plantilla) =>
                plantilla.key === restaurada.key ? restaurada : plantilla,
              ),
            },
      );
      setBorrador(borradorDe(restaurada));
      onSaved(t('notificaciones.plantillas.restaurada'));
    },
    onError: (fallo) => {
      setRestaurando(null);
      onError(apiErrorMessage(fallo));
    },
  });

  const insertarMarcador = (marcador: string) => {
    const area = cuerpoRef.current;
    const texto = `{${marcador}}`;
    if (area === null || borrador === null) return;

    const inicio = area.selectionStart;
    const fin = area.selectionEnd;
    const cuerpo = borrador.body.slice(0, inicio) + texto + borrador.body.slice(fin);
    setBorrador({ ...borrador, body: cuerpo });

    // Se devuelve el foco al textarea con el cursor detrás del marcador.
    window.requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(inicio + texto.length, inicio + texto.length);
    });
  };

  const enviar = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (elegida === null || borrador === null) return;

    setErrorCampo(null);
    setErrorGeneral(null);

    const analizado = messageTemplateInputSchema.safeParse({
      subject: admiteAsunto ? borrador.subject.trim() : null,
      body: borrador.body.trim(),
    });
    if (!analizado.success) {
      setErrorCampo(
        analizado.error.issues[0]?.message ?? t('notificaciones.plantillas.cuerpoVacio'),
      );
      return;
    }

    try {
      const guardada = await guardar.mutateAsync({
        key: elegida.key,
        subject: analizado.data.subject ?? null,
        body: analizado.data.body,
      });
      setBorrador(borradorDe(guardada));
      onSaved(t('notificaciones.plantillas.guardada'));
    } catch (fallo) {
      if (isApiError(fallo)) {
        const porCampo = fallo.fieldErrors['body'] ?? fallo.fieldErrors['subject'];
        if (porCampo !== undefined) {
          setErrorCampo(porCampo);
          return;
        }
      }
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <FileText className="size-4 text-primary" aria-hidden="true" />
          {t('notificaciones.plantillas.titulo')}
        </CardTitle>
        <p className="text-sm text-ink-muted">{t('notificaciones.plantillas.descripcion')}</p>
      </CardHeader>

      <CardContent>
        {plantillasQuery.isError && (
          <Alert variant="danger" title={t('notificaciones.plantillas.error')}>
            {apiErrorMessage(plantillasQuery.error)}
          </Alert>
        )}

        {plantillasQuery.isPending ? (
          <Spinner label={t('notificaciones.plantillas.cargando')} showLabel />
        ) : plantillas.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-6" aria-hidden="true" />}
            title={t('notificaciones.plantillas.titulo')}
            description={t('notificaciones.plantillas.vacio')}
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]">
            <div className="flex flex-col gap-2">
              <p className="text-xs text-ink-subtle">
                {t('notificaciones.plantillas.total', { total: plantillas.length })}
              </p>
              <ul className="flex max-h-[32rem] flex-col gap-1.5 overflow-y-auto pr-1">
                {plantillas.map((plantilla) => {
                  const activa = plantilla.key === claveElegida;
                  return (
                    <li key={plantilla.key}>
                      <button
                        type="button"
                        aria-pressed={activa}
                        onClick={() => setClaveElegida(plantilla.key)}
                        className={cn(
                          'w-full rounded-control border px-3 py-2 text-left transition-colors',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus',
                          activa
                            ? 'border-primary bg-primary/5'
                            : 'border-border bg-surface hover:bg-surface-muted',
                        )}
                      >
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium text-ink">
                            {templateName(plantilla.key)}
                          </span>
                          {estaModificada(plantilla) && (
                            <Badge variant="info">
                              {t('notificaciones.plantillas.modificada')}
                            </Badge>
                          )}
                          {!plantilla.isActive && (
                            <Badge variant="neutral">
                              {t('notificaciones.plantillas.inactiva')}
                            </Badge>
                          )}
                        </span>
                        <span className="mt-1 block truncate font-mono text-xs text-ink-subtle">
                          {plantilla.key}
                        </span>
                        <span className="mt-1 line-clamp-2 block text-xs text-ink-muted">
                          {plantilla.body}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            {elegida === null || borrador === null ? (
              <div className="grid place-items-center rounded-control border border-dashed border-border-strong/70 px-6 py-12">
                <p className="text-sm text-ink-muted">
                  {t('notificaciones.plantillas.sinSeleccion')}
                </p>
              </div>
            ) : (
              <form className="space-y-4" onSubmit={(event) => void enviar(event)}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink">
                    {t('notificaciones.plantillas.editor', { clave: templateName(elegida.key) })}
                  </h3>
                  {estaModificada(elegida) ? (
                    <Badge variant="info">{t('notificaciones.plantillas.modificada')}</Badge>
                  ) : (
                    <Badge variant="neutral">{t('notificaciones.plantillas.original')}</Badge>
                  )}
                  {!sinCambios && (
                    <Badge variant="warning">{t('notificaciones.plantillas.sinGuardar')}</Badge>
                  )}
                </div>

                <Alert variant="info">{t('notificaciones.plantillas.avisoHtml')}</Alert>

                {admiteAsunto ? (
                  <Field
                    label={t('notificaciones.plantillas.asunto')}
                    hint={t('notificaciones.plantillas.asuntoAyuda')}
                  >
                    <input
                      type="text"
                      value={borrador.subject}
                      maxLength={160}
                      readOnly={!canNotify}
                      onChange={(event) =>
                        setBorrador({ ...borrador, subject: event.target.value })
                      }
                      className="h-10 w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-ink transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus read-only:bg-surface-muted"
                    />
                  </Field>
                ) : (
                  <p className="text-xs text-ink-subtle">
                    {t('notificaciones.plantillas.asuntoNoAplica')}
                  </p>
                )}

                <div className="space-y-1.5">
                  <label htmlFor="plantilla-cuerpo" className="text-sm font-medium text-ink">
                    {t('notificaciones.plantillas.cuerpo')}
                  </label>
                  <textarea
                    id="plantilla-cuerpo"
                    ref={cuerpoRef}
                    rows={10}
                    maxLength={LARGO_MAXIMO}
                    value={borrador.body}
                    readOnly={!canNotify}
                    aria-invalid={errorCampo !== null || undefined}
                    onChange={(event) => setBorrador({ ...borrador, body: event.target.value })}
                    className={cn(
                      'w-full rounded-control border bg-surface px-3 py-2 font-mono text-sm text-ink transition-colors',
                      'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus',
                      'read-only:bg-surface-muted',
                      errorCampo === null ? 'border-border-strong' : 'border-danger',
                    )}
                  />
                  <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-subtle">
                    <span>{t('notificaciones.plantillas.cuerpoAyuda', { max: LARGO_MAXIMO })}</span>
                    <span className="tabular-nums">
                      {borrador.body.length}/{LARGO_MAXIMO}
                    </span>
                  </p>
                  {errorCampo !== null && (
                    <p role="alert" className="text-xs font-medium text-danger">
                      {errorCampo}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium text-ink">
                    {t('notificaciones.plantillas.marcadores')}
                  </p>
                  {marcadores.length === 0 ? (
                    <p className="text-xs text-ink-subtle">
                      {t('notificaciones.plantillas.sinMarcadores')}
                    </p>
                  ) : (
                    <>
                      <p className="text-xs text-ink-subtle">
                        {t('notificaciones.plantillas.marcadoresAyuda')}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {marcadores.map((marcador) => (
                          <button
                            key={marcador}
                            type="button"
                            disabled={!canNotify}
                            aria-label={t('notificaciones.plantillas.insertar', { marcador })}
                            onClick={() => insertarMarcador(marcador)}
                            className={cn(
                              'rounded-full border border-border-strong bg-surface-muted px-2.5 py-1 font-mono text-xs text-ink-muted transition-colors',
                              'hover:border-primary hover:text-primary',
                              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus',
                              'disabled:cursor-not-allowed disabled:opacity-55',
                            )}
                          >
                            {`{${marcador}}`}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <div className="space-y-2">
                  <p className="text-sm font-medium text-ink">
                    {t('notificaciones.plantillas.vista')}
                  </p>
                  <p className="text-xs text-ink-subtle">
                    {t('notificaciones.plantillas.vistaAyuda')}
                  </p>
                  <div className="rounded-control border border-border bg-surface-muted px-3.5 py-3">
                    <p className="pb-1.5 text-xs font-medium tracking-wide text-ink-subtle uppercase">
                      {t('notificaciones.plantillas.vistaSistema')}
                    </p>
                    <p className="text-sm whitespace-pre-wrap text-ink">
                      {templatePreview(borrador.body)}
                    </p>
                  </div>
                </div>

                {errorGeneral !== null && <Alert variant="danger">{errorGeneral}</Alert>}

                {!canNotify && <Alert variant="info">{t('notificaciones.soloLectura')}</Alert>}

                {canNotify && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="submit"
                      loading={guardar.isPending}
                      loadingLabel={t('notificaciones.plantillas.guardando')}
                      disabled={sinCambios}
                      leadingIcon={<Save className="size-4" aria-hidden="true" />}
                    >
                      {t('notificaciones.plantillas.guardar')}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      leadingIcon={<RotateCcw className="size-4" aria-hidden="true" />}
                      onClick={() => setRestaurando(elegida)}
                    >
                      {t('notificaciones.plantillas.restaurar')}
                    </Button>
                  </div>
                )}
              </form>
            )}
          </div>
        )}
      </CardContent>

      {restaurando !== null && (
        <TemplateResetDialog
          template={restaurando}
          loading={restaurar.isPending}
          onClose={() => setRestaurando(null)}
          onConfirm={() => restaurar.mutate(restaurando.key)}
        />
      )}
    </Card>
  );
};
