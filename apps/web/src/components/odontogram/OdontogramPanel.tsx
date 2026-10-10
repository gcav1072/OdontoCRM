import {
  CONDITION_LABELS,
  archOfTooth,
  archRange,
  archTeeth,
  initialQuickEntryState,
  isPrimaryTooth,
  odontogramSummary,
  surfaceLabelFor,
} from '@odontocrm/contracts';
import type {
  Dentition,
  OdontogramDetail,
  OdontogramLookup,
  OdontogramMutationResult,
  ProsthesisArch,
  ProsthesisKind,
  ProsthesisRecord,
  QuickEntryState,
  ToothFindingRecord,
  ToothSurface,
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
  Checkbox,
  Spinner,
  buttonClasses,
} from '@odontocrm/ui';
import { Hand, History, Keyboard, Layers, Printer, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useNotice } from '../../hooks/useNotice';
import { apiErrorMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { t } from '../../lib/i18n';
import { dentitionLabel, findingsForTooth, odontogramApi } from '../../lib/odontogram-api';
import { NoticeBanner } from '../NoticeBanner';
import { OdontogramChart } from './OdontogramChart';
import { pressIntent } from './press-intent';
import { ProsthesisDialog } from './ProsthesisDialog';
import { QuickEntryBar, describeAction } from './QuickEntryBar';
import type { QuickEntryAction } from './QuickEntryBar';
import { ToothFindingSheet } from './ToothFindingSheet';

/**
 * El odontograma del paciente: **se captura por toques** (pulsar una pieza abre su
 * hoja de botones), con un **modo teclado** avanzado opt-in, el deshacer y los
 * avisos.
 *
 * Es **autocontenido** a propósito: recibe el paciente y hace sus propias
 * lecturas y mutaciones, de modo que la pestaña que lo monte no necesite saber
 * nada del odontograma. Después de cada cambio actualiza la caché con el
 * odontograma que devuelve la API (`setQueryData`), sin esperar a un refetch.
 *
 * El gesto es el mismo en todos los dispositivos: pulsar una pieza abre su hoja. Si
 * el toque acierta una cara (con ratón), entra marcada; con el dedo, la precisión la
 * da la hoja.
 */

/** Clave de caché del odontograma de un paciente: la comparten panel e histórico. */
export const odontogramQueryKey = (patientId: string) => ['odontograma', patientId] as const;

/** Boca sin hallazgos: sirve para pintar y resumir cuando el odontograma no existe. */
const BOCA_VACIA: Pick<OdontogramDetail, 'findings' | 'dentition'> = {
  findings: {},
  dentition: 'permanente',
};

/** Cuántos cambios se pueden deshacer hacia atrás. */
const MAX_UNDO = 20;

/**
 * Un cambio deshacible: de una **pieza** (sus hallazgos) o de una **prótesis** (las de
 * la boca). El deshacer guarda el estado **entero** antes del cambio para reponerlo.
 */
type UndoEntry =
  | {
      kind: 'pieza';
      toothNumber: number;
      /** Hallazgos que tenía la pieza **justo antes** del cambio. */
      snapshot: readonly ToothFindingRecord[];
      /** Frase del cambio, para el botón de deshacer. */
      descripcion: string;
    }
  | {
      kind: 'protesis';
      /** Prótesis que había **justo antes** del cambio. */
      snapshot: readonly ProsthesisRecord[];
      descripcion: string;
    };

export interface OdontogramPanelProps {
  patientId: string;
  /** Escribir exige `odontogram:write`; sin permiso el panel es de solo lectura. */
  canWrite?: boolean;
  /**
   * Sesión clínica abierta (Fase 7): cada hallazgo queda ligado a la sesión en la
   * que se registró, que es lo que después agrupa la evolución por visita. Sin
   * sesión abierta el hallazgo se guarda igual, con la sesión en blanco.
   */
  sessionId?: string | null;
}

export const OdontogramPanel = ({
  patientId,
  canWrite = false,
  sessionId = null,
}: OdontogramPanelProps) => {
  const queryClient = useQueryClient();
  const { notice, mostrar, exito, error, limpiar } = useNotice();
  /**
   * La captura por defecto es **por toques**: pulsar una pieza abre su hoja de
   * botones. El teclado queda como **modo avanzado**, opt-in.
   */
  const [modoTeclado, setModoTeclado] = useState(false);

  const [quick, setQuick] = useState<QuickEntryState>(initialQuickEntryState);
  const [pila, setPila] = useState<readonly UndoEntry[]>([]);
  const [pendientes, setPendientes] = useState(0);
  const [deshaciendo, setDeshaciendo] = useState(false);
  const [foco, setFoco] = useState(0);
  /**
   * Pieza cuya hoja de botones está abierta, con las caras que se marcan al abrir
   * (la cara que se pulsó en el gráfico, si la hubo).
   */
  const [hoja, setHoja] = useState<{ tooth: number; surfaces: readonly ToothSurface[] } | null>(
    null,
  );
  /**
   * Borrador de prótesis abierto en la ficha: tipo, arcada y piezas del tramo (PPR) o
   * de la arcada completa (PRT). La ficha se abre desde la barra (PRT) o tras el
   * segundo toque del tramo (PPR).
   */
  const [protesis, setProtesis] = useState<{
    kind: ProsthesisKind;
    arch: ProsthesisArch;
    toothNumbers: number[];
  } | null>(null);
  /** Prótesis ya registrada que se está editando (si la ficha se abrió desde el gráfico). */
  const [protesisExistente, setProtesisExistente] = useState<ProsthesisRecord | null>(null);
  /** Modo «tramo de PPR»: la próxima pulsación elige la primera pieza y la siguiente la última. */
  const [modoPpr, setModoPpr] = useState(false);
  /** Primera pieza del tramo de PPR ya elegida, o `null` si toca elegirla. */
  const [pprInicio, setPprInicio] = useState<number | null>(null);
  /** Menú de la prótesis total (PRT): elige la arcada. */
  const [menuPrt, setMenuPrt] = useState(false);
  /**
   * Casilla «Activar dentición temporal»: `null` = automático (la pone la boca),
   * `true`/`false` = la decisión explícita de quien la pulsa. No se persiste: al
   * cambiar de paciente vuelve al automático.
   */
  const [temporalManual, setTemporalManual] = useState<boolean | null>(null);

  const queryKey = odontogramQueryKey(patientId);

  const odontogramaQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => odontogramApi.byPatient(patientId, signal),
  });

  // Cambiar de paciente deja la carga rápida limpia: la pieza activa era de la
  // boca anterior y la pila de deshacer ya no vale.
  useEffect(() => {
    setQuick(initialQuickEntryState());
    setPila([]);
    setPendientes(0);
    setHoja(null);
    setProtesis(null);
    setProtesisExistente(null);
    setModoPpr(false);
    setPprInicio(null);
    setTemporalManual(null);
    limpiar();
  }, [patientId, limpiar]);

  /** Odontograma vigente en la caché; es la referencia para apilar el deshacer. */
  const detalleActual = (): OdontogramDetail | null => {
    const datos = queryClient.getQueryData<OdontogramLookup>(queryKey);
    return datos?.exists === true ? datos.odontogram : null;
  };

  const aplicarResultado = (result: OdontogramMutationResult): void => {
    const siguiente: OdontogramLookup = { exists: true, odontogram: result.odontogram };
    queryClient.setQueryData(queryKey, siguiente);
  };

  const aplicar = (result: OdontogramMutationResult, action: QuickEntryAction): void => {
    const anterior = detalleActual();
    const pieza = action.input.toothNumber;
    aplicarResultado(result);
    apilar({
      toothNumber: pieza,
      anterior,
      resultado: result,
      descripcion: describeAction(action),
    });

    const condicion = action.kind === 'record' ? action.input.condition : null;

    if (result.resolvedSurfaces.length > 0 && condicion !== null) {
      mostrar({
        variant: 'warning',
        title: t('odonto.aviso.carasSuperadas.titulo'),
        message: t('odonto.aviso.carasSuperadas', {
          pieza,
          condicion: CONDITION_LABELS[condicion].toLowerCase(),
          // La cara se nombra con la pieza delante: en un incisivo o un canino la de
          // masticación es el borde incisal, no la oclusal.
          caras: result.resolvedSurfaces
            .map((surface) => surfaceLabelFor(pieza, surface).toLowerCase())
            .join(', '),
        }),
      });
      return;
    }

    if (result.unchanged) {
      mostrar({ variant: 'info', message: t('odonto.aviso.sinCambios', { pieza }) });
      return;
    }

    exito(t('odonto.exito.cambiado', { accion: describeAction(action) }));
  };

  /**
   * Apila un cambio para poder deshacerlo. Guarda la pieza **entera** antes del
   * cambio: así deshacer repone también las caras que `ausente` dio por superadas.
   */
  const apilar = (input: {
    toothNumber: number;
    anterior: OdontogramDetail | null;
    resultado: OdontogramMutationResult;
    descripcion: string;
  }): void => {
    if (input.resultado.unchanged) return;
    setPila((actual) => [
      ...actual.slice(-(MAX_UNDO - 1)),
      {
        kind: 'pieza',
        toothNumber: input.toothNumber,
        snapshot: findingsForTooth(input.anterior, input.toothNumber),
        descripcion: input.descripcion,
      },
    ]);
  };

  /**
   * Deshace un cambio de **prótesis**: repone la lista de prótesis que había antes.
   * Como las prótesis son pocas, se borran las vigentes y se vuelven a registrar las
   * del snapshot (la forma robusta de dejar el estado exactamente como estaba).
   */
  const deshacerProtesis = async (previas: readonly ProsthesisRecord[]): Promise<void> => {
    for (const actual of detalleActual()?.prostheses ?? []) {
      aplicarResultado(await odontogramApi.removeProsthesis(patientId, actual.id));
    }
    for (const previa of previas) {
      aplicarResultado(
        await odontogramApi.recordProsthesis(patientId, {
          kind: previa.kind,
          arch: previa.arch,
          toothNumbers: previa.toothNumbers,
          state: previa.state,
          notes: previa.notes,
          sessionId: previa.sessionId,
        }),
      );
    }
  };

  const deshacer = async (): Promise<void> => {
    const entrada = pila[pila.length - 1];
    if (entrada === undefined) return;

    setPila((actual) => actual.slice(0, -1));
    setDeshaciendo(true);
    try {
      if (entrada.kind === 'protesis') {
        await deshacerProtesis(entrada.snapshot);
        exito(t('odonto.exito.deshacerProtesis'));
        return;
      }

      // 1) Fuera lo que ahora sobra: desde una condición de pieza completa (que
      //    es la que superó las caras) hasta un hallazgo registrado de más.
      for (const hallazgo of findingsForTooth(detalleActual(), entrada.toothNumber)) {
        const previo = entrada.snapshot.some(
          (item) => item.surface === hallazgo.surface && item.condition === hallazgo.condition,
        );
        if (previo) continue;

        aplicarResultado(
          hallazgo.surface === null
            ? await odontogramApi.removeFinding(patientId, {
                toothNumber: entrada.toothNumber,
                surface: null,
                condition: hallazgo.condition,
              })
            : await odontogramApi.clearSurface(patientId, {
                toothNumber: entrada.toothNumber,
                surface: hallazgo.surface,
              }),
        );
      }

      // 2) De vuelta lo que había, con su estado, sus notas y su sesión.
      for (const previo of entrada.snapshot) {
        const vigente = findingsForTooth(detalleActual(), entrada.toothNumber).find(
          (item) => item.surface === previo.surface && item.condition === previo.condition,
        );
        if (vigente?.state === previo.state) continue;

        aplicarResultado(
          await odontogramApi.recordFinding(patientId, {
            toothNumber: entrada.toothNumber,
            surface: previo.surface,
            condition: previo.condition,
            state: previo.state,
            notes: previo.notes,
            sessionId: previo.sessionId,
          }),
        );
      }

      exito(t('odonto.exito.deshacer', { pieza: entrada.toothNumber }));
    } catch (fallo) {
      error(apiErrorMessage(fallo));
    } finally {
      setDeshaciendo(false);
    }
  };

  /** Devuelve el foco a la barra: se puede seguir tecleando sin tocar el ratón. */
  const pedirFoco = (): void => setFoco((valor) => valor + 1);

  const seleccionarPieza = (toothNumber: number): void => {
    setQuick((actual) => ({
      ...actual,
      toothNumber,
      pendingDigits: '',
      surfaces: actual.toothNumber === toothNumber ? actual.surfaces : [],
    }));
    pedirFoco();
  };

  /**
   * Abre la **hoja de botones** de una pieza. Si el toque acertó una cara (ratón),
   * entra marcada; con el dedo el toque no distingue caras y la hoja se abre limpia.
   */
  const abrirHoja = (toothNumber: number, surface: ToothSurface | null): void => {
    setHoja({ tooth: toothNumber, surfaces: surface === null ? [] : [surface] });
  };

  /* ── Prótesis removibles (PPR/PRT): tramo por dos toques y arcada completa ── */

  /** Prótesis ya registrada de un tipo y arcada (para editar en vez de duplicar). */
  const protesisExistenteDe = (
    kind: ProsthesisKind,
    arch: ProsthesisArch,
  ): ProsthesisRecord | null =>
    (detalleActual()?.prostheses ?? []).find(
      (prosthesis) => prosthesis.kind === kind && prosthesis.arch === arch,
    ) ?? null;

  /** Abre la ficha de una prótesis con su borrador (tipo, arcada y piezas). */
  const abrirProtesis = (
    kind: ProsthesisKind,
    arch: ProsthesisArch,
    toothNumbers: number[],
    existente: ProsthesisRecord | null = null,
  ): void => {
    setProtesis({ kind, arch, toothNumbers });
    setProtesisExistente(existente ?? protesisExistenteDe(kind, arch));
  };

  /** Cancela el modo tramo, el menú de la total y la ficha. */
  const cerrarProtesis = (): void => {
    setProtesis(null);
    setProtesisExistente(null);
    setModoPpr(false);
    setPprInicio(null);
    setMenuPrt(false);
  };

  /**
   * Un toque en modo **tramo de PPR**: la primera pieza abre el tramo y la segunda lo
   * cierra. Si la segunda es de otra arcada, se reinicia el tramo con esa pieza.
   */
  const elegirPiezaPpr = (toothNumber: number): void => {
    const arch = archOfTooth(toothNumber);
    if (arch === null) return; // las piezas temporales no llevan prótesis permanente
    if (pprInicio === null) {
      setPprInicio(toothNumber);
      return;
    }
    if (archOfTooth(pprInicio) !== arch) {
      setPprInicio(toothNumber);
      return;
    }
    const tramo = archRange(arch, pprInicio, toothNumber);
    setModoPpr(false);
    setPprInicio(null);
    abrirProtesis('ppr', arch, tramo);
  };

  /** Abre una **PRT** para una arcada completa (desde el menú de la barra). */
  const abrirPrt = (arch: ProsthesisArch): void => {
    setMenuPrt(false);
    abrirProtesis('prt', arch, [...archTeeth(arch)]);
  };

  /** Reabre la ficha de una prótesis tocada en el gráfico. */
  const alPulsarProtesis = (prosthesis: ProsthesisRecord): void => {
    abrirProtesis(prosthesis.kind, prosthesis.arch, [...prosthesis.toothNumbers], prosthesis);
  };

  /** Guardado de una prótesis desde la ficha: relee y deja deshacer. */
  const aplicarProtesis = (cambio: { descripcion: string }): void => {
    const anteriores = detalleActual()?.prostheses ?? [];
    void odontogramaQuery.refetch();
    setPila((actual) => [
      ...actual.slice(-(MAX_UNDO - 1)),
      { kind: 'protesis', snapshot: anteriores, descripcion: cambio.descripcion },
    ]);
    exito(t('odonto.exito.cambiado', { accion: cambio.descripcion }));
    cerrarProtesis();
  };

  /**
   * Un toque en el gráfico. Qué toca hacer lo decide `pressIntent`: por defecto abre
   * la hoja de la pieza; en modo teclado elige la pieza o marca la cara para la barra;
   * en modo prótesis elige la pieza del tramo.
   */
  const alPulsarPieza = (toothNumber: number, surface: ToothSurface | null): void => {
    const intencion = pressIntent(modoTeclado, surface, modoPpr);
    if (intencion === 'rango-protesis') {
      elegirPiezaPpr(toothNumber);
    } else if (intencion === 'abrir-hoja') {
      abrirHoja(toothNumber, surface);
    } else if (intencion === 'elegir-pieza') {
      seleccionarPieza(toothNumber);
    } else if (surface !== null) {
      marcarCara(toothNumber, surface);
    }
  };

  /** Un cambio hecho desde la hoja: se relee el odontograma y se puede deshacer. */
  const aplicarHoja = (cambio: {
    toothNumber: number;
    anterior: readonly ToothFindingRecord[];
    descripcion: string;
  }): void => {
    void odontogramaQuery.refetch();
    setPila((actual) => [
      ...actual.slice(-(MAX_UNDO - 1)),
      {
        kind: 'pieza',
        toothNumber: cambio.toothNumber,
        snapshot: cambio.anterior,
        descripcion: cambio.descripcion,
      },
    ]);
    setQuick((actual) => ({ ...actual, toothNumber: cambio.toothNumber, pendingDigits: '' }));
    exito(t('odonto.exito.cambiado', { accion: cambio.descripcion }));
  };

  /**
   * Muestra u oculta las piezas de leche (51–85) del gráfico.
   *
   * Al ocultarlas con una pieza temporal elegida se **suelta** esa selección: dejar
   * la barra de carga rápida apuntando a una pieza que ya no se ve daría un cambio
   * sobre una pieza invisible.
   */
  const alternarTemporal = (activar: boolean): void => {
    setTemporalManual(activar);
    if (activar) return;
    setQuick((actual) =>
      actual.toothNumber !== null && isPrimaryTooth(actual.toothNumber)
        ? { ...actual, toothNumber: null, pendingDigits: '', surfaces: [] }
        : actual,
    );
    setHoja((actual) => (actual !== null && isPrimaryTooth(actual.tooth) ? null : actual));
  };

  const marcarCara = (toothNumber: number, surface: ToothSurface): void => {
    setQuick((actual) => {
      const caras = actual.toothNumber === toothNumber ? actual.surfaces : [];
      return {
        ...actual,
        toothNumber,
        pendingDigits: '',
        surfaces: caras.includes(surface)
          ? caras.filter((item) => item !== surface)
          : [...caras, surface],
      };
    });
    pedirFoco();
  };

  if (odontogramaQuery.isLoading) {
    return (
      <Card>
        <CardContent className="grid place-items-center py-10">
          <Spinner size="lg" showLabel label={t('comun.cargando')} />
        </CardContent>
      </Card>
    );
  }

  if (odontogramaQuery.isError || odontogramaQuery.data === undefined) {
    return (
      <Alert variant="danger" title={t('odonto.error.titulo')}>
        {apiErrorMessage(odontogramaQuery.error)}
      </Alert>
    );
  }

  const resultado = odontogramaQuery.data;
  const detail = resultado.exists ? resultado.odontogram : null;
  const resumen = odontogramSummary(detail ?? BOCA_VACIA);
  const ultima = pila[pila.length - 1];
  const puedeDeshacer = canWrite && ultima !== undefined && pendientes === 0 && !deshaciendo;

  /** Dentición de la boca según los hallazgos; sin odontograma, permanente. */
  const denticionBoca: Dentition = detail?.dentition ?? BOCA_VACIA.dentition;
  /** La casilla manda; sin decisión explícita, la boca decide (mixta ⇒ marcada). */
  const mostrarTemporal = temporalManual ?? denticionBoca === 'mixta';
  /**
   * La dentición que **dibuja** el gráfico: activar la casilla fuerza `mixta`
   * (permanente + bandas temporales); no se toca cuando la boca ya es `temporal`.
   */
  const denticionGrafico: Dentition =
    mostrarTemporal && denticionBoca !== 'temporal' ? 'mixta' : denticionBoca;

  return (
    <Card>
      <CardHeader className="flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>{t('odonto.titulo')}</CardTitle>
          <p className="mt-0.5 text-sm text-ink-muted">{t('odonto.descripcion')}</p>
          {detail !== null && (
            <p className="mt-1 text-xs text-ink-subtle">
              {t('odonto.actualizado', { fecha: formatDate(detail.updatedAt) })}
              {detail.lastPrintedAt !== null
                ? ` · ${t('odonto.ultimaImpresion', { fecha: formatDate(detail.lastPrintedAt) })}`
                : ''}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canWrite && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setModoTeclado((actual) => !actual)}
              leadingIcon={
                modoTeclado ? (
                  <Hand className="size-4" aria-hidden />
                ) : (
                  <Keyboard className="size-4" aria-hidden />
                )
              }
            >
              {t(modoTeclado ? 'odonto.teclado.desactivar' : 'odonto.teclado.activar')}
            </Button>
          )}
          {canWrite && (
            <div className="relative flex items-center gap-2">
              <Button
                variant={modoPpr ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => {
                  setModoPpr((actual) => !actual);
                  setPprInicio(null);
                  setMenuPrt(false);
                }}
                leadingIcon={<Layers className="size-4" aria-hidden />}
              >
                {t(modoPpr ? 'odonto.protesis.ppr.activo' : 'odonto.protesis.ppr.activar')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMenuPrt((actual) => !actual);
                  setModoPpr(false);
                  setPprInicio(null);
                }}
                leadingIcon={<Layers className="size-4" aria-hidden />}
              >
                {t('odonto.protesis.prt.titulo')}
              </Button>
              {menuPrt && (
                <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-control border border-border bg-surface p-1 shadow-lg">
                  <button
                    type="button"
                    onClick={() => abrirPrt('maxilar')}
                    className="block w-full rounded-control px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                  >
                    {t('odonto.protesis.maxilar')}
                  </button>
                  <button
                    type="button"
                    onClick={() => abrirPrt('mandibula')}
                    className="block w-full rounded-control px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
                  >
                    {t('odonto.protesis.mandibula')}
                  </button>
                </div>
              )}
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!puedeDeshacer}
            loading={deshaciendo}
            leadingIcon={<Undo2 className="size-4" aria-hidden />}
            onClick={() => void deshacer()}
          >
            {ultima === undefined
              ? t('odonto.deshacer.accion')
              : t('odonto.deshacer.ultima', { accion: ultima.descripcion })}
          </Button>
          <Link
            className={buttonClasses({ variant: 'ghost', size: 'sm' })}
            to={`/consultorio/${patientId}/odontograma/historial`}
          >
            <History className="size-4" aria-hidden />
            <span className="truncate">{t('odonto.historial.accion')}</span>
          </Link>
          <a
            className={buttonClasses({ variant: 'secondary', size: 'sm' })}
            href={`/consultorio/${patientId}/odontograma/imprimir`}
            target="_blank"
            rel="noreferrer"
          >
            <Printer className="size-4" aria-hidden />
            <span className="truncate">{t('odonto.imprimir.accion')}</span>
          </a>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <NoticeBanner notice={notice} onClose={limpiar} className="mb-0" />

        {detail === null && (
          <Alert variant="info" title={t('odonto.sana.titulo')}>
            <p>{t('odonto.sana.texto')}</p>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Badge variant="neutral">{t('odonto.afectadas', { total: resumen.affectedTeeth })}</Badge>
          <Badge variant="danger" dot>
            {t('odonto.pendientes', { total: resumen.pendingCount })}
          </Badge>
          <Badge variant="info" dot>
            {t('odonto.completadas', { total: resumen.completedCount })}
          </Badge>
          <Badge variant="primary">{dentitionLabel(denticionGrafico)}</Badge>
          {/*
            La dentición temporal se activa a mano: en la captura por excepción no se
            sabe si el paciente de leche conserva sus piezas (la sana no tiene fila),
            así que quien explora decide cuándo enseñarlas. Visible también para la
            secretaría: consultar la boca mixta es leer. No aparece si la boca **ya**
            es temporal, donde no habría nada que alternar.
          */}
          {denticionBoca !== 'temporal' && (
            <div className="ml-auto">
              <Checkbox
                checked={mostrarTemporal}
                onChange={(event) => alternarTemporal(event.target.checked)}
                label={t('odonto.temporal.activar')}
                description={t('odonto.temporal.ayuda')}
              />
            </div>
          )}
        </div>

        {canWrite ? (
          <>
            {/* Primero el diagrama: el gesto empieza ahí. Pulsar una pieza abre su
                hoja de botones; si el toque acierta una cara (ratón), entra marcada. */}
            <OdontogramChart
              detail={detail}
              dentition={denticionGrafico}
              activeTooth={quick.toothNumber ?? hoja?.tooth ?? null}
              activeSurfaces={quick.surfaces}
              onToothPress={alPulsarPieza}
              onProsthesisPress={alPulsarProtesis}
              readOnly={false}
            />

            {modoPpr && (
              <p className="rounded-control border border-primary/40 bg-primary/5 px-3 py-2 text-sm text-primary">
                {pprInicio === null
                  ? t('odonto.protesis.ppr.primera')
                  : t('odonto.protesis.ppr.ultima')}
              </p>
            )}

            {modoTeclado ? (
              <>
                <QuickEntryBar
                  patientId={patientId}
                  detail={detail}
                  state={quick}
                  sessionId={sessionId}
                  onStateChange={setQuick}
                  onApplied={aplicar}
                  onError={(fallo) => error(apiErrorMessage(fallo))}
                  onPendingChange={setPendientes}
                  onCancel={limpiar}
                  focusSignal={foco}
                />

                {/* La misma hoja táctil, abierta para la pieza que se teclea. */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (quick.toothNumber !== null) abrirHoja(quick.toothNumber, null);
                    }}
                    disabled={quick.toothNumber === null}
                    leadingIcon={<Hand className="size-4" aria-hidden />}
                  >
                    {t('odonto.sheet.abrir')}
                  </Button>
                  <span className="text-xs text-ink-subtle">
                    {quick.toothNumber === null
                      ? t('odonto.activa.ninguna')
                      : t('odonto.activa.pieza', { pieza: quick.toothNumber })}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-xs text-ink-subtle">{t('odonto.tactil.ayuda')}</p>
            )}
          </>
        ) : (
          <>
            <OdontogramChart detail={detail} dentition={denticionGrafico} readOnly />
            <p className="rounded-control border border-border bg-surface-muted px-3 py-2.5 text-sm text-ink-muted">
              {t('odonto.soloLectura')}
            </p>
          </>
        )}

        {detail !== null && detail.empty && (
          <p className="text-sm text-ink-muted">{t('odonto.hallazgos.ninguno')}</p>
        )}

        <ToothFindingSheet
          open={canWrite && hoja !== null}
          patientId={patientId}
          toothNumber={hoja?.tooth ?? null}
          initialSurfaces={hoja?.surfaces ?? []}
          findings={findingsForTooth(detail, hoja?.tooth ?? 0)}
          canWrite={canWrite}
          sessionId={sessionId}
          onClose={() => setHoja(null)}
          onApplied={aplicarHoja}
          onError={(fallo) => error(fallo)}
        />

        <ProsthesisDialog
          open={canWrite && protesis !== null}
          patientId={patientId}
          kind={protesis?.kind ?? 'ppr'}
          arch={protesis?.arch ?? 'maxilar'}
          toothNumbers={protesis?.toothNumbers ?? []}
          existing={protesisExistente}
          canWrite={canWrite}
          sessionId={sessionId}
          onClose={cerrarProtesis}
          onApplied={aplicarProtesis}
          onError={(fallo) => error(fallo)}
        />
      </CardContent>
    </Card>
  );
};
