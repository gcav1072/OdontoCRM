import type {
  PeriodontalExamDetail,
  PeriodontalExamSummary,
  PeriodontalPatientSnapshot,
} from '@odontocrm/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Spinner } from '@odontocrm/ui';
import { Printer } from 'lucide-react';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { PeriodontogramDocument } from '../components/periodontogram/PeriodontogramDocument';
import { MargenDeImpresion } from '../components/print/MargenDeImpresion';
import { apiErrorMessage } from '../lib/api';
import { esperarFuentes, useMargenDeImpresion, useTemaClaroParaImprimir } from '../lib/impresion';
import { t } from '../lib/i18n';
import { periodontogramApi } from '../lib/periodontogram-api';

/** Tope del listado de finalizados para resolver el examen anterior al comparar. */
const LIMITE_EXAMENES = 100;

/**
 * Vista de impresión del periodontograma (v1.1): se abre en una pestaña propia,
 * fuera del shell, para que el papel no lleve navegación. La comparte la secretaría,
 * que **imprime pero no escribe** (`odontogram:read`, decisión 23).
 *
 * Igual que el odontograma:
 * - El papel es blanco aunque la pantalla esté en modo oscuro (`useTemaClaroParaImprimir`).
 * - Cada impresión deja constancia en la auditoría con su actor; si esa llamada falla,
 *   el papel sale igual: primero está el documento.
 * - La comparación es **opt-in**: el informe normal se queda corto y legible, y el que
 *   se archiva o se entrega puede llevar la evolución frente al examen anterior.
 *
 * La URL puede pedir un examen concreto (`?examen=<examId>`); sin parámetro se imprime
 * el último. El paciente siempre se toma de `latest`, que es la lectura que lo trae.
 */
export const PeriodontogramPrintPage = () => {
  const { patientId } = useParams<{ patientId: string }>();
  const [params] = useSearchParams();
  const examIdPedido = params.get('examen');
  const hayExamenPedido = examIdPedido !== null && examIdPedido !== '';
  const hayPaciente = patientId !== undefined && patientId !== '';

  // El papel se imprime con la paleta clara y con el margen elegido en la barra.
  useTemaClaroParaImprimir();
  const [margen, setMargen] = useMargenDeImpresion();
  const [aviso, setAviso] = useState<string | null>(null);
  const [conComparacion, setConComparacion] = useState(false);

  // `latest` resuelve el paciente y, sin `?examen=`, el examen por defecto.
  const ultimoQuery = useQuery({
    queryKey: ['periodontograma', 'impresion', 'ultimo', patientId],
    queryFn: ({ signal }) => periodontogramApi.latest(patientId ?? '', signal),
    enabled: hayPaciente,
  });

  // Con `?examen=<id>` se imprime ese y no el último.
  const examenQuery = useQuery({
    queryKey: ['periodontograma', 'impresion', 'examen', patientId, examIdPedido],
    queryFn: ({ signal }) => periodontogramApi.detail(patientId ?? '', examIdPedido ?? '', signal),
    enabled: hayPaciente && hayExamenPedido,
  });

  // Para un examen que no es el último hay que buscar su anterior en el listado:
  // `previousFinalized` de `latest` solo habla del último examen.
  const finalizadosQuery = useQuery({
    queryKey: ['periodontograma', 'impresion', 'finalizados', patientId],
    queryFn: ({ signal }) =>
      periodontogramApi.list(
        patientId ?? '',
        { status: 'finalizado', limit: LIMITE_EXAMENES },
        signal,
      ),
    enabled: hayPaciente && hayExamenPedido,
  });

  // El examen que se va a imprimir y el paciente del membrete. Se calculan antes de
  // los retornos tempranos para que los hooks de abajo se llamen siempre en el mismo
  // orden (regla de hooks).
  const ultimo = ultimoQuery.data;
  const examen: PeriodontalExamDetail | null = hayExamenPedido
    ? (examenQuery.data ?? null)
    : ultimo !== undefined && ultimo.exists
      ? ultimo.exam
      : null;
  const paciente: PeriodontalPatientSnapshot | null = ultimo?.patient ?? null;

  /**
   * El examen anterior con el que comparar: para el último sirve `previousFinalized`
   * (ya viene en `latest`); para uno antiguo, el primer finalizado anterior del
   * listado. Si no hay anterior, la comparación no se ofrece.
   */
  const anterior: PeriodontalExamSummary | null = (() => {
    if (examen === null) return null;
    if (ultimo !== undefined && ultimo.exists && ultimo.exam.id === examen.id) {
      return ultimo.previousFinalized;
    }
    const finalizados = finalizadosQuery.data?.items ?? [];
    return (
      finalizados.find((item) => item.id !== examen.id && item.examDate <= examen.examDate) ?? null
    );
  })();

  const comparacionQuery = useQuery({
    queryKey: ['periodontograma', 'impresion', 'comparacion', patientId, examen?.id, anterior?.id],
    queryFn: ({ signal }) =>
      periodontogramApi.compare(patientId ?? '', examen?.id ?? '', anterior?.id ?? '', signal),
    enabled: conComparacion && examen !== null && anterior !== null,
  });

  const registrarImpresion = useMutation({
    mutationFn: () => periodontogramApi.registerPrint(patientId ?? '', examen?.id ?? ''),
  });

  const imprimir = async (): Promise<void> => {
    setAviso(null);
    try {
      await registrarImpresion.mutateAsync();
    } catch (fallo) {
      setAviso(apiErrorMessage(fallo));
    }
    // El papel espera a la tipografía de la marca: con `font-display: swap`, imprimir
    // en el hueco de carga sacaba el membrete con la sans del sistema.
    await esperarFuentes();
    window.print();
  };

  if (!hayPaciente) {
    return <Alert variant="danger">{t('periodonto.error.sinPaciente')}</Alert>;
  }

  // El examen se pinta en cuanto llega; mientras falte cualquiera de las dos lecturas
  // que lo resuelven, se avisa con el mismo indicador que el resto de la aplicación.
  if (ultimoQuery.isLoading || (hayExamenPedido && examenQuery.isLoading)) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner size="lg" showLabel label={t('comun.cargando')} />
      </div>
    );
  }

  if (ultimoQuery.isError || ultimoQuery.data === undefined) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <Alert variant="danger" title={t('periodonto.imprimir.error.titulo')}>
          {apiErrorMessage(ultimoQuery.error)}
        </Alert>
      </div>
    );
  }

  if (hayExamenPedido && (examenQuery.isError || examenQuery.data === undefined)) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <Alert variant="danger" title={t('periodonto.imprimir.error.titulo')}>
          {apiErrorMessage(examenQuery.error)}
        </Alert>
      </div>
    );
  }

  /** Sin periodontograma no hay nada que imprimir: un documento «en blanco» engañaría. */
  if (examen === null) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <Alert variant="warning" title={t('periodonto.imprimir.titulo')}>
          {t('periodonto.imprimir.sinExamen')}
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-canvas pb-10 print:pb-0">
      <div className="mx-auto flex max-w-[21cm] flex-wrap items-center justify-between gap-3 px-6 py-4 print:hidden">
        <div className="flex items-center gap-2 text-ink-muted">
          <Printer className="size-4" aria-hidden />
          <span className="text-sm">{t('periodonto.imprimir.titulo')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Cuánto blanco deja el borde de la hoja (carta) antes del documento. */}
          <MargenDeImpresion margenMm={margen} onChange={setMargen} />
          {/* La casilla decide si el papel lleva la evolución frente al examen anterior. */}
          {anterior !== null && (
            <Checkbox
              checked={conComparacion}
              onChange={(event) => setConComparacion(event.target.checked)}
              label={t('periodonto.imprimir.conComparacion')}
            />
          )}
          <Button variant="secondary" onClick={() => window.close()}>
            {t('periodonto.comun.cerrar')}
          </Button>
          <Button loading={registrarImpresion.isPending} onClick={() => void imprimir()}>
            {t('periodonto.imprimir.accion')}
          </Button>
        </div>
      </div>

      {aviso !== null && (
        <div className="mx-auto max-w-[21cm] px-6 print:hidden">
          <Alert variant="warning">{aviso}</Alert>
        </div>
      )}

      {/* Si se pidió la comparación y todavía no llegó, se dice: imprimir sin ella sería
          entregar un informe distinto del que se pidió. */}
      {conComparacion && comparacionQuery.isLoading && (
        <div className="mx-auto max-w-[21cm] px-6 pb-3 print:hidden">
          <Spinner size="sm" showLabel label={t('comun.cargando')} />
        </div>
      )}
      {conComparacion && comparacionQuery.isError && (
        <div className="mx-auto max-w-[21cm] px-6 pb-3 print:hidden">
          <Alert variant="warning">{apiErrorMessage(comparacionQuery.error)}</Alert>
        </div>
      )}

      <PeriodontogramDocument
        detail={examen}
        patient={paciente}
        comparison={conComparacion ? (comparacionQuery.data?.comparison ?? null) : null}
        previousExamDate={
          conComparacion ? (comparacionQuery.data?.previous.examDate ?? null) : null
        }
      />
    </div>
  );
};
