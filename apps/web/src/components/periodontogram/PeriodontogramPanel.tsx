import {
  PERIODONTAL_LOWER_TEETH,
  PERIODONTAL_UPPER_TEETH,
  analyzePeriodontalChart,
  buildPeriodontalChart,
  periodontalExamIsEditable,
  type CreatePeriodontalExamInput,
  type FurcationEntrance,
  type PeriodontalComparison,
  type PeriodontalExamDetail,
  type PeriodontalExamLookup,
  type PeriodontalExamSummary,
  type PeriodontalGrade,
  type PeriodontalRiskFactors,
  type PeriodontalSide,
  type PeriodontalSiteIndex,
  type PeriodontalStage,
  type PeriodontalTooth,
} from '@odontocrm/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Input,
  Select,
  Spinner,
  Textarea,
} from '@odontocrm/ui';
import {
  CalendarDays,
  ChevronLeft,
  ClipboardList,
  GitCompareArrows,
  Plus,
  Printer,
  Stethoscope,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useNotice } from '../../hooks/useNotice';
import { apiErrorMessage, isApiError } from '../../lib/api';
import { t } from '../../lib/i18n';
import {
  periodontogramApi,
  periodontogramExamQueryKey,
  periodontogramListQueryKey,
  periodontogramQueryKey,
} from '../../lib/periodontogram-api';
import { NoticeBanner } from '../NoticeBanner';
import { PeriodontogramArchSvg } from './PeriodontogramArchSvg';
import { PeriodontogramSitesTable } from './PeriodontogramSitesTable';
import { ProbingTouchPad } from './ProbingTouchPad';
import { changeColor, comparisonSiteIndex } from './geometry';
import {
  examDateLabel,
  examStatusLabel,
  gradeLabel,
  kpiItems,
  riskFactorsText,
  smokingLabel,
  diabetesLabel,
  stageLabel,
  suggestionText,
  comparisonKpiItems,
  changeLabel,
} from './presentation';
import {
  initialPeriodontalState,
  periodontalStateIsDirty,
  savedSnapshotOf,
  type PeriodontalSavedSnapshot,
  type PeriodontalField,
  type PeriodontalSiteFlag,
} from './controller';
import { usePeriodontalController } from './usePeriodontalController';

/**
 * Panel del periodontograma: el examen completo, autocontenido.
 *
 * Recibe el paciente y hace sus propias lecturas y mutaciones (como el odontograma),
 * de modo que la pestaña que lo monte no sepa nada del módulo:
 * - Carga el **último examen** y la lista; si es un borrador lo abre editable.
 * - Edita en memoria con el controlador (pad, SVG, tabla y teclado) y guarda con
 *   **autosave debounced** de 1200 ms con revisión optimista; en 409 recarga y avisa.
 * - Finaliza con confirmación (cierre inmutable) y descarta borradores con confirmación.
 * - Ofrece nuevo examen (clonando el anterior o en blanco), comparación longitudinal
 *   contra otro examen y acceso a la impresión.
 *
 * La captura **nunca** inventa mediciones: los sitios sin sondar se ven «—» y los
 * KPIs salen de `periodontalMetrics`, que solo cuenta sitios medidos.
 */

/** Espera del autosave: unpoco más que el tiempo entre dos toques seguidos. */
const AUTOSAVE_MS = 1200;

/**
 * Ancho mínimo del gráfico en pantalla. Por debajo de esto las cotas, los triángulos
 * de furca y los números de pieza se vuelven ilegibles, así que el contenedor
 * desplaza en horizontal. Las dos arcadas comparten el mismo contenedor: si cada una
 * tuviera su barra, se desalinearían al desplazar solo una.
 */
const GRAFICO_ANCHO_MINIMO = 1400;

/** Tope de exámenes que pide la lista (el contrato admite 100). */
const LIMITE_LISTA = 50;

/** Ruta de impresión por defecto (la integración puede pasarla por prop). */
const rutaImpresionPorDefecto = (patientId: string, examId: string): string =>
  `/consultorio/${patientId}/periodontograma/imprimir?examen=${examId}`;

/** Estado del guardado que enseña la cabecera. */
type SaveStatus = 'inactivo' | 'pendiente' | 'guardando' | 'guardado' | 'error' | 'conflicto';

export interface PeriodontogramPanelProps {
  patientId: string;
  /** Escribir exige el permiso del periodontograma; sin él el panel es de solo lectura. */
  canWrite: boolean;
  /** Sesión clínica abierta (los exámenes nuevos quedan ligados a la visita). */
  sessionId: string | null;
  /**
   * URL de la página de impresión para un examen. Opcional: por defecto se usa la
   * ruta del consultorio, que es la que monta la integración.
   */
  printHref?: (examId: string) => string;
}

/** Un examen del listado con lo necesario para decidir si se compara. */
const esComparable = (item: PeriodontalExamSummary): boolean => item.status === 'finalizado';

export const PeriodontogramPanel = ({
  patientId,
  canWrite,
  sessionId,
  printHref,
}: PeriodontogramPanelProps) => {
  const queryClient = useQueryClient();
  const { notice, mostrar, exito, error, limpiar } = useNotice();
  const controller = usePeriodontalController();
  const { state: controllerState, reset: resetController } = controller;

  // Claves estables: si cambian en cada render, el efecto de autosave se reinicia
  // y puede volver a «pendiente» justo después de guardar.
  const latestKey = useMemo(() => periodontogramQueryKey(patientId), [patientId]);
  const listKey = useMemo(() => periodontogramListQueryKey(patientId), [patientId]);

  const latestQuery = useQuery({
    queryKey: latestKey,
    queryFn: ({ signal }) => periodontogramApi.latest(patientId, signal),
    // El borrador local manda: un refresco por volver a la ventana no puede pisar
    // lo que se está escribiendo (el servidor solo gana revisiones al guardar).
    refetchOnWindowFocus: false,
  });

  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => periodontogramApi.list(patientId, { limit: LIMITE_LISTA }, signal),
    refetchOnWindowFocus: false,
  });

  /** Examen de otro momento que se está consultando (lista o comparación). */
  const [selectedExamId, setSelectedExamId] = useState<string | null>(null);
  /** Comparación activa: el examen actual y el anterior con el que se compara. */
  const [comparison, setComparison] = useState<{ examId: string; previousId: string } | null>(null);
  const [dialogo, setDialogo] = useState<'finalizar' | 'descartar' | 'nuevo' | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('inactivo');
  const [savedSnapshot, setSavedSnapshot] = useState<PeriodontalSavedSnapshot | null>(null);
  const [revision, setRevision] = useState(0);
  const [hba1cText, setHba1cText] = useState('');
  const [finalizando, setFinalizando] = useState(false);
  const [descartando, setDescartando] = useState(false);
  const [creando, setCreando] = useState(false);

  const loadedRef = useRef<{ id: string; revision: number } | null>(null);
  const stateRef = useRef(controllerState);
  stateRef.current = controllerState;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const savedSnapshotRef = useRef(savedSnapshot);
  savedSnapshotRef.current = savedSnapshot;
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const refetchLatestRef = useRef(latestQuery.refetch);
  refetchLatestRef.current = latestQuery.refetch;
  const refetchListRef = useRef(listQuery.refetch);
  refetchListRef.current = listQuery.refetch;

  /** Examen vigente del paciente (el último, sea borrador o finalizado). */
  const examActivo: PeriodontalExamDetail | null =
    latestQuery.data?.exists === true ? latestQuery.data.exam : null;
  const previousFinalized: PeriodontalExamSummary | null =
    latestQuery.data?.exists === true ? latestQuery.data.previousFinalized : null;

  /** Examen que se está mirando: el seleccionado o, por defecto, el último. */
  const detailQuery = useQuery({
    queryKey: periodontogramExamQueryKey(patientId, selectedExamId ?? ''),
    queryFn: ({ signal }) => periodontogramApi.detail(patientId, selectedExamId ?? '', signal),
    enabled: selectedExamId !== null,
    refetchOnWindowFocus: false,
  });

  const comparisonQuery = useQuery({
    queryKey: [
      ...periodontogramExamQueryKey(patientId, comparison?.examId ?? ''),
      'comparacion',
      comparison?.previousId ?? '',
    ],
    queryFn: ({ signal }) =>
      periodontogramApi.compare(
        patientId,
        comparison?.examId ?? '',
        comparison?.previousId ?? '',
        signal,
      ),
    enabled: comparison !== null,
    refetchOnWindowFocus: false,
  });

  /** Examen visible: el seleccionado de la lista o el activo. */
  const vistaExam: PeriodontalExamDetail | null =
    selectedExamId !== null ? (detailQuery.data ?? null) : examActivo;
  const vistaCargando = selectedExamId !== null && detailQuery.isLoading;
  const vistaError = selectedExamId !== null ? detailQuery.error : null;

  const editable =
    canWrite &&
    examActivo !== null &&
    selectedExamId === null &&
    periodontalExamIsEditable(examActivo.status) &&
    controllerState !== null;

  /* ── Carga del borrador en el controlador ─────────────────────────────────── */
  useEffect(() => {
    if (latestQuery.data === undefined) return;
    if (latestQuery.data.exists !== true) {
      loadedRef.current = null;
      return;
    }
    const exam = latestQuery.data.exam;
    const cargado = loadedRef.current;
    const mismoExamen = cargado !== null && cargado.id === exam.id;
    const hayCambiosLocales =
      controllerState !== null && periodontalStateIsDirty(controllerState, savedSnapshot);
    // No se pisa lo que se está escribiendo: si los cambios locales están sin
    // guardar, el refresco del servidor espera (el guardado lleva la revisión).
    if (mismoExamen && (cargado.revision === exam.revision || hayCambiosLocales)) return;

    const inicial = initialPeriodontalState(exam);
    resetController(exam);
    setSavedSnapshot(savedSnapshotOf(inicial));
    setRevision(exam.revision);
    setHba1cText(exam.riskFactors.hba1c === null ? '' : String(exam.riskFactors.hba1c));
    setSaveStatus('inactivo');
    loadedRef.current = { id: exam.id, revision: exam.revision };
  }, [latestQuery.data, controllerState, savedSnapshot, resetController]);

  // Cambiar de paciente vuelve a la vista por defecto (el examen seleccionado era
  // del paciente anterior y la comparación ya no vale).
  useEffect(() => {
    setSelectedExamId(null);
    setComparison(null);
    setDialogo(null);
    loadedRef.current = null;
    setSavedSnapshot(null);
    setSaveStatus('inactivo');
  }, [patientId]);

  /* ── Guardado con autosave y revisión optimista ───────────────────────────── */

  const guardarAhora = useCallback(
    (snapshot: PeriodontalSavedSnapshot): Promise<boolean> => {
      // Un guardado en vuelo se comparte: finalizar tiene que esperar a que termine
      // en vez de mandar dos escrituras con la misma revisión.
      if (savePromiseRef.current !== null) return savePromiseRef.current;

      const ejecutar = async (): Promise<boolean> => {
        const estado = stateRef.current;
        const exam = loadedRef.current;
        if (estado === null || exam === null || !canWrite) return false;
        setSaveStatus('guardando');
        try {
          const resultado = await periodontogramApi.save(patientId, exam.id, {
            revision: revisionRef.current,
            examDate: estado.examDate,
            chart: estado.chart,
            riskFactors: estado.riskFactors,
            diagnosis: estado.diagnosis,
            notes: estado.notes,
          });
          revisionRef.current = resultado.exam.revision;
          loadedRef.current = { id: resultado.exam.id, revision: resultado.exam.revision };
          setRevision(resultado.exam.revision);
          // El último examen cacheado pasa a ser el guardado: si no, el efecto de carga
          // vería una revisión vieja del servidor y podría reponerla sobre el borrador.
          queryClient.setQueryData<PeriodontalExamLookup>(latestKey, (previo) =>
            previo !== undefined && previo.exists
              ? { ...previo, exam: resultado.exam }
              : { exists: true, exam: resultado.exam, previousFinalized: null, patient: null },
          );
          savedSnapshotRef.current = snapshot;
          setSavedSnapshot(snapshot);
          setSaveStatus('guardado');
          void queryClient.invalidateQueries({ queryKey: listKey });
          return true;
        } catch (fallo) {
          if (isApiError(fallo) && fallo.status === 409) {
            // Otra pestaña o usuario guardó antes: se recarga y se avisa; nunca se
            // pisan dos ediciones a ciegas (revisión optimista del contrato).
            setSaveStatus('conflicto');
            mostrar({
              variant: 'warning',
              title: t('periodonto.conflicto.titulo'),
              message: t('periodonto.conflicto.texto'),
            });
            loadedRef.current = null;
            setSavedSnapshot(null);
            await refetchLatestRef.current();
            return false;
          }
          setSaveStatus('error');
          error(apiErrorMessage(fallo), t('periodonto.error.guardar'));
          return false;
        }
      };

      const promesa = ejecutar();
      savePromiseRef.current = promesa;
      void promesa.finally(() => {
        if (savePromiseRef.current === promesa) savePromiseRef.current = null;
      });
      return promesa;
    },
    [canWrite, error, latestKey, listKey, mostrar, patientId, queryClient],
  );

  const hayCambios =
    controllerState !== null && periodontalStateIsDirty(controllerState, savedSnapshot);

  // Autosave: debounced y solo si el examen es un borrador editable.
  useEffect(() => {
    if (!editable || controllerState === null || !hayCambios) return undefined;
    setSaveStatus('pendiente');
    const snapshot = savedSnapshotOf(controllerState);
    const temporizador = setTimeout(() => {
      void guardarAhora(snapshot);
    }, AUTOSAVE_MS);
    return () => clearTimeout(temporizador);
  }, [controllerState, editable, guardarAhora, hayCambios]);

  // Aviso del navegador si se cierra la pestaña con cambios sin guardar.
  useEffect(() => {
    if (!hayCambios) return undefined;
    const avisar = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    globalThis.addEventListener('beforeunload', avisar);
    return () => globalThis.removeEventListener('beforeunload', avisar);
  }, [hayCambios]);

  /* ── Mutaciones del examen (crear, finalizar, descartar) ──────────────────── */

  const crearExamen = async (source: CreatePeriodontalExamInput['source']): Promise<void> => {
    if (!canWrite) return;
    setCreando(true);
    setDialogo(null);
    try {
      const input: CreatePeriodontalExamInput = {
        source,
        previousExamId:
          source === 'anterior'
            ? examActivo?.status === 'finalizado'
              ? examActivo.id
              : (previousFinalized?.id ?? null)
            : null,
        sessionId,
        notes: null,
      };
      const resultado = await periodontogramApi.create(patientId, input);
      loadedRef.current = null;
      // La caché del último examen se actualiza en el acto; el snapshot del paciente
      // se conserva porque el membrete de la impresión lo lee de `latest`.
      queryClient.setQueryData<PeriodontalExamLookup>(latestKey, (previo) => ({
        exists: true,
        exam: resultado.exam,
        previousFinalized:
          previo !== undefined && previo.exists ? previo.previousFinalized : previousFinalized,
        patient: previo?.patient ?? null,
      }));
      setSelectedExamId(null);
      setComparison(null);
      exito(t('periodonto.crear.exito'));
      void refetchListRef.current();
    } catch (fallo) {
      error(apiErrorMessage(fallo), t('periodonto.error.crear'));
    } finally {
      setCreando(false);
    }
  };

  const finalizarExamen = async (): Promise<void> => {
    if (examActivo === null) return;
    setFinalizando(true);
    try {
      // Primero se vuelca lo pendiente: finalizar congela lo que quedó guardado.
      if (hayCambios && controllerState !== null) {
        const guardado = await guardarAhora(savedSnapshotOf(controllerState));
        if (!guardado) {
          setFinalizando(false);
          return;
        }
      }
      const resultado = await periodontogramApi.finalize(patientId, examActivo.id, {
        revision: revisionRef.current,
      });
      setDialogo(null);
      loadedRef.current = null;
      exito(
        resultado.alreadyFinalized
          ? t('periodonto.finalizar.yaFinalizado')
          : t('periodonto.finalizar.exito'),
      );
      await refetchLatestRef.current();
      void refetchListRef.current();
    } catch (fallo) {
      if (isApiError(fallo) && fallo.status === 409) {
        loadedRef.current = null;
        await refetchLatestRef.current();
        mostrar({
          variant: 'warning',
          title: t('periodonto.conflicto.titulo'),
          message: t('periodonto.conflicto.texto'),
        });
      } else {
        error(apiErrorMessage(fallo), t('periodonto.error.finalizar'));
      }
    } finally {
      setFinalizando(false);
    }
  };

  const descartarExamen = async (): Promise<void> => {
    if (examActivo === null) return;
    setDescartando(true);
    try {
      await periodontogramApi.discard(patientId, examActivo.id);
      setDialogo(null);
      loadedRef.current = null;
      exito(t('periodonto.descartar.exito'));
      await Promise.all([refetchLatestRef.current(), refetchListRef.current()]);
    } catch (fallo) {
      error(apiErrorMessage(fallo), t('periodonto.error.descartar'));
    } finally {
      setDescartando(false);
    }
  };

  /* ── Comparación y acciones de la lista ───────────────────────────────────── */

  const candidatosComparacion = useMemo(
    () => (listQuery.data?.items ?? []).filter(esComparable),
    [listQuery.data],
  );

  /** Examen anterior natural para un examen: el finalizado inmediatamente más antiguo. */
  const anteriorDe = useCallback(
    (examId: string): PeriodontalExamSummary | null => {
      const items = listQuery.data?.items ?? [];
      const posicion = items.findIndex((item) => item.id === examId);
      if (posicion < 0) return null;
      return (
        items.slice(posicion + 1).find((item) => item.status === 'finalizado') ??
        items.slice(0, posicion).find((item) => item.status === 'finalizado') ??
        null
      );
    },
    [listQuery.data],
  );

  const abrirComparacion = (item: PeriodontalExamSummary): void => {
    const anterior = anteriorDe(item.id);
    if (anterior === null) {
      mostrar({ variant: 'info', message: t('periodonto.comparacion.sinAnterior') });
      return;
    }
    setSelectedExamId(item.id);
    setComparison({ examId: item.id, previousId: anterior.id });
  };

  const verExamen = (item: PeriodontalExamSummary): void => {
    setSelectedExamId(item.id);
    setComparison(null);
  };

  const volverAlExamenActivo = (): void => {
    // Si hay cambios sin guardar, el navegador ya avisa al cerrar; volver deja el
    // borrador local intacto (no se recarga el servidor sobre él).
    setSelectedExamId(null);
    setComparison(null);
  };

  const irAImprimir = (examId: string): string =>
    printHref === undefined ? rutaImpresionPorDefecto(patientId, examId) : printHref(examId);

  /* ── Datos derivados de la vista ──────────────────────────────────────────── */

  const chartVista = editable ? (controllerState?.chart ?? null) : (vistaExam?.chart ?? null);
  const riskVista = editable
    ? (controllerState?.riskFactors ?? null)
    : (vistaExam?.riskFactors ?? null);
  const analisisVista = useMemo(() => {
    if (chartVista === null || riskVista === null) return null;
    return analyzePeriodontalChart(chartVista, riskVista);
  }, [chartVista, riskVista]);

  const comparisonData: PeriodontalComparison | null = comparisonQuery.data?.comparison ?? null;
  const comparisonExam = comparisonQuery.data?.current ?? null;
  const comparisonPrevious = comparisonQuery.data?.previous ?? null;
  const comparisonIndex = useMemo(() => comparisonSiteIndex(comparisonData), [comparisonData]);

  /**
   * Boca del examen anterior para la línea punteada del gráfico. La comparación trae
   * el snapshot por sitio, así que se reconstruye sin pedir el examen completo.
   */
  const previousChart = useMemo<PeriodontalTooth[] | null>(() => {
    if (comparisonData === null) return null;
    const chart = buildPeriodontalChart();
    for (const diff of comparisonData.sites) {
      const tooth = chart.find((item) => item.fdi === diff.fdi);
      if (tooth === undefined || diff.previous === null) continue;
      const sitios = diff.side === 'vestibular' ? tooth.vestibular : tooth.lingual;
      sitios[diff.index] = {
        ...sitios[diff.index],
        pd: diff.previous.pd,
        gm: diff.previous.gm,
        bop: diff.previous.bop,
      };
    }
    return chart;
  }, [comparisonData]);

  const enComparacion = comparison !== null && comparisonData !== null && selectedExamId !== null;

  /** Diagnóstico visible (borrador local o examen guardado). */
  const diagnosisVista = editable
    ? (controllerState?.diagnosis ?? null)
    : (vistaExam?.diagnosis ?? null);
  const notasVista = editable ? (controllerState?.notes ?? null) : (vistaExam?.notes ?? null);
  const fechaVista = editable ? (controllerState?.examDate ?? '') : (vistaExam?.examDate ?? '');

  const guardandoTexto = (): string => {
    switch (saveStatus) {
      case 'pendiente':
        return t('periodonto.guardado.pendiente');
      case 'guardando':
        return t('periodonto.guardado.guardando');
      case 'guardado':
        return t('periodonto.guardado.guardado');
      case 'error':
        return t('periodonto.guardado.error');
      case 'conflicto':
        return t('periodonto.guardado.conflicto');
      default:
        return t('periodonto.guardado.inactivo');
    }
  };

  /**
   * Aplica estadio y grado juntos: el contrato exige los dos para firmar un
   * diagnóstico, así que elegir solo uno deja la clasificación como «sin firmar».
   */
  const loAplicarDiagnostico = (
    stage: PeriodontalStage | null,
    grade: PeriodontalGrade | null,
    notas?: string | null,
  ): void => {
    if (stage === null || grade === null) {
      controller.setDiagnosis(null);
      return;
    }
    controller.setDiagnosis({
      stage,
      grade,
      notes: notas === undefined ? (controllerState?.diagnosis?.notes ?? null) : notas,
    });
  };

  // Las arcadas se memoizan: el SVG está envuelto en memo y con 16 piezas × 6
  // sitios por arcada un re-render completo en cada toque se nota en una tablet.
  const archivos = useMemo(
    () => [
      {
        arch: 'maxilar' as const,
        teeth: (chartVista ?? []).filter((tooth) => PERIODONTAL_UPPER_TEETH.includes(tooth.fdi)),
      },
      {
        arch: 'mandibula' as const,
        teeth: (chartVista ?? []).filter((tooth) => PERIODONTAL_LOWER_TEETH.includes(tooth.fdi)),
      },
    ],
    [chartVista],
  );
  const cursor = controllerState?.cursor ?? null;
  const sitioActivo = useMemo(
    () =>
      editable && cursor !== null
        ? { fdi: cursor.fdi, side: cursor.side, siteIndex: cursor.siteIndex }
        : null,
    [editable, cursor],
  );
  // Las acciones del hook son estables (useCallback interno): se usan como
  // dependencias para que el memo de las arcadas y de la tabla no se anule.
  const {
    selectSite: seleccionarSitioAccion,
    cycleMobility: ciclarMovilidadAccion,
    cycleFurcation: ciclarFurcaAccion,
  } = controller;
  const seleccionarSitio = useCallback(
    (fdi: number, side: PeriodontalSide, siteIndex: PeriodontalSiteIndex) =>
      seleccionarSitioAccion(fdi, side, siteIndex),
    [seleccionarSitioAccion],
  );
  const ciclarMovilidad = useCallback(
    (fdi: number) => ciclarMovilidadAccion(fdi),
    [ciclarMovilidadAccion],
  );
  const ciclarFurca = useCallback(
    (fdi: number, entrance?: FurcationEntrance) => ciclarFurcaAccion(fdi, entrance),
    [ciclarFurcaAccion],
  );

  /* ── Carga / error / vacío ────────────────────────────────────────────────── */

  if (latestQuery.isLoading) {
    return (
      <Card>
        <CardContent className="grid place-items-center py-10">
          <Spinner size="lg" showLabel label={t('periodonto.comun.cargando')} />
        </CardContent>
      </Card>
    );
  }

  if (latestQuery.isError || latestQuery.data === undefined) {
    return (
      <Alert variant="danger" title={t('periodonto.error.titulo')}>
        {apiErrorMessage(latestQuery.error)}
      </Alert>
    );
  }

  const sinExamen = latestQuery.data.exists !== true;
  if (sinExamen && selectedExamId === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('periodonto.titulo')}</CardTitle>
          <p className="mt-0.5 text-sm text-ink-muted">{t('periodonto.descripcion')}</p>
        </CardHeader>
        <CardContent>
          <NoticeBanner notice={notice} onClose={limpiar} className="mb-4" />
          <EmptyState
            icon={<Stethoscope className="size-6" aria-hidden />}
            title={t('periodonto.sinExamen.titulo')}
            description={t('periodonto.sinExamen.texto')}
            action={
              canWrite ? (
                <Button
                  loading={creando}
                  onClick={() => void crearExamen('odontograma')}
                  leadingIcon={<Plus className="size-4" aria-hidden />}
                >
                  {t('periodonto.abrir')}
                </Button>
              ) : undefined
            }
          />
          {!canWrite && (
            <p className="mt-4 text-sm text-ink-muted">{t('periodonto.soloLectura')}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  if (vistaCargando) {
    return (
      <Card>
        <CardContent className="grid place-items-center py-10">
          <Spinner size="lg" showLabel label={t('periodonto.comun.cargando')} />
        </CardContent>
      </Card>
    );
  }

  if (vistaError !== null && vistaError !== undefined) {
    return (
      <Alert variant="danger" title={t('periodonto.error.titulo')}>
        {apiErrorMessage(vistaError)}
      </Alert>
    );
  }

  if (vistaExam === null) {
    return (
      <Card>
        <CardContent className="py-8">
          <EmptyState
            title={t('periodonto.sinExamen.titulo')}
            description={t('periodonto.sinExamen.texto')}
          />
          <div className="mt-4 flex justify-center">
            <Button
              variant="secondary"
              onClick={volverAlExamenActivo}
              leadingIcon={<ChevronLeft className="size-4" aria-hidden />}
            >
              {t('periodonto.comun.volver')}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const metricsVista = analisisVista?.metrics ?? vistaExam.metrics;
  const suggestionVista = analisisVista?.suggestion ?? null;

  /** Estilos de las tarjetas de KPI: el tono no es el único indicador (lleva texto). */
  const tonoKpi: Record<string, string> = {
    neutral: 'border-border bg-surface',
    success: 'border-success/30 bg-success/5',
    warning: 'border-warning/30 bg-warning/5',
    danger: 'border-danger/30 bg-danger/5',
    info: 'border-info/30 bg-info/5',
  };

  return (
    <Card>
      <CardHeader className="flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>{t('periodonto.titulo')}</CardTitle>
          <p className="mt-0.5 text-sm text-ink-muted">{t('periodonto.descripcion')}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
            <Badge variant={vistaExam.status === 'borrador' ? 'warning' : 'success'}>
              {examStatusLabel(vistaExam.status)}
            </Badge>
            <span>
              {t('periodonto.examen.fecha', { fecha: examDateLabel(fechaVista) })} ·{' '}
              {t('periodonto.examen.revision', {
                revision: editable ? revision : vistaExam.revision,
              })}
            </span>
            {vistaExam.recordedByUsername !== null && (
              <span>
                {t('periodonto.examen.registradoPor', { usuario: vistaExam.recordedByUsername })}
              </span>
            )}
            {vistaExam.printCount > 0 && (
              <span>{t('periodonto.examen.impreso', { veces: vistaExam.printCount })}</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!controller.canUndo}
              onClick={controller.undo}
              leadingIcon={<Undo2 className="size-4" aria-hidden />}
            >
              {t('periodonto.pad.deshacer')}
            </Button>
          )}
          {editable && (
            <Button
              size="sm"
              onClick={() => setDialogo('finalizar')}
              leadingIcon={<ClipboardList className="size-4" aria-hidden />}
            >
              {t('periodonto.finalizar.accion')}
            </Button>
          )}
          {editable && (
            <Button variant="secondary" size="sm" onClick={() => setDialogo('descartar')}>
              {t('periodonto.descartar.accion')}
            </Button>
          )}
          {!editable && canWrite && (
            <Button
              size="sm"
              onClick={() => setDialogo('nuevo')}
              leadingIcon={<Plus className="size-4" aria-hidden />}
            >
              {t('periodonto.nuevo')}
            </Button>
          )}
          <a
            className="inline-flex min-h-9 items-center gap-2 rounded-control border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted"
            href={irAImprimir(vistaExam.id)}
            target="_blank"
            rel="noreferrer"
          >
            <Printer className="size-4" aria-hidden />
            {t('periodonto.imprimir.accion')}
          </a>
          {selectedExamId !== null && (
            <Button
              variant="ghost"
              size="sm"
              onClick={volverAlExamenActivo}
              leadingIcon={<ChevronLeft className="size-4" aria-hidden />}
            >
              {t('periodonto.comun.volver')}
            </Button>
          )}
        </div>
      </CardHeader>

      {/* El teclado físico es secundario pero único: los eventos burbujean desde el
          SVG, la tabla y el pad hasta aquí y el controlador decide qué hacer. */}
      <CardContent
        className="space-y-5"
        onKeyDown={(event) => {
          const target = event.target;
          controller.handleKeyDown(event, {
            // El propio contenedor del pad enfocado habilita Tab como avance de sitio.
            containerFocused:
              target instanceof HTMLElement && target.hasAttribute('data-periodontal-pad'),
          });
        }}
      >
        <NoticeBanner notice={notice} onClose={limpiar} className="mb-0" />

        {editable && (
          <p
            aria-live="polite"
            className={`text-xs ${saveStatus === 'error' || saveStatus === 'conflicto' ? 'font-medium text-danger' : 'text-ink-subtle'}`}
          >
            {guardandoTexto()}
            {hayCambios ? ` · ${t('periodonto.guardado.avisoSalir')}` : ''}
          </p>
        )}
        {!editable && (
          <p className="rounded-control border border-border bg-surface-muted px-3 py-2 text-sm text-ink-muted">
            {selectedExamId !== null
              ? t('periodonto.soloLecturaExamen')
              : t('periodonto.soloLectura')}
          </p>
        )}

        {/* Comparación longitudinal: resumen de deltas arriba del gráfico. */}
        {comparison !== null && (
          <section className="rounded-card border border-border bg-surface-muted/50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <GitCompareArrows className="size-4 text-primary" aria-hidden />
                {t('periodonto.comparacion.titulo')}
                {comparisonExam !== null && comparisonPrevious !== null && (
                  <span className="text-xs font-normal text-ink-muted">
                    {t('periodonto.comparar.con', {
                      fecha: examDateLabel(comparisonPrevious.examDate),
                    })}
                  </span>
                )}
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  {t('periodonto.comparar.anterior')}
                  <Select
                    className="min-w-44"
                    value={comparison.previousId}
                    onChange={(event) =>
                      setComparison({ examId: comparison.examId, previousId: event.target.value })
                    }
                  >
                    {candidatosComparacion
                      .filter((item) => item.id !== comparison.examId)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {examDateLabel(item.examDate)} · {examStatusLabel(item.status)}
                        </option>
                      ))}
                  </Select>
                </label>
                <Button variant="ghost" size="sm" onClick={() => setComparison(null)}>
                  {t('periodonto.comparacion.cerrar')}
                </Button>
              </div>
            </div>
            {comparisonQuery.isLoading && (
              <p className="mt-2 text-xs text-ink-subtle">{t('periodonto.comparacion.cargando')}</p>
            )}
            {comparisonQuery.isError && (
              <Alert variant="warning" className="mt-2">
                {apiErrorMessage(comparisonQuery.error)}
              </Alert>
            )}
            {comparisonData !== null && (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {comparisonKpiItems(comparisonData.summary).map((item) => (
                    <div
                      key={item.key}
                      className={`rounded-control border px-2.5 py-2 ${tonoKpi[item.tone] ?? tonoKpi.neutral}`}
                    >
                      <p className="text-[0.65rem] tracking-wide text-ink-subtle uppercase">
                        {item.label}
                      </p>
                      <p className="font-mono text-base font-semibold text-ink">{item.value}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-2 flex flex-wrap gap-x-4 text-[0.7rem] text-ink-subtle">
                  {(['mejoro', 'empeoro', 'estable'] as const).map((change) => (
                    <span key={change} className="inline-flex items-center gap-1">
                      <span
                        className="inline-block size-2 rounded-full"
                        style={{ backgroundColor: changeColor(change) }}
                        aria-hidden
                      />
                      {changeLabel(change)}
                    </span>
                  ))}
                  <span>{t('periodonto.comparacion.leyenda')}</span>
                </p>
              </>
            )}
          </section>
        )}

        {/* KPIs en vivo. */}
        <section aria-label={t('periodonto.kpi.titulo')}>
          <h3 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
            {t('periodonto.kpi.titulo')}
          </h3>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {kpiItems(metricsVista).map((item) => (
              <div
                key={item.key}
                className={`rounded-control border px-2.5 py-2 ${tonoKpi[item.tone] ?? tonoKpi.neutral}`}
              >
                <p className="text-[0.65rem] tracking-wide text-ink-subtle uppercase">
                  {item.label}
                </p>
                <p className="font-mono text-base font-semibold text-ink">{item.value}</p>
                {item.hint !== undefined && (
                  <p className="text-[0.62rem] text-ink-subtle">{item.hint}</p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Sugerencia AAP/EFP (ayuda, no diagnóstico firmado). */}
        {suggestionVista !== null && (
          <section className="rounded-card border border-primary/30 bg-primary/5 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-ink">
                  {t('periodonto.sugerencia.titulo')}
                </h3>
                <p className="mt-0.5 text-xs text-ink-muted">{t('periodonto.sugerencia.ayuda')}</p>
                <p className="mt-1 text-sm text-ink">{suggestionText(suggestionVista)}</p>
              </div>
              {editable && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={suggestionVista.stage === null}
                  onClick={controller.applySuggestion}
                >
                  {t('periodonto.sugerencia.usar')}
                </Button>
              )}
            </div>
          </section>
        )}

        {/* Las dos arcadas, con el mismo SVG que imprime el documento. */}
        <section aria-label={t('periodonto.grafico.titulo')} className="space-y-3">
          {/* Una sola barra de desplazamiento para las dos arcadas: así se mueven
              juntas y los dientes de arriba y de abajo siguen alineados. */}
          <div
            className="space-y-3 overflow-x-auto overscroll-x-contain pb-1"
            tabIndex={0}
            role="group"
            aria-label={t('periodonto.grafico.desplazarAria')}
          >
            {archivos.map(({ arch, teeth }) =>
              chartVista === null ? null : (
                <PeriodontogramArchSvg
                  key={arch}
                  arch={arch}
                  teeth={teeth}
                  readOnly={!editable}
                  active={sitioActivo}
                  comparison={enComparacion ? comparisonIndex : null}
                  previous={enComparacion ? previousChart : null}
                  onSelectSite={seleccionarSitio}
                  onSelectTooth={controller.selectTooth}
                  onCycleMobility={ciclarMovilidad}
                  onCycleFurcation={ciclarFurca}
                  minWidth={GRAFICO_ANCHO_MINIMO}
                />
              ),
            )}
          </div>
          <p className="text-xs text-ink-subtle">
            {t('periodonto.grafico.leyenda')} {t('periodonto.grafico.desplazar')}
          </p>
        </section>

        {/* Pad táctil: siempre debajo del gráfico, cómodo para el pulgar. */}
        {editable && controllerState !== null && (
          <ProbingTouchPad
            state={controllerState}
            canUndo={controller.canUndo}
            onSelectSite={(side, siteIndex) =>
              controller.selectSite(controllerState.cursor.fdi, side, siteIndex)
            }
            onPreviousTooth={() => controller.move('previousTooth')}
            onNextTooth={() => controller.move('nextTooth')}
            onField={(field: PeriodontalField) => controller.setField(field)}
            onMillimeters={(value) => controller.applyMillimeters(value)}
            onToggleSign={controller.toggleSign}
            onToggleFlag={(flag: PeriodontalSiteFlag) => controller.toggleFlag(flag)}
            onCycleMobility={() => controller.cycleMobility()}
            onCycleFurcation={(entrance) => controller.cycleFurcation(undefined, entrance)}
            onToggleMissing={() => controller.toggleMissing()}
            onToggleImplant={() => controller.toggleImplant()}
            onClearSite={controller.clearSite}
            onUndo={controller.undo}
            onAutoAdvance={controller.setAutoAdvanceMode}
          />
        )}

        {/* Tabla numérica de los 192 sitios. */}
        <section aria-label={t('periodonto.tabla.titulo')} className="space-y-2">
          <h3 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
            {t('periodonto.tabla.titulo')}
          </h3>
          {chartVista === null ? null : (
            <>
              {archivos.map(({ arch, teeth }) => (
                <div key={`tabla-${arch}`}>
                  <h4 className="mb-1 text-sm font-medium text-ink">
                    {arch === 'maxilar'
                      ? t('periodonto.arcada.maxilar')
                      : t('periodonto.arcada.mandibula')}
                  </h4>
                  <PeriodontogramSitesTable
                    arch={arch}
                    teeth={teeth}
                    readOnly={!editable}
                    active={sitioActivo}
                    comparison={enComparacion ? comparisonIndex : null}
                    onSelectSite={seleccionarSitio}
                  />
                </div>
              ))}
            </>
          )}
        </section>

        {/* Diagnóstico y factores de riesgo. */}
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-card border border-border p-3">
            <h3 className="text-sm font-semibold text-ink">{t('periodonto.diagnostico.titulo')}</h3>
            {editable && controllerState !== null ? (
              <div className="mt-2 space-y-2">
                <label className="block text-sm text-ink-muted">
                  {t('periodonto.diagnostico.estadio')}
                  <Select
                    className="mt-1"
                    value={
                      controllerState.diagnosis === null
                        ? ''
                        : String(controllerState.diagnosis.stage)
                    }
                    onChange={(event) => {
                      const valor = event.target.value;
                      const stage = valor === '' ? null : (Number(valor) as PeriodontalStage);
                      loAplicarDiagnostico(stage, controllerState.diagnosis?.grade ?? null);
                    }}
                  >
                    <option value="">{t('periodonto.diagnostico.sinClasificar')}</option>
                    {[1, 2, 3, 4].map((stage) => (
                      <option key={stage} value={stage}>
                        {stageLabel(stage as PeriodontalStage)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="block text-sm text-ink-muted">
                  {t('periodonto.diagnostico.grado')}
                  <Select
                    className="mt-1"
                    value={controllerState.diagnosis?.grade ?? ''}
                    onChange={(event) => {
                      const valor = event.target.value;
                      const grade = valor === '' ? null : (valor as PeriodontalGrade);
                      loAplicarDiagnostico(controllerState.diagnosis?.stage ?? null, grade);
                    }}
                  >
                    <option value="">{t('periodonto.diagnostico.sinClasificar')}</option>
                    {(['A', 'B', 'C'] as const).map((grade) => (
                      <option key={grade} value={grade}>
                        {gradeLabel(grade)}
                      </option>
                    ))}
                  </Select>
                </label>
                {controllerState.diagnosis === null && (
                  <p className="text-xs text-ink-subtle">
                    {t('periodonto.diagnostico.incompleto')}
                  </p>
                )}
                <label className="block text-sm text-ink-muted">
                  {t('periodonto.diagnostico.notas')}
                  <Textarea
                    className="mt-1 min-h-20"
                    maxLength={1000}
                    value={controllerState.diagnosis?.notes ?? ''}
                    placeholder={t('periodonto.diagnostico.notasAyuda')}
                    onChange={(event) => {
                      const notas = event.target.value.trim() === '' ? null : event.target.value;
                      if (controllerState.diagnosis === null) return;
                      loAplicarDiagnostico(
                        controllerState.diagnosis.stage,
                        controllerState.diagnosis.grade,
                        notas,
                      );
                    }}
                  />
                </label>
              </div>
            ) : (
              <div className="mt-2 space-y-1 text-sm text-ink">
                {diagnosisVista === null ? (
                  <p className="text-ink-muted">{t('periodonto.diagnostico.sinClasificar')}</p>
                ) : (
                  <>
                    <p>
                      {stageLabel(diagnosisVista.stage)} · {gradeLabel(diagnosisVista.grade)}
                    </p>
                    {diagnosisVista.notes !== null && (
                      <p className="text-ink-muted">{diagnosisVista.notes}</p>
                    )}
                  </>
                )}
              </div>
            )}
          </section>

          <section className="rounded-card border border-border p-3">
            <h3 className="text-sm font-semibold text-ink">{t('periodonto.riesgo.titulo')}</h3>
            {editable && controllerState !== null ? (
              <div className="mt-2 space-y-2">
                <label className="block text-sm text-ink-muted">
                  {t('periodonto.riesgo.tabaco')}
                  <Select
                    className="mt-1"
                    value={controllerState.riskFactors.smoking}
                    onChange={(event) =>
                      controller.setRiskFactors({
                        ...controllerState.riskFactors,
                        smoking: event.target.value as PeriodontalRiskFactors['smoking'],
                      })
                    }
                  >
                    {(['no', 'menos10', 'mas10'] as const).map((nivel) => (
                      <option key={nivel} value={nivel}>
                        {smokingLabel(nivel)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="block text-sm text-ink-muted">
                  {t('periodonto.riesgo.diabetes')}
                  <Select
                    className="mt-1"
                    value={controllerState.riskFactors.diabetes}
                    onChange={(event) =>
                      controller.setRiskFactors({
                        ...controllerState.riskFactors,
                        diabetes: event.target.value as PeriodontalRiskFactors['diabetes'],
                      })
                    }
                  >
                    {(['no', 'controlada', 'descontrolada'] as const).map((nivel) => (
                      <option key={nivel} value={nivel}>
                        {diabetesLabel(nivel)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="block text-sm text-ink-muted">
                  {t('periodonto.riesgo.hba1c')}
                  <Input
                    className="mt-1"
                    type="text"
                    inputMode="decimal"
                    value={hba1cText}
                    placeholder={t('periodonto.riesgo.hba1cAyuda')}
                    onChange={(event) => {
                      setHba1cText(event.target.value);
                      const numero = Number(event.target.value.replace(',', '.'));
                      if (Number.isFinite(numero) && numero >= 3 && numero <= 20) {
                        controller.setRiskFactors({
                          ...controllerState.riskFactors,
                          hba1c: numero,
                        });
                      }
                    }}
                    onBlur={() => {
                      const hba1c = controllerState.riskFactors.hba1c;
                      setHba1cText(hba1c === null ? '' : String(hba1c));
                    }}
                  />
                </label>
              </div>
            ) : (
              <div className="mt-2 space-y-1 text-sm">
                {riskVista !== null && <p className="text-ink">{riskFactorsText(riskVista)}</p>}
              </div>
            )}
            <label className="mt-3 block text-sm text-ink-muted">
              {t('periodonto.examen.notas')}
              {editable ? (
                <Textarea
                  className="mt-1 min-h-20"
                  maxLength={2000}
                  value={controllerState?.notes ?? ''}
                  placeholder={t('periodonto.examen.notasAyuda')}
                  onChange={(event) => controller.setNotes(event.target.value)}
                />
              ) : (
                <span className="mt-1 block rounded-control border border-border bg-surface-muted px-3 py-2 text-sm text-ink">
                  {notasVista ?? t('periodonto.examen.sinNotas')}
                </span>
              )}
            </label>
          </section>
        </div>

        {/* Fecha del examen (editable en el borrador). */}
        {editable && controllerState !== null && (
          <label className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <CalendarDays className="size-4" aria-hidden />
            {t('periodonto.examen.fechaEditable')}
            <Input
              type="date"
              className="w-44"
              value={controllerState.examDate}
              onChange={(event) => controller.setExamDate(event.target.value)}
            />
          </label>
        )}

        {/* Lista de exámenes con sus acciones. */}
        <section aria-label={t('periodonto.examen.lista.titulo')}>
          <h3 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
            {t('periodonto.examen.lista.titulo')}
          </h3>
          {listQuery.isLoading && (
            <p className="mt-2 text-sm text-ink-subtle">{t('periodonto.comun.cargando')}</p>
          )}
          {listQuery.isError && (
            <Alert variant="warning" className="mt-2">
              {apiErrorMessage(listQuery.error)}
            </Alert>
          )}
          {listQuery.data !== undefined && listQuery.data.items.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">{t('periodonto.examen.lista.vacia')}</p>
          )}
          <ul className="mt-2 space-y-2">
            {(listQuery.data?.items ?? []).map((item) => {
              const anterior = anteriorDe(item.id);
              const esActivo = examActivo?.id === item.id;
              return (
                <li
                  key={item.id}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-control border px-3 py-2 ${
                    esActivo ? 'border-primary/40 bg-primary/5' : 'border-border bg-surface'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                      {examDateLabel(item.examDate)}
                      <Badge variant={item.status === 'borrador' ? 'warning' : 'success'}>
                        {examStatusLabel(item.status)}
                      </Badge>
                      {esActivo && (
                        <Badge variant="primary">{t('periodonto.examen.enEdicion')}</Badge>
                      )}
                      <span className="text-xs font-normal text-ink-subtle">
                        {t('periodonto.examen.revision', { revision: item.revision })}
                      </span>
                    </p>
                    <p className="text-xs text-ink-muted">
                      {t('periodonto.examen.lista.resumen', {
                        bop:
                          item.metrics.bopPercent === null
                            ? t('comun.sinDato')
                            : `${String(item.metrics.bopPercent)} %`,
                        ps:
                          item.metrics.deepestPd === null
                            ? t('comun.sinDato')
                            : `${String(item.metrics.deepestPd)} mm`,
                        bolsas: item.metrics.pocketsGte5,
                      })}
                      {item.recordedByUsername !== null
                        ? ` · ${t('periodonto.examen.registradoPor', { usuario: item.recordedByUsername })}`
                        : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => verExamen(item)}
                      disabled={selectedExamId === item.id && comparison === null}
                    >
                      {t('periodonto.examen.abrir')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => abrirComparacion(item)}
                      disabled={anterior === null}
                      title={
                        anterior === null ? t('periodonto.comparacion.sinAnterior') : undefined
                      }
                    >
                      {t('periodonto.examen.comparar')}
                    </Button>
                    <a
                      className="inline-flex min-h-8 items-center gap-1 rounded-control px-2 py-1 text-sm font-medium text-ink hover:bg-surface-muted"
                      href={irAImprimir(item.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Printer className="size-3.5" aria-hidden />
                      {t('periodonto.examen.imprimir')}
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </CardContent>

      {/* Diálogos de confirmación: finalizar y descartar no se hacen por accidente. */}
      <Dialog
        open={dialogo === 'finalizar'}
        onClose={() => setDialogo(null)}
        title={t('periodonto.finalizar.confirmar.titulo')}
        description={t('periodonto.finalizar.confirmar.texto')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogo(null)}>
              {t('comun.cancelar')}
            </Button>
            <Button loading={finalizando} onClick={() => void finalizarExamen()}>
              {t('periodonto.finalizar.accion')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">{t('periodonto.finalizar.confirmar.detalle')}</p>
      </Dialog>

      <Dialog
        open={dialogo === 'descartar'}
        onClose={() => setDialogo(null)}
        title={t('periodonto.descartar.titulo')}
        description={t('periodonto.descartar.texto')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogo(null)}>
              {t('comun.cancelar')}
            </Button>
            <Button variant="danger" loading={descartando} onClick={() => void descartarExamen()}>
              {t('periodonto.descartar.accion')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">{t('periodonto.descartar.detalle')}</p>
      </Dialog>

      <Dialog
        open={dialogo === 'nuevo'}
        onClose={() => setDialogo(null)}
        title={t('periodonto.nuevo')}
        description={t('periodonto.nuevo.descripcion')}
        footer={
          <Button variant="ghost" onClick={() => setDialogo(null)}>
            {t('comun.cerrar')}
          </Button>
        }
      >
        <div className="space-y-2">
          <Button
            variant="secondary"
            loading={creando}
            onClick={() => void crearExamen('anterior')}
            disabled={examActivo?.status !== 'finalizado' && previousFinalized === null}
            className="w-full justify-start"
          >
            {t('periodonto.nuevo.clonar')}
          </Button>
          <p className="text-xs text-ink-subtle">{t('periodonto.nuevo.clonarAyuda')}</p>
          <Button
            variant="secondary"
            loading={creando}
            onClick={() => void crearExamen('blanco')}
            className="w-full justify-start"
          >
            {t('periodonto.nuevo.enBlanco')}
          </Button>
          <p className="text-xs text-ink-subtle">{t('periodonto.nuevo.enBlancoAyuda')}</p>
          <Button
            variant="secondary"
            loading={creando}
            onClick={() => void crearExamen('odontograma')}
            className="w-full justify-start"
          >
            {t('periodonto.nuevo.desdeOdontograma')}
          </Button>
          <p className="text-xs text-ink-subtle">{t('periodonto.nuevo.desdeOdontogramaAyuda')}</p>
        </div>
      </Dialog>
    </Card>
  );
};
