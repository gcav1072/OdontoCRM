import {
  CLINICAL_STATE_COLORS,
  CONDITION_LABELS,
  CLINICAL_STATE_LABELS,
  SURFACE_FORM_ORDER,
  surfaceLabelFor,
  WHOLE_TOOTH_CONDITIONS,
  conflictingCondition,
  findingsFromSelection,
  isToothNumber,
  selectionIsApplicable,
} from '@odontocrm/contracts';
import type {
  ClinicalState,
  ToothCondition,
  ToothFindingRecord,
  ToothSurface,
} from '@odontocrm/contracts';
import { Alert, Badge, Button, Dialog } from '@odontocrm/ui';
import { Pencil, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { t } from '../../lib/i18n';
import { odontogramApi } from '../../lib/odontogram-api';

/**
 * Hoja de la pieza: **todo el odontograma con botones grandes**.
 *
 * Existe porque el gráfico es un lienzo de 100×100 por pieza: con ratón, acertar
 * una cara es razonable, pero con el dedo en una tableta no lo es (una cara mide
 * ~12 px). Así que en pantallas táctiles el toque **abre esta hoja**, donde todo
 * son áreas de ≥44 px: las cinco caras, las condiciones, el estado y el borrado.
 *
 * No tiene reglas propias: construye el mismo `FindingSelection` que la carga
 * rápida por teclado y lo convierte con `findingsFromSelection`, así que marcar
 * tres caras deja tres hallazgos en una sola transacción y las combinaciones
 * imposibles (ADR 0032) se desactivan aquí **y** se rechazan en el servidor.
 */

/** Estilo del campo de notas: el mismo que usan los formularios clínicos. */
const TEXTAREA_CLASSES =
  'w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink shadow-xs transition-colors placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted';

/** Condiciones de cara que se ofrecen en la hoja, con su acción. */
const SURFACE_ACTIONS: readonly ToothCondition[] = ['caries', 'restauracion'];

export interface ToothFindingSheetProps {
  open: boolean;
  /** Paciente dueño del odontograma. */
  patientId: string;
  toothNumber: number | null;
  /** Hallazgos **vigentes** de la pieza. */
  findings: readonly ToothFindingRecord[];
  /** Sin permiso de escritura la hoja solo informa. */
  canWrite: boolean;
  /** Sesión clínica abierta (Fase 7): el hallazgo queda ligado a esta visita. */
  sessionId?: string | null;
  onClose: () => void;
  /**
   * Se llama tras un cambio que el servidor aceptó. Trae la pieza, los hallazgos
   * **de antes** (para poder deshacer) y la frase del cambio.
   */
  onApplied: (cambio: {
    toothNumber: number;
    anterior: readonly ToothFindingRecord[];
    descripcion: string;
  }) => void;
  onError: (mensaje: string) => void;
}

export const ToothFindingSheet = ({
  open,
  patientId,
  toothNumber,
  findings,
  canWrite,
  sessionId = null,
  onClose,
  onApplied,
  onError,
}: ToothFindingSheetProps) => {
  const [caras, setCaras] = useState<readonly ToothSurface[]>([]);
  const [estado, setEstado] = useState<ClinicalState>('pendiente');
  const [ocupada, setOcupada] = useState(false);
  const [errorLocal, setErrorLocal] = useState<string | null>(null);
  /** Hallazgo cuya edición (estado y notas) está abierta. */
  const [editando, setEditando] = useState<string | null>(null);
  const [notas, setNotas] = useState('');
  /** Notas que se guardan con lo que se marque ahora (la columna NOTAS del informe). */
  const [notasNuevas, setNotasNuevas] = useState('');

  // Cada vez que se abre (o se cambia de pieza) la selección arranca limpia: lo
  // que hubiera marcado antes no vale para otra pieza.
  useEffect(() => {
    if (!open) return;
    setCaras([]);
    setEstado('pendiente');
    setErrorLocal(null);
    setEditando(null);
    setNotas('');
    setNotasNuevas('');
  }, [open, toothNumber]);

  const cambiarCara = (surface: ToothSurface): void =>
    setCaras((actuales) =>
      actuales.includes(surface)
        ? actuales.filter((item) => item !== surface)
        : [...actuales, surface],
    );

  /** Abre la edición de un hallazgo ya registrado (estado y notas). */
  const abrirNotas = (finding: ToothFindingRecord): void => {
    setEditando(finding.id);
    setNotas(finding.notes ?? '');
  };

  /**
   * Corrige un hallazgo existente **sin cambiar su clave natural** (pieza, cara y
   * condición): solo el estado y las notas. Cambiar de cara o de condición se hace
   * quitando y marcando otra vez, que es lo que el servidor admite.
   */
  const actualizar = async (
    finding: ToothFindingRecord,
    cambios: { state: ClinicalState; notes: string | null },
  ): Promise<void> => {
    if (toothNumber === null) return;
    setOcupada(true);
    setErrorLocal(null);
    try {
      await odontogramApi.recordFinding(patientId, {
        toothNumber,
        surface: finding.surface,
        condition: finding.condition,
        state: cambios.state,
        notes: cambios.notes,
        sessionId: finding.sessionId,
      });
      setEditando(null);
      onApplied({
        toothNumber,
        anterior: findings,
        descripcion: t('odonto.sheet.editado', {
          detalle: CONDITION_LABELS[finding.condition].toLowerCase(),
        }),
      });
    } catch (fallo) {
      onError(apiErrorMessage(fallo));
    } finally {
      setOcupada(false);
    }
  };

  const aplicar = async (condition: ToothCondition): Promise<void> => {
    if (toothNumber === null) return;

    const selection = { toothNumber, surfaces: caras, condition, state: estado };
    if (!selectionIsApplicable(selection, findings)) {
      const choque = conflictingCondition(findings, condition);
      setErrorLocal(
        choque === null
          ? t('odonto.sheet.invalida')
          : t('odonto.sheet.choca', {
              condicion: CONDITION_LABELS[choque].toLowerCase(),
              nueva: CONDITION_LABELS[condition].toLowerCase(),
            }),
      );
      return;
    }

    // Las notas acompañan a **todos** los hallazgos de esta acción: si se marcan tres
    // caras con la misma observación, las tres la llevan. La sesión también: lo que
    // se marca con la sesión abierta pertenece a esa visita.
    const nota = notasNuevas.trim() === '' ? null : notasNuevas.trim();
    const entradas = findingsFromSelection({ ...selection, sessionId }).map((entrada) => ({
      ...entrada,
      notes: nota,
    }));
    setOcupada(true);
    setErrorLocal(null);
    try {
      if (entradas.length === 1) {
        const unica = entradas[0];
        if (unica !== undefined) await odontogramApi.recordFinding(patientId, unica);
      } else {
        await odontogramApi.recordFindings(patientId, { findings: entradas });
      }
      setCaras([]);
      setNotasNuevas('');
      onApplied({
        toothNumber,
        anterior: findings,
        descripcion: CONDITION_LABELS[condition].toLowerCase(),
      });
    } catch (fallo) {
      onError(apiErrorMessage(fallo));
    } finally {
      setOcupada(false);
    }
  };

  const quitar = async (finding: ToothFindingRecord): Promise<void> => {
    if (toothNumber === null) return;
    setOcupada(true);
    setErrorLocal(null);
    try {
      if (finding.surface === null) {
        await odontogramApi.removeFinding(patientId, {
          toothNumber,
          surface: null,
          condition: finding.condition,
        });
      } else {
        await odontogramApi.clearSurface(patientId, {
          toothNumber,
          surface: finding.surface,
        });
      }
      onApplied({
        toothNumber,
        anterior: findings,
        descripcion: `quitar ${CONDITION_LABELS[finding.condition].toLowerCase()}`,
      });
    } catch (fallo) {
      onError(apiErrorMessage(fallo));
    } finally {
      setOcupada(false);
    }
  };

  if (toothNumber === null || !isToothNumber(toothNumber)) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('odonto.sheet.titulo', { pieza: toothNumber })}
      footer={
        <Button variant="secondary" onClick={onClose} disabled={ocupada}>
          {t('comun.cerrar')}
        </Button>
      }
    >
      <div className="space-y-5">
        {errorLocal !== null && <Alert variant="warning">{errorLocal}</Alert>}

        {/* Lo que ya tiene la pieza, con su botón de quitar a mano. */}
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            {t('odonto.sheet.actuales')}
          </h4>
          {findings.length === 0 ? (
            <p className="mt-1 text-sm text-ink-muted">{t('odonto.sheet.sana')}</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {findings.map((finding) => (
                <li key={finding.id} className="rounded-control border border-border px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm">
                      <span
                        className="inline-block size-3 rounded-full"
                        style={{ backgroundColor: CLINICAL_STATE_COLORS[finding.state] }}
                        aria-hidden
                      />
                      {finding.surface === null
                        ? CONDITION_LABELS[finding.condition]
                        : `${CONDITION_LABELS[finding.condition]} · ${surfaceLabelFor(finding.toothNumber, finding.surface)}`}
                    </span>

                    {canWrite && (
                      <span className="flex flex-wrap items-center gap-1">
                        {/* El estado se corrige con un toque: es el error de dedo más
                            común (marcar «pendiente» lo que ya estaba hecho). */}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={ocupada}
                          onClick={() =>
                            void actualizar(finding, {
                              state: finding.state === 'pendiente' ? 'completado' : 'pendiente',
                              notes: finding.notes,
                            })
                          }
                          leadingIcon={
                            <span
                              className="inline-block size-3 rounded-full"
                              style={{
                                backgroundColor:
                                  CLINICAL_STATE_COLORS[
                                    finding.state === 'pendiente' ? 'completado' : 'pendiente'
                                  ],
                              }}
                              aria-hidden
                            />
                          }
                        >
                          {t(
                            finding.state === 'pendiente'
                              ? 'odonto.sheet.marcarCompletado'
                              : 'odonto.sheet.marcarPendiente',
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={ocupada}
                          onClick={() => abrirNotas(finding)}
                          aria-label={t('odonto.sheet.editarAria', {
                            detalle: CONDITION_LABELS[finding.condition],
                          })}
                          leadingIcon={<Pencil className="size-4" aria-hidden />}
                        >
                          {t('odonto.sheet.editar')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={ocupada}
                          onClick={() => void quitar(finding)}
                          aria-label={t('odonto.sheet.quitarAria', {
                            detalle: CONDITION_LABELS[finding.condition],
                          })}
                          leadingIcon={<Trash2 className="size-4" aria-hidden />}
                        >
                          {t('odonto.sheet.quitar')}
                        </Button>
                      </span>
                    )}
                  </div>

                  {finding.notes !== null && editando !== finding.id && (
                    <p className="mt-1 text-xs text-ink-muted">{finding.notes}</p>
                  )}

                  {/* Editar = cambiar el estado y las notas. La clave natural
                      (pieza, cara, condición) no se toca: para cambiar de cara o de
                      condición se quita y se marca de nuevo. */}
                  {editando === finding.id && (
                    <div className="mt-2 space-y-2">
                      <textarea
                        className={TEXTAREA_CLASSES}
                        value={notas}
                        onChange={(event) => setNotas(event.target.value)}
                        rows={2}
                        maxLength={500}
                        aria-label={t('odonto.sheet.notas')}
                        placeholder={t('odonto.sheet.notasPlaceholder')}
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          disabled={ocupada}
                          onClick={() =>
                            void actualizar(finding, { state: finding.state, notes: notas })
                          }
                        >
                          {t('odonto.sheet.guardar')}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={ocupada}
                          onClick={() => setEditando(null)}
                        >
                          {t('comun.cancelar')}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {canWrite && (
          <>
            {/* Caras: botones de 44 px, que es lo que un dedo acierta. */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                {t('odonto.sheet.caras')}
              </h4>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {SURFACE_FORM_ORDER.map((surface) => (
                  <button
                    key={surface}
                    type="button"
                    aria-pressed={caras.includes(surface)}
                    onClick={() => cambiarCara(surface)}
                    className={`min-h-11 rounded-control border px-3 py-2 text-sm font-medium transition-colors ${
                      caras.includes(surface)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-ink-muted hover:text-ink'
                    }`}
                  >
                    {surfaceLabelFor(toothNumber, surface)}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-ink-subtle">{t('odonto.sheet.carasAyuda')}</p>
            </section>

            {/* Estado: el gesto de «ya está hecho» (azul) o «por hacer» (rojo). */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                {t('odonto.sheet.estado')}
              </h4>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(['pendiente', 'completado'] as const).map((valor) => (
                  <button
                    key={valor}
                    type="button"
                    aria-pressed={estado === valor}
                    onClick={() => setEstado(valor)}
                    className={`flex min-h-11 items-center justify-center gap-2 rounded-control border px-3 py-2 text-sm font-medium transition-colors ${
                      estado === valor ? 'border-primary text-ink' : 'border-border text-ink-muted'
                    }`}
                  >
                    <span
                      className="inline-block size-3 rounded-full"
                      style={{ backgroundColor: CLINICAL_STATE_COLORS[valor] }}
                      aria-hidden
                    />
                    {CLINICAL_STATE_LABELS[valor]}
                  </button>
                ))}
              </div>
            </section>

            {/*
              Notas: se escriben **al marcar**, no después. Es lo que sale en la
              columna NOTAS del informe, así que pedirlas dos pasos más tarde (guardar,
              editar, escribir, guardar) era pedirlas tarde.
            */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                {t('odonto.sheet.notas')}
              </h4>
              <textarea
                className={`${TEXTAREA_CLASSES} mt-2`}
                value={notasNuevas}
                onChange={(event) => setNotasNuevas(event.target.value)}
                rows={2}
                maxLength={500}
                aria-label={t('odonto.sheet.notas')}
                placeholder={t('odonto.sheet.notasPlaceholder')}
              />
              <p className="mt-1.5 text-xs text-ink-subtle">{t('odonto.sheet.notasAyuda')}</p>
            </section>

            {/* Condiciones: dos filas, las de cara y los tratamientos. */}
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                {t('odonto.sheet.condicion')}
              </h4>{' '}
              <div className="mt-2 grid grid-cols-2 gap-2">
                {SURFACE_ACTIONS.map((condition) => (
                  <ConditionButton
                    key={condition}
                    condition={condition}
                    findings={findings}
                    selection={{ surfaces: caras, state: estado, toothNumber }}
                    occupied={ocupada}
                    onClick={() => void aplicar(condition)}
                  />
                ))}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {WHOLE_TOOTH_CONDITIONS.map((condition) => (
                  <ConditionButton
                    key={condition}
                    condition={condition}
                    findings={findings}
                    selection={{ surfaces: [], state: estado, toothNumber }}
                    occupied={ocupada}
                    onClick={() => void aplicar(condition)}
                  />
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
};

/**
 * Un botón de condición que **se desactiva solo** cuando no puede convivir con lo
 * que la pieza ya tiene (ADR 0032). La regla es la misma que aplica el servidor:
 * `selectionIsApplicable` con `conflictingCondition`.
 */
const ConditionButton = ({
  condition,
  findings,
  selection,
  occupied,
  onClick,
}: {
  condition: ToothCondition;
  findings: readonly ToothFindingRecord[];
  selection: { toothNumber: number; surfaces: readonly ToothSurface[]; state: ClinicalState };
  occupied: boolean;
  onClick: () => void;
}) => {
  const choque = conflictingCondition(findings, condition);
  const aplicable = selectionIsApplicable({ ...selection, condition }, findings);

  return (
    <button
      type="button"
      disabled={occupied || !aplicable}
      onClick={onClick}
      title={
        choque === null
          ? undefined
          : t('odonto.sheet.choca', {
              condicion: CONDITION_LABELS[choque].toLowerCase(),
              nueva: CONDITION_LABELS[condition].toLowerCase(),
            })
      }
      className="min-h-11 rounded-control border border-border px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {CONDITION_LABELS[condition]}
    </button>
  );
};

/** Badge de ayuda con el número de hallazgos, para el encabezado de la hoja. */
export const SheetFindingCount = ({ findings }: { findings: readonly ToothFindingRecord[] }) => (
  <Badge variant="neutral">{t('odonto.sheet.cuenta', { total: findings.length })}</Badge>
);
