import {
  CHANNELS,
  createRequestSchema,
  type Channel,
  type PatientSummary,
  type RequestSummary,
} from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Dialog, Field, Input, Select, Spinner, cn } from '@odontocrm/ui';
import { IdCard, Search, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import type { z } from 'zod';

import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { apiErrorMessage } from '../../lib/api';
import { patientsApi, requestsApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { CHANNEL_LABELS, t } from '../../lib/i18n';

type ValoresSolicitud = z.input<typeof createRequestSchema>;
type SolicitudEnviada = z.output<typeof createRequestSchema>;

export interface NewRequestDialogProps {
  onClose: () => void;
  onCreated: (request: RequestSummary) => void;
}

/**
 * Alta de una solicitud (ticket). El paciente se elige de la ficha viva de
 * pacientes: `list` para buscar por nombre, documento o teléfono y `lookup`
 * para el documento exacto. Los datos del paciente se copian a la solicitud
 * (la cola guarda su propia copia) y el ticket lo entrega la API.
 */
export const NewRequestDialog = ({ onClose, onCreated }: NewRequestDialogProps) => {
  const [paciente, setPaciente] = useState<PatientSummary | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [documento, setDocumento] = useState('');
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [noEncontrado, setNoEncontrado] = useState<string | null>(null);

  const busquedaDiferida = useDebouncedValue(busqueda, 350);

  const formulario = useForm<ValoresSolicitud, unknown, SolicitudEnviada>({
    resolver: zodResolver(createRequestSchema),
    defaultValues: {
      patientId: '',
      patientName: '',
      patientDocument: '',
      patientPhone: '',
      channel: 'registro',
      reason: '',
      priority: 0,
      notes: '',
    },
  });

  const pacientesQuery = useQuery({
    queryKey: ['pacientes', 'programacion', { busqueda: busquedaDiferida }],
    queryFn: ({ signal }) =>
      patientsApi.list(
        {
          search: busquedaDiferida.trim() === '' ? undefined : busquedaDiferida.trim(),
          page: 1,
          pageSize: 8,
        },
        signal,
      ),
  });

  const buscarDocumento = useMutation({
    mutationFn: (valor: string) => patientsApi.lookup(valor),
  });

  const elegir = (elegido: PatientSummary) => {
    setPaciente(elegido);
    setNoEncontrado(null);
    setErrorGeneral(null);
    formulario.setValue('patientId', elegido.id, { shouldValidate: true });
    formulario.setValue('patientName', elegido.fullName, { shouldValidate: true });
    formulario.setValue('patientDocument', elegido.document);
    formulario.setValue('patientPhone', elegido.phone);
  };

  const buscarPorDocumento = async () => {
    setNoEncontrado(null);
    setErrorGeneral(null);
    try {
      const resultado = await buscarDocumento.mutateAsync(documento.trim());
      if (resultado.found) elegir(resultado.patient);
      else setNoEncontrado(resultado.document);
    } catch (fallo) {
      setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  const crear = useMutation({
    mutationFn: (valores: SolicitudEnviada) => requestsApi.create(valores),
  });

  const enviar = async (valores: SolicitudEnviada) => {
    if (paciente === null) {
      setErrorGeneral(t('programacion.nueva.sinPaciente'));
      return;
    }
    setErrorGeneral(null);
    try {
      const creada = await crear.mutateAsync({ ...valores, patientId: paciente.id });
      onCreated(creada);
    } catch (fallo) {
      if (!applyApiFieldErrors(formulario.setError, fallo)) {
        setErrorGeneral(apiErrorMessage(fallo));
      }
    }
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('programacion.nueva.titulo')}
      description={t('programacion.nueva.texto')}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('comun.cancelar')}
          </Button>
          <Button
            type="submit"
            form="formulario-nueva-solicitud"
            loading={isSubmitting}
            loadingLabel={t('comun.enviando')}
          >
            {t('programacion.nueva.enviar')}
          </Button>
        </>
      }
    >
      <form
        id="formulario-nueva-solicitud"
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          void formulario.handleSubmit(enviar)(event);
        }}
      >
        {errorGeneral !== null && <Alert variant="danger">{errorGeneral}</Alert>}

        <fieldset className="space-y-3 rounded-control border border-border p-3">
          <legend className="px-1 text-sm font-semibold text-ink">
            {t('programacion.nueva.paciente')}
          </legend>

          {paciente === null ? (
            <>
              <Field label={t('programacion.nueva.buscar')} error={errors.patientId?.message}>
                <Input
                  type="search"
                  placeholder={t('programacion.nueva.buscarPlaceholder')}
                  value={busqueda}
                  onChange={(event) => setBusqueda(event.target.value)}
                />
              </Field>

              <div className="flex flex-wrap items-end gap-2">
                <Field label={t('programacion.nueva.documento')} className="min-w-52 flex-1">
                  <Input
                    value={documento}
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('pacientes.doc.placeholder')}
                    onChange={(event) => setDocumento(event.target.value)}
                  />
                </Field>
                <Button
                  variant="secondary"
                  disabled={documento.trim().length < 3 || buscarDocumento.isPending}
                  loading={buscarDocumento.isPending}
                  loadingLabel={t('programacion.nueva.buscando')}
                  leadingIcon={<Search className="size-4" aria-hidden="true" />}
                  onClick={() => {
                    void buscarPorDocumento();
                  }}
                >
                  {t('programacion.nueva.buscarDocumento')}
                </Button>
              </div>

              {noEncontrado !== null && (
                <Alert variant="warning" title={t('registro.noEncontrado')}>
                  <p>{t('programacion.nueva.noEncontrado', { documento: noEncontrado })}</p>
                  <Link
                    to="/registro"
                    className="mt-1 inline-block font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {t('programacion.nueva.irARegistro')}
                  </Link>
                </Alert>
              )}

              {pacientesQuery.isError && (
                <Alert variant="danger">{t('programacion.nueva.errorBusqueda')}</Alert>
              )}

              {pacientesQuery.isPending ? (
                <Spinner label={t('programacion.nueva.buscando')} showLabel />
              ) : pacientesQuery.data !== undefined && pacientesQuery.data.items.length === 0 ? (
                <p className="text-sm text-ink-muted">{t('programacion.nueva.sinResultados')}</p>
              ) : (
                <ul className="space-y-1.5">
                  {pacientesQuery.data?.items.map((candidato) => (
                    <li key={candidato.id}>
                      <button
                        type="button"
                        onClick={() => elegir(candidato)}
                        className={cn(
                          'flex w-full flex-wrap items-center gap-2 rounded-control border border-border px-3 py-2 text-left text-sm transition-colors',
                          'hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus',
                        )}
                      >
                        <UserRound className="size-4 text-ink-subtle" aria-hidden="true" />
                        <span className="font-medium text-ink">{candidato.fullName}</span>
                        <span className="font-mono text-xs text-ink-subtle">
                          {candidato.document}
                        </span>
                        <span className="text-xs text-ink-muted">{candidato.phone}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-surface-muted px-3 py-2">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium text-ink">
                  <IdCard className="size-4 text-primary" aria-hidden="true" />
                  {paciente.fullName}
                </p>
                <p className="pt-0.5 font-mono text-xs text-ink-subtle">
                  {paciente.document} · {paciente.phone}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="success">{t('programacion.nueva.elegido')}</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPaciente(null);
                    formulario.setValue('patientId', '');
                  }}
                >
                  {t('programacion.nueva.cambiar')}
                </Button>
              </div>
            </div>
          )}
        </fieldset>

        <Field label={t('programacion.nueva.motivo')} error={errors.reason?.message} required>
          <Input autoComplete="off" {...formulario.register('reason')} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('programacion.nueva.canal')} error={errors.channel?.message}>
            <Select {...formulario.register('channel')}>
              {CHANNELS.map((valor: Channel) => (
                <option key={valor} value={valor}>
                  {CHANNEL_LABELS[valor]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={t('programacion.nueva.prioridad')}
            hint={t('programacion.nueva.prioridadAyuda')}
            error={errors.priority?.message}
          >
            <Input
              type="number"
              min={0}
              max={9}
              inputMode="numeric"
              {...formulario.register('priority')}
            />
          </Field>

          <Field label={t('pacientes.campo.phone')} error={errors.patientPhone?.message}>
            <Input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              {...formulario.register('patientPhone')}
            />
          </Field>
        </div>

        <Field label={t('programacion.nueva.notas')} error={errors.notes?.message}>
          <textarea
            rows={2}
            className="w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink shadow-xs transition-colors placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus"
            {...formulario.register('notes')}
          />
        </Field>
      </form>
    </Dialog>
  );
};
