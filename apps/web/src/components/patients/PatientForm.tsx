import type { CreatePatientInput, PatientDetail } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from '@odontocrm/ui';
import { Eye, LockKeyhole, Pencil, Save, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { apiErrorMessage } from '../../lib/api';
import { patientsApi } from '../../lib/endpoints';
import { applyApiFieldErrors } from '../../lib/forms';
import { t } from '../../lib/i18n';
import {
  createPayloadFromForm,
  emptyFormValues,
  existingPatientIdFrom,
  formValuesFromPatient,
  isDuplicateDocument,
  patientFormSchema,
  summarizePatientChanges,
  type ChangeSummary,
  type PatientFormDraft,
  type PatientFormOutput,
  type PatientFormValues,
} from '../../lib/patients';
import { useAuth } from '../../providers/AuthProvider';
import { PatientDiffDialog } from './PatientDiffDialog';
import { PatientFields } from './PatientFields';

/** Motivo mínimo que exige el contrato para editar (`updatePatientSchema.reason`). */
const MOTIVO_MINIMO = 3;

/**
 * Primer mensaje de error del formulario, recorriendo el árbol de `formState.errors`.
 * Se usa para que el aviso general **nombre** lo que falta en vez de dejar al usuario
 * buscando un campo marcado que a veces no se ve (p. ej. cuando el error cuelga de una
 * ruta que ninguna sección pinta).
 */
const primerMensajeDeError = (errores: unknown, profundidad = 0): string | null => {
  if (profundidad > 4 || errores === null || typeof errores !== 'object') return null;
  const registro = errores as Record<string, unknown>;
  const propio = registro['message'];
  if (typeof propio === 'string' && propio !== '') return propio;
  for (const [clave, valor] of Object.entries(registro)) {
    // `ref` apunta al nodo del DOM y `types` acumula criterios de validación: no son
    // errores, y recorrerlos podría entrar en ciclos.
    if (clave === 'ref' || clave === 'types') continue;
    const mensaje = primerMensajeDeError(valor, profundidad + 1);
    if (mensaje !== null) return mensaje;
  }
  return null;
};

export interface PatientFormProps {
  /** `create` da de alta; `edit` abre la ficha con el flujo de motivo y confirmación. */
  mode: 'create' | 'edit';
  /** Ficha original: obligatoria en `edit`, para comparar los cambios. */
  patient?: PatientDetail | null;
  /** Valores iniciales del alta (por ejemplo, el documento que se acaba de buscar). */
  initialValues?: PatientFormDraft;
  /** Recarga la vista de solo lectura después de guardar. */
  onSaved: (patient: PatientDetail) => void;
  /** Cierra o vuelve atrás; en el alta lo usa el botón Cancelar. */
  onCancel?: () => void;
  /** Abre una ficha existente cuando el alta choca con un documento duplicado (409). */
  onOpenExisting?: (patientId: string) => void;
}

/**
 * Formulario del paciente (alta y edición).
 *
 * En `edit` arranca en **solo lectura** con un rótulo visible; el botón «Editar»
 * pide un motivo (mínimo 3 caracteres) antes de habilitar los campos y, al
 * guardar, muestra un diálogo con el resumen de lo que cambia (valor anterior →
 * valor nuevo, con los campos sensibles destacados). Solo al confirmar se envía
 * el `PATCH`; si no hay cambios, avisa y no envía nada.
 */
export const PatientForm = ({
  mode,
  patient = null,
  initialValues,
  onSaved,
  onCancel,
  onOpenExisting,
}: PatientFormProps) => {
  const { hasPermission } = useAuth();
  const puedeEditar = hasPermission('patients:edit_sensitive');
  const esAlta = mode === 'create';

  const [motivo, setMotivo] = useState('');
  const [pidiendoMotivo, setPidiendoMotivo] = useState(false);
  const [editando, setEditando] = useState(esAlta);
  const [errorMotivo, setErrorMotivo] = useState<string | null>(null);
  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);
  const [duplicado, setDuplicado] = useState<string | null>(null);
  const [resumen, setResumen] = useState<ChangeSummary | null>(null);
  const [confirmando, setConfirmando] = useState(false);

  const iniciales = useMemo<PatientFormDraft>(
    () => initialValues ?? (patient ? formValuesFromPatient(patient) : emptyFormValues()),
    [initialValues, patient],
  );

  const formulario = useForm<PatientFormValues, unknown, PatientFormOutput>({
    resolver: zodResolver(patientFormSchema),
    defaultValues: iniciales,
  });

  const { reset } = formulario;
  useEffect(() => {
    reset(iniciales);
    setMotivo('');
    setPidiendoMotivo(false);
    setEditando(esAlta);
    setErrorGeneral(null);
    setErrorMotivo(null);
    setDuplicado(null);
    setResumen(null);
    setConfirmando(false);
  }, [esAlta, iniciales, reset]);

  const crear = useMutation({
    mutationFn: (input: CreatePatientInput) => patientsApi.create(input),
  });
  const actualizar = useMutation({
    mutationFn: (cambio: ChangeSummary) => {
      if (!patient) throw new Error('No hay paciente que actualizar');
      return patientsApi.update(patient.id, cambio.payload);
    },
  });

  const guardando = crear.isPending || actualizar.isPending;

  /** Valores actuales ya validados por el esquema del formulario. */
  const valoresValidos = async (): Promise<PatientFormValues | null> => {
    // Un doble clic rápido no debe disparar dos envíos.
    if (guardando) return null;
    const valido = await formulario.trigger();
    if (!valido) {
      // `formState` es un proxy que lee el estado vivo, así que tras `await trigger()`
      // ya trae los errores recién calculados.
      const detalle = primerMensajeDeError(formulario.formState.errors);
      setErrorGeneral(
        detalle === null
          ? t('pacientes.alta.revisar')
          : t('pacientes.alta.revisarDetalle', { detalle }),
      );
      return null;
    }
    return formulario.getValues();
  };

  const enviarAlta = async () => {
    setErrorGeneral(null);
    setDuplicado(null);
    const valores = await valoresValidos();
    if (!valores) return;

    try {
      onSaved(await crear.mutateAsync(createPayloadFromForm(valores)));
    } catch (fallo) {
      // 409: el documento ya existe. Se ofrece abrir esa ficha con el id que
      // manda el servidor en el cuerpo del error.
      if (isDuplicateDocument(fallo)) {
        setDuplicado(existingPatientIdFrom(fallo) ?? '');
        return;
      }
      if (!applyApiFieldErrors(formulario.setError, fallo)) setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  const revisarCambios = async () => {
    setErrorGeneral(null);
    if (!editando || patient === null) return;
    const valores = await valoresValidos();
    if (!valores) return;

    const cambio = summarizePatientChanges(patient, valores, motivo.trim());
    if (cambio.changes.length === 0) {
      setErrorGeneral(t('pacientes.editar.sinCambios'));
      return;
    }
    setResumen(cambio);
    setConfirmando(true);
  };

  const confirmarCambios = async () => {
    if (resumen === null) return;
    setErrorGeneral(null);
    try {
      const actualizado = await actualizar.mutateAsync(resumen);
      setConfirmando(false);
      setResumen(null);
      setEditando(false);
      setMotivo('');
      reset(formValuesFromPatient(actualizado));
      onSaved(actualizado);
    } catch (fallo) {
      setConfirmando(false);
      if (!applyApiFieldErrors(formulario.setError, fallo)) setErrorGeneral(apiErrorMessage(fallo));
    }
  };

  const habilitarEdicion = () => {
    setErrorGeneral(null);
    if (motivo.trim().length < MOTIVO_MINIMO) {
      setErrorMotivo(t('pacientes.editar.motivoTexto'));
      return;
    }
    setErrorMotivo(null);
    setPidiendoMotivo(false);
    setEditando(true);
  };

  const salirDeEdicion = () => {
    setEditando(false);
    setPidiendoMotivo(false);
    setMotivo('');
    setErrorMotivo(null);
    setErrorGeneral(null);
    if (patient) reset(formValuesFromPatient(patient));
  };

  const etiquetaModo = editando ? t('pacientes.editar.habilitado') : t('pacientes.lectura.rotulo');

  return (
    <>
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <CardTitle as="h2">
              {esAlta ? t('pacientes.alta.titulo') : t('pacientes.ficha.datos')}
            </CardTitle>
            <p className="pt-1 text-sm text-ink-muted">
              {esAlta ? t('pacientes.alta.descripcion') : t('pacientes.doc.ayuda')}
            </p>
          </div>

          {!esAlta && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <span
                className={
                  editando
                    ? 'inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary'
                    : 'inline-flex items-center gap-1.5 rounded-full border border-border-strong/60 bg-surface-muted px-2.5 py-1 text-xs font-medium text-ink-muted'
                }
              >
                {editando ? (
                  <Pencil className="size-3" aria-hidden="true" />
                ) : (
                  <Eye className="size-3" aria-hidden="true" />
                )}
                {etiquetaModo}
              </span>

              {puedeEditar && !editando && !pidiendoMotivo && (
                <Button
                  variant="secondary"
                  aria-pressed={editando}
                  aria-expanded={pidiendoMotivo}
                  onClick={() => {
                    setPidiendoMotivo(true);
                    setErrorGeneral(null);
                  }}
                  leadingIcon={<Pencil className="size-4" aria-hidden="true" />}
                >
                  {t('pacientes.editar.boton')}
                </Button>
              )}
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          {!esAlta && !editando && (
            <Alert variant="info" title={t('pacientes.lectura.rotulo')}>
              {puedeEditar ? t('pacientes.lectura.texto') : t('pacientes.lectura.sinPermiso')}
            </Alert>
          )}

          {!esAlta && pidiendoMotivo && !editando && puedeEditar && (
            <div className="grid gap-3 rounded-card border border-border bg-surface-muted p-3.5 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field
                label={t('pacientes.editar.motivo')}
                hint={t('pacientes.editar.motivoTexto')}
                error={errorMotivo ?? undefined}
                required
              >
                <Input
                  value={motivo}
                  autoFocus
                  placeholder={t('pacientes.editar.motivoPlaceholder')}
                  onChange={(event) => setMotivo(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      habilitarEdicion();
                    }
                  }}
                />
              </Field>
              <Button
                aria-pressed={editando}
                onClick={habilitarEdicion}
                leadingIcon={<LockKeyhole className="size-4" aria-hidden="true" />}
              >
                {t('pacientes.editar.habilitar')}
              </Button>
            </div>
          )}

          {!esAlta && editando && (
            <Alert variant="warning" title={t('pacientes.editar.motivoTitulo')}>
              {motivo}
            </Alert>
          )}

          {errorGeneral && (
            <Alert variant="danger" aria-live="polite">
              {errorGeneral}
            </Alert>
          )}

          {duplicado !== null && (
            <Alert variant="warning" title={t('registro.duplicado')} aria-live="polite">
              <span className="block">{t('registro.duplicadoTexto')}</span>
              {duplicado !== '' && onOpenExisting && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={() => onOpenExisting(duplicado)}
                >
                  {t('registro.abrirExistente')}
                </Button>
              )}
            </Alert>
          )}

          {/* `fieldset disabled` bloquea todo el bloque en modo lectura. El
              documento va oculto en la ficha (se ve en la cabecera): así sigue
              registrado en el formulario y el resumen de cambios lo compara. */}
          <form
            id={`formulario-paciente-${mode}`}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              // En solo lectura no se envía nada: el motivo y la confirmación
              // son obligatorios antes de tocar el `PATCH`.
              if (esAlta) void enviarAlta();
              else if (editando) void revisarCambios();
            }}
          >
            {!esAlta && (
              <>
                <input type="hidden" {...formulario.register('docType')} />
                <input type="hidden" {...formulario.register('docNumber')} />
              </>
            )}
            <fieldset disabled={!editando} className="min-w-0">
              <PatientFields form={formulario} showDocument={esAlta} />
            </fieldset>
          </form>
        </CardContent>

        <CardFooter>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel} disabled={guardando}>
              {t('comun.cancelar')}
            </Button>
          )}

          {!esAlta && editando && (
            <>
              <Button variant="secondary" onClick={salirDeEdicion} disabled={guardando}>
                {t('pacientes.editar.salir')}
              </Button>
              <Button
                type="submit"
                form={`formulario-paciente-${mode}`}
                loading={guardando}
                loadingLabel={t('comun.guardando')}
                leadingIcon={<ShieldAlert className="size-4" aria-hidden="true" />}
              >
                {t('pacientes.editar.revisar')}
              </Button>
            </>
          )}

          {esAlta && (
            <Button
              type="submit"
              form={`formulario-paciente-${mode}`}
              loading={guardando}
              loadingLabel={t('comun.guardando')}
              leadingIcon={<Save className="size-4" aria-hidden="true" />}
            >
              {t('pacientes.alta.enviar')}
            </Button>
          )}
        </CardFooter>
      </Card>

      <PatientDiffDialog
        open={confirmando}
        resumen={resumen}
        motivo={motivo}
        guardando={actualizar.isPending}
        error={errorGeneral}
        onClose={() => setConfirmando(false)}
        onConfirm={() => void confirmarCambios()}
      />
    </>
  );
};
