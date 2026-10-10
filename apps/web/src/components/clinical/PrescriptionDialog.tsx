import {
  CLINIC,
  MEDICATION_ROUTES,
  clinicIdentityFromView,
  letterheadMissingFields,
  medicationRouteLabel,
  prescriptionStatusLabel,
  type Medication,
  type MedicationRoute,
  type PrescriptionDetail,
  type PrescriptionSummary,
} from '@odontocrm/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input, Select, Spinner, cn } from '@odontocrm/ui';
import { FileDown, Plus, Printer, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useNotice } from '../../hooks/useNotice';
import { apiErrorMessage } from '../../lib/api';
import { clinicalApi } from '../../lib/endpoints';
import { formatDate } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useClinicIdentity } from '../../providers/ClinicIdentityProvider';
import { NoticeBanner } from '../NoticeBanner';

/**
 * El récipe: se prepara, se **emite** y se imprime.
 *
 * Se emite una sola vez (número `RX-000001`, PDF archivado y código de
 * verificación) y a partir de ahí es un documento: lo que se corrige es un récipe
 * nuevo, y el anterior se anula con motivo. El editor avisa si al membrete le falta
 * algún dato **de la identidad guardada** ([ADR 0056](../../../../../docs/adr/0056-la-identidad-del-consultorio-vive-en-la-base.md);
 * el respaldo `CLINIC` solo mientras la base esté vacía) para que nadie imprima un
 * récipe incompleto sin enterarse.
 */

interface ItemDraft {
  medicationId: string | null;
  medicationName: string;
  presentation: string;
  route: MedicationRoute | '';
  dose: string;
  frequency: string;
  duration: string;
  instructions: string;
  quantity: string;
}

const itemVacio = (): ItemDraft => ({
  medicationId: null,
  medicationName: '',
  presentation: '',
  route: '',
  dose: '',
  frequency: '',
  duration: '',
  instructions: '',
  quantity: '',
});

const desdeDetalle = (detalle: PrescriptionDetail): ItemDraft[] =>
  detalle.items.map((item) => ({
    medicationId: item.medicationId,
    medicationName: item.medicationName,
    presentation: item.presentation ?? '',
    route: item.route ?? '',
    dose: item.dose,
    frequency: item.frequency,
    duration: item.duration ?? '',
    instructions: item.instructions ?? '',
    quantity: item.quantity ?? '',
  }));

const aEnviar = (items: readonly ItemDraft[]) =>
  items
    .filter((item) => item.medicationName.trim() !== '')
    .map((item) => ({
      medicationId: item.medicationId,
      medicationName: item.medicationName.trim(),
      presentation: item.presentation.trim() === '' ? null : item.presentation.trim(),
      route: item.route === '' ? null : item.route,
      dose: item.dose.trim(),
      frequency: item.frequency.trim(),
      duration: item.duration.trim() === '' ? null : item.duration.trim(),
      instructions: item.instructions.trim() === '' ? null : item.instructions.trim(),
      quantity: item.quantity.trim() === '' ? null : item.quantity.trim(),
    }));

export interface PrescriptionDialogProps {
  open: boolean;
  sessionId: string;
  patientName: string;
  /** Récipes que ya tiene la sesión (el emitido se muestra, no se reescribe). */
  prescriptions: readonly PrescriptionSummary[];
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export const PrescriptionDialog = ({
  open,
  sessionId,
  patientName,
  prescriptions,
  canWrite,
  onClose,
  onChanged,
}: PrescriptionDialogProps) => {
  const { notice, limpiar, exito, error } = useNotice();
  const identidad = useClinicIdentity();
  const emitido = prescriptions.find((item) => item.status === 'emitida') ?? null;
  const anulado = prescriptions.find((item) => item.status === 'anulada') ?? null;
  const borradorResumen = prescriptions.find((item) => item.status === 'borrador') ?? null;

  const [items, setItems] = useState<ItemDraft[]>([itemVacio()]);
  const [generales, setGenerales] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [anulando, setAnulando] = useState(false);
  const [motivoAnulacion, setMotivoAnulacion] = useState('');
  const diferida = useDebouncedValue(busqueda, 300);

  /**
   * Lo que le falta al membrete **que de verdad se va a imprimir**: la identidad del
   * consultorio guardada en la base (ADR 0056), no el respaldo del código. Mientras la
   * consulta no ha llegado —o no hay proveedor, como en las pruebas— se usa `CLINIC`.
   */
  const clinic = useMemo(
    () => (identidad === null ? CLINIC : clinicIdentityFromView(identidad)),
    [identidad],
  );
  const faltantes = letterheadMissingFields(clinic);

  const borradorQuery = useQuery({
    queryKey: ['clinica', 'recipe-borrador', borradorResumen?.id ?? 'ninguno'],
    queryFn: ({ signal }) => clinicalApi.getPrescription(borradorResumen?.id ?? '', signal),
    enabled: open && borradorResumen !== null,
  });

  // El formulario se llena con el borrador que ya había, cuando llega.
  useEffect(() => {
    if (!open || borradorQuery.data === undefined) return;
    setItems(desdeDetalle(borradorQuery.data));
    setGenerales(borradorQuery.data.generalInstructions ?? '');
  }, [open, borradorQuery.data]);

  const catalogoQuery = useQuery({
    queryKey: ['clinica', 'medicamentos', diferida],
    queryFn: ({ signal }) => clinicalApi.medications(diferida, signal),
    enabled: open,
  });

  const sugerencias: Medication[] = useMemo(
    () => (catalogoQuery.data?.items ?? []).slice(0, 6),
    [catalogoQuery.data],
  );

  const guardar = useMutation({
    mutationFn: () =>
      clinicalApi.savePrescription(sessionId, {
        items: aEnviar(items),
        generalInstructions: generales.trim() === '' ? null : generales.trim(),
      }),
    onSuccess: () => {
      onChanged();
      exito(t('clinica.recipe.exito.guardado'));
    },
    onError: (fallo) => error(apiErrorMessage(fallo)),
  });

  const emitir = useMutation({
    mutationFn: async () => {
      const guardado = await clinicalApi.savePrescription(sessionId, {
        items: aEnviar(items),
        generalInstructions: generales.trim() === '' ? null : generales.trim(),
      });
      return clinicalApi.issuePrescription(guardado.id);
    },
    onSuccess: () => {
      onChanged();
      exito(t('clinica.recipe.exito.emitido'));
    },
    onError: (fallo) => error(apiErrorMessage(fallo)),
  });

  const anular = useMutation({
    mutationFn: (id: string) =>
      clinicalApi.annulPrescription(id, { reason: motivoAnulacion.trim() }),
    onSuccess: () => {
      setAnulando(false);
      setMotivoAnulacion('');
      onChanged();
      exito(t('clinica.recipe.exito.anulado'));
    },
    onError: (fallo) => error(apiErrorMessage(fallo)),
  });

  const descargar = async (id: string): Promise<void> => {
    try {
      const blob = await clinicalApi.downloadPrescriptionPdf(id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      await clinicalApi.registerPrescriptionPrint(id);
      onChanged();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (fallo) {
      error(apiErrorMessage(fallo));
    }
  };

  /**
   * Pone el medicamento del catálogo en la fila que se está escribiendo: la primera
   * vacía si la hay, y si no una nueva. Trae dosis y frecuencia habituales como
   * **sugerencia editable** (el odontólogo las cambia si el paciente lo pide).
   */
  const usarSugerencia = (medicamento: Medication): void => {
    const relleno = (item: ItemDraft): ItemDraft => ({
      medicationId: medicamento.id,
      medicationName: medicamento.name,
      presentation: medicamento.presentations[0] ?? '',
      route: medicamento.routes[0] ?? '',
      dose: medicamento.usualDose ?? '',
      frequency: medicamento.usualFrequency ?? '',
      duration: medicamento.usualDuration ?? '',
      instructions: medicamento.indications ?? '',
      quantity: item.quantity,
    });

    setItems((actual) => {
      const vacia = actual.findIndex((item) => item.medicationName.trim() === '');
      if (vacia === -1) return [...actual, relleno(itemVacio())];
      return actual.map((item, posicion) => (posicion === vacia ? relleno(item) : item));
    });
    setBusqueda('');
  };

  if (!open) return null;

  const puedeEmitir =
    canWrite &&
    emitido === null &&
    items.some(
      (item) =>
        item.medicationName.trim() !== '' &&
        item.dose.trim() !== '' &&
        item.frequency.trim() !== '',
    );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('clinica.recipe.titulo', { paciente: patientName })}
      description={t('clinica.recipe.texto')}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('comun.cerrar')}
          </Button>
          {canWrite && emitido === null && (
            <>
              <Button
                variant="secondary"
                loading={guardar.isPending}
                onClick={() => guardar.mutate()}
              >
                {t('clinica.recipe.guardarBorrador')}
              </Button>
              <Button
                loading={emitir.isPending}
                disabled={!puedeEmitir}
                onClick={() => emitir.mutate()}
              >
                {t('clinica.recipe.emitir')}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <NoticeBanner notice={notice} onClose={limpiar} className="mb-0" />

        {faltantes.length > 0 && (
          <Alert variant="warning" title={t('clinica.recipe.membrete.titulo')}>
            {t('clinica.recipe.membrete.texto', { campos: faltantes.join(', ') })}
          </Alert>
        )}

        {emitido !== null && (
          <Alert variant="success" title={t('clinica.recipe.emitido.titulo')}>
            <p>
              {t('clinica.recipe.emitido.texto', {
                numero: emitido.number ?? '',
                fecha: formatDate(emitido.issuedAt),
              })}
            </p>
            <p className="mt-1 text-sm">
              {t('clinica.recipe.emitido.codigo', { codigo: emitido.verifyCode ?? '' })} ·{' '}
              {prescriptionStatusLabel(emitido.status)}
              {emitido.printCount > 0
                ? ` · ${t('clinica.recipe.emitido.impresiones', { veces: emitido.printCount })}`
                : ''}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<FileDown className="size-4" aria-hidden />}
                onClick={() => void descargar(emitido.id)}
              >
                {t('clinica.recipe.descargar')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<Printer className="size-4" aria-hidden />}
                onClick={() => void descargar(emitido.id)}
              >
                {t('clinica.recipe.imprimir')}
              </Button>
              {canWrite && (
                <Button variant="ghost" size="sm" onClick={() => setAnulando(true)}>
                  {t('clinica.recipe.anular')}
                </Button>
              )}
            </div>
          </Alert>
        )}

        {anulado !== null && emitido === null && (
          <Alert variant="info" title={t('clinica.recipe.anulado.titulo')}>
            {t('clinica.recipe.anulado.texto', {
              numero: anulado.number ?? '',
              motivo: anulado.annulReason ?? '',
            })}
          </Alert>
        )}

        {anulando && emitido !== null && (
          <div className="rounded-control border border-danger/40 bg-danger/5 p-3">
            <Field label={t('clinica.recipe.motivoAnulacion')} required>
              <Input
                value={motivoAnulacion}
                onChange={(evento) => setMotivoAnulacion(evento.target.value)}
              />
            </Field>
            <div className="mt-2 flex gap-2">
              <Button
                variant="danger"
                size="sm"
                loading={anular.isPending}
                disabled={motivoAnulacion.trim().length < 3}
                onClick={() => anular.mutate(emitido.id)}
              >
                {t('clinica.recipe.confirmarAnulacion')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAnulando(false)}>
                {t('comun.cancelar')}
              </Button>
            </div>
          </div>
        )}

        {emitido === null && (
          <>
            <div className="rounded-control border border-border p-3">
              <Field label={t('clinica.recipe.buscar')} hint={t('clinica.recipe.buscarAyuda')}>
                <Input
                  value={busqueda}
                  placeholder={t('clinica.recipe.buscarPlaceholder')}
                  onChange={(evento) => setBusqueda(evento.target.value)}
                />
              </Field>
              {catalogoQuery.isLoading && <Spinner showLabel label={t('comun.cargando')} />}
              {sugerencias.length > 0 && busqueda.trim() !== '' && (
                <ul className="mt-2 divide-y divide-border rounded-control border border-border">
                  {sugerencias.map((medicamento) => (
                    <li key={medicamento.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-surface-muted"
                        onClick={() => usarSugerencia(medicamento)}
                      >
                        <span className="font-medium text-ink">{medicamento.name}</span>
                        <span className="block text-xs text-ink-subtle">
                          {medicamento.presentations.join(' · ')}
                          {medicamento.indications === null ? '' : ` — ${medicamento.indications}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <ul className="space-y-3">
              {items.map((item, indice) => (
                <li
                  key={`item-${String(indice)}`}
                  className="rounded-control border border-border p-3"
                >
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label={t('clinica.recipe.medicamento')}>
                      <Input
                        value={item.medicationName}
                        onChange={(evento) =>
                          setItems((actual) =>
                            actual.map((fila, posicion) =>
                              posicion === indice
                                ? {
                                    ...fila,
                                    medicationName: evento.target.value,
                                    medicationId: null,
                                  }
                                : fila,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label={t('clinica.recipe.presentacion')}>
                      <Input
                        value={item.presentation}
                        onChange={(evento) =>
                          setItems((actual) =>
                            actual.map((fila, posicion) =>
                              posicion === indice
                                ? { ...fila, presentation: evento.target.value }
                                : fila,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label={t('clinica.recipe.via')}>
                      <Select
                        value={item.route}
                        onChange={(evento) =>
                          setItems((actual) =>
                            actual.map((fila, posicion) =>
                              posicion === indice
                                ? { ...fila, route: evento.target.value as MedicationRoute | '' }
                                : fila,
                            ),
                          )
                        }
                      >
                        <option value="">{t('clinica.recipe.sinVia')}</option>
                        {MEDICATION_ROUTES.map((route) => (
                          <option key={route} value={route}>
                            {medicationRouteLabel(route) ?? route}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t('clinica.recipe.cantidad')}>
                      <Input
                        value={item.quantity}
                        onChange={(evento) =>
                          setItems((actual) =>
                            actual.map((fila, posicion) =>
                              posicion === indice
                                ? { ...fila, quantity: evento.target.value }
                                : fila,
                            ),
                          )
                        }
                      />
                    </Field>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label={t('clinica.recipe.dosis')} required>
                      <Input
                        value={item.dose}
                        placeholder="500 mg"
                        onChange={(evento) =>
                          setItems((actual) =>
                            actual.map((fila, posicion) =>
                              posicion === indice ? { ...fila, dose: evento.target.value } : fila,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label={t('clinica.recipe.frecuencia')} required>
                      <Input
                        value={item.frequency}
                        placeholder="cada 8 horas"
                        onChange={(evento) =>
                          setItems((actual) =>
                            actual.map((fila, posicion) =>
                              posicion === indice
                                ? { ...fila, frequency: evento.target.value }
                                : fila,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label={t('clinica.recipe.duracion')}>
                      <Input
                        value={item.duration}
                        placeholder="7 días"
                        onChange={(evento) =>
                          setItems((actual) =>
                            actual.map((fila, posicion) =>
                              posicion === indice
                                ? { ...fila, duration: evento.target.value }
                                : fila,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label={t('clinica.recipe.indicaciones')}>
                      <Input
                        value={item.instructions}
                        onChange={(evento) =>
                          setItems((actual) =>
                            actual.map((fila, posicion) =>
                              posicion === indice
                                ? { ...fila, instructions: evento.target.value }
                                : fila,
                            ),
                          )
                        }
                      />
                    </Field>
                  </div>

                  <div className="mt-2 flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger"
                      disabled={items.length === 1}
                      leadingIcon={<Trash2 className="size-4" aria-hidden />}
                      onClick={() =>
                        setItems((actual) => actual.filter((_, posicion) => posicion !== indice))
                      }
                    >
                      {t('clinica.recipe.quitar')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>

            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<Plus className="size-4" aria-hidden />}
              onClick={() => setItems((actual) => [...actual, itemVacio()])}
            >
              {t('clinica.recipe.agregar')}
            </Button>

            <Field label={t('clinica.recipe.generales')} hint={t('clinica.recipe.generalesAyuda')}>
              <textarea
                className={cn(
                  'w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink',
                  'shadow-xs transition-colors placeholder:text-ink-subtle focus-visible:outline-2',
                  'focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus',
                )}
                rows={3}
                value={generales}
                onChange={(evento) => setGenerales(evento.target.value)}
              />
            </Field>
          </>
        )}

        {emitido !== null && (
          <p className="text-xs text-ink-subtle">{t('clinica.recipe.reimpresion')}</p>
        )}
      </div>
    </Dialog>
  );
};
