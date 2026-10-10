import { DOC_TYPES, type DocType, type PatientDetail } from '@odontocrm/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Spinner,
} from '@odontocrm/ui';
import { IdCard, Search, UserPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import { patientsApi } from '../lib/endpoints';
import { DOC_TYPE_LABELS, t } from '../lib/i18n';
import {
  checkDocument,
  documentFrom,
  emptyFormValues,
  formatDocNumberInput,
  normalizeDocInput,
  readDocumentInput,
  type PatientFormValues,
} from '../lib/patients';
import { useAuth } from '../providers/AuthProvider';
import { NoticeBanner } from '../components/NoticeBanner';
import { PatientForm } from '../components/patients/PatientForm';
import { PatientStatusDialog } from '../components/patients/PatientStatusDialog';

/**
 * `/registro`: el flujo central de la Fase 2.
 *
 * 1. Se escribe la cédula (con selector V/E/P/SC y máscara de miles; también
 *    acepta `v 12.345.678` pegado).
 * 2. «Buscar» o Enter llama a `patientsApi.lookup`:
 *    - no existe → aviso y botón **Registrar paciente** con el documento cargado;
 *    - existe → ficha en **solo lectura** con botón Editar que exige motivo.
 * 3. El alta maneja el 409 del documento duplicado ofreciendo abrir esa ficha.
 */
export const PatientRegistryPage = () => {
  const { hasPermission } = useAuth();
  const puedeEscribir = hasPermission('patients:write');
  const { notice, limpiar, exito } = useNotice();

  const [parametros] = useSearchParams();
  const documentoInicial = parametros.get('documento') ?? '';

  const [docType, setDocType] = useState<DocType>('V');
  const [docNumber, setDocNumber] = useState('');
  const [documentoBuscado, setDocumentoBuscado] = useState('');
  const [modoAlta, setModoAlta] = useState(false);
  const [errorDocumento, setErrorDocumento] = useState<string | null>(null);
  const [cambiandoEstado, setCambiandoEstado] = useState(false);

  // Permite llegar desde la ficha con `?documento=V-12345678`.
  useEffect(() => {
    if (documentoInicial === '') return;
    const leido = readDocumentInput(documentoInicial, 'V');
    setDocType(leido.docType);
    setDocNumber(leido.display);
    const revision = checkDocument(leido.docType, leido.display);
    if (revision.ok) {
      setDocumentoBuscado(revision.formatted);
      setModoAlta(false);
    }
  }, [documentoInicial]);

  const busqueda = useQuery({
    queryKey: ['paciente-por-documento', documentoBuscado],
    queryFn: ({ signal }) => patientsApi.lookup(documentoBuscado, signal),
    enabled: documentoBuscado !== '',
    retry: false,
  });

  const encontrado = busqueda.data?.found === true ? busqueda.data.patient : null;
  const noEncontrado = busqueda.data?.found === false ? busqueda.data.document : null;
  const buscando = busqueda.isFetching;

  /** Valida el documento con el contrato y dispara el `lookup`. */
  const buscar = (tipo: DocType = docType, numero: string = docNumber) => {
    const revision = checkDocument(tipo, numero);
    if (!revision.ok) {
      setErrorDocumento(revision.message ?? t('pacientes.doc.invalido'));
      setDocumentoBuscado('');
      setModoAlta(false);
      return;
    }
    setErrorDocumento(null);
    setModoAlta(false);

    if (revision.formatted === documentoBuscado) void busqueda.refetch();
    else setDocumentoBuscado(revision.formatted);
  };

  const limpiarBusqueda = () => {
    setDocNumber('');
    setDocumentoBuscado('');
    setModoAlta(false);
    setErrorDocumento(null);
  };

  // Los valores iniciales del alta se memoizan: si se recrearan en cada render, el
  // `reset(iniciales)` de `PatientForm` dispararía con cualquier re-render del padre
  // y borraría lo que el usuario ya había escrito.
  const valoresAlta: PatientFormValues = useMemo(
    () => emptyFormValues(docType, docNumber),
    [docType, docNumber],
  );
  const etiquetaModo = buscando ? t('registro.buscando') : t('registro.buscar');

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <Card>
        <CardHeader className="gap-1.5">
          <CardTitle as="h2">{t('registro.titulo')}</CardTitle>
          <p className="text-sm text-ink-muted">{t('registro.descripcion')}</p>
        </CardHeader>

        <CardContent className="space-y-4">
          <form
            noValidate
            className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              buscar();
            }}
          >
            <Field label={t('pacientes.doc.tipo')}>
              <Select
                value={docType}
                onChange={(event) => {
                  const nuevo = event.target.value as DocType;
                  // Al cambiar el tipo se reescribe la máscara del número.
                  const display = formatDocNumberInput(nuevo, docNumber);
                  setDocType(nuevo);
                  setDocNumber(display);
                  const revision = checkDocument(nuevo, display);
                  setErrorDocumento(revision.ok ? null : (revision.message ?? null));
                }}
              >
                {DOC_TYPES.map((tipo) => (
                  <option key={tipo} value={tipo}>
                    {DOC_TYPE_LABELS[tipo]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={t('pacientes.doc.numero')}
              hint={t('pacientes.doc.ayuda')}
              error={errorDocumento ?? undefined}
            >
              <Input
                value={docNumber}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                inputMode={docType === 'V' || docType === 'E' ? 'numeric' : 'text'}
                placeholder={t('pacientes.doc.placeholder')}
                onChange={(event) => {
                  // Se acepta cualquier forma: `V-12.345.678`, `v 12.345.678`…
                  const leido = readDocumentInput(event.target.value, docType);
                  if (leido.docType !== docType) setDocType(leido.docType);
                  setDocNumber(normalizeDocInput(leido.docType, leido.display));
                  setErrorDocumento(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    buscar();
                  }
                }}
              />
            </Field>

            <Button
              type="submit"
              loading={buscando}
              loadingLabel={etiquetaModo}
              leadingIcon={<Search className="size-4" aria-hidden="true" />}
            >
              {t('registro.buscar')}
            </Button>
          </form>

          <p className="flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
            <IdCard className="size-3.5" aria-hidden="true" />
            <span className="font-mono">
              {docNumber === '' ? t('comun.sinDato') : documentFrom(docType, docNumber)}
            </span>
          </p>

          {docType === 'SC' && <Alert variant="warning">{t('pacientes.doc.avisoSC')}</Alert>}

          {busqueda.isError && (
            <Alert variant="danger" title={t('registro.errorBusqueda')}>
              {apiErrorMessage(busqueda.error)}
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Sin búsqueda todavía: solo la instrucción. */}
      {documentoBuscado === '' && !modoAlta && (
        <Alert variant="info" hideIcon>
          {t('pacientes.doc.ayuda')}
        </Alert>
      )}

      {buscando && (
        <div className="py-6">
          <Spinner label={t('registro.buscando')} showLabel />
        </div>
      )}

      {/* No existe: aviso claro + alta con el documento ya cargado. */}
      {!buscando && noEncontrado !== null && !modoAlta && (
        <Card>
          <CardHeader className="gap-2">
            <CardTitle as="h3">{t('registro.noEncontrado')}</CardTitle>
            <p className="text-sm text-ink-muted">
              {t('registro.noEncontradoTexto', { documento: noEncontrado })}
            </p>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            {puedeEscribir ? (
              <>
                <Button
                  onClick={() => setModoAlta(true)}
                  leadingIcon={<UserPlus className="size-4" aria-hidden="true" />}
                >
                  {t('registro.registrar')}
                </Button>
                <Button variant="secondary" onClick={limpiarBusqueda}>
                  {t('registro.otroDocumento')}
                </Button>
              </>
            ) : (
              <Alert variant="warning">{t('pacientes.editar.sinPermiso')}</Alert>
            )}
          </CardContent>
        </Card>
      )}

      {/* Alta: formulario completo con el documento cargado. */}
      {modoAlta && puedeEscribir && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="primary" icon={<IdCard className="size-3" aria-hidden="true" />}>
              {documentFrom(docType, docNumber)}
            </Badge>
            <Button variant="ghost" size="sm" onClick={limpiarBusqueda}>
              {t('registro.volverBusqueda')}
            </Button>
          </div>

          <PatientForm
            mode="create"
            initialValues={valoresAlta}
            onCancel={limpiarBusqueda}
            onSaved={(creado: PatientDetail) => {
              // El recién creado se muestra en solo lectura, como cualquier otro.
              setModoAlta(false);
              setDocType(creado.docType);
              setDocNumber(formatDocNumberInput(creado.docType, creado.docNumber));
              setDocumentoBuscado(creado.document);
              exito(t('registro.creado', { documento: creado.document }));
            }}
            onOpenExisting={(id: string) => {
              // 409: existe una ficha con ese documento. Se abre en solo lectura
              // buscándola por su id y se recupera su documento formateado.
              setModoAlta(false);
              void patientsApi
                .get(id)
                .then((existente: PatientDetail) => {
                  setDocType(existente.docType);
                  setDocNumber(formatDocNumberInput(existente.docType, existente.docNumber));
                  setDocumentoBuscado(existente.document);
                })
                .catch((fallo: unknown) => {
                  // Si el id no se puede leer, se reintenta la búsqueda normal y
                  // el aviso de error de la consulta queda visible.
                  void fallo;
                  void busqueda.refetch();
                });
            }}
          />
        </div>
      )}

      {/* Existe: ficha en solo lectura con edición por motivo y confirmación. */}
      {!buscando && encontrado !== null && !modoAlta && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success">{t('pacientes.lectura.rotulo')}</Badge>
            <Button variant="ghost" size="sm" onClick={limpiarBusqueda}>
              {t('registro.otroDocumento')}
            </Button>
          </div>

          <PatientForm
            mode="edit"
            patient={encontrado}
            onSaved={(actualizado: PatientDetail) => {
              exito(t('pacientes.editar.ok'));
              setDocType(actualizado.docType);
              setDocNumber(formatDocNumberInput(actualizado.docType, actualizado.docNumber));
              setDocumentoBuscado(actualizado.document);
            }}
          />

          {hasPermission('patients:edit_sensitive') && (
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setCambiandoEstado(true)}>
                {t('pacientes.estado.boton')}
              </Button>
            </div>
          )}

          <PatientStatusDialog
            open={cambiandoEstado}
            patient={encontrado}
            onClose={() => setCambiandoEstado(false)}
            onDone={() => {
              void busqueda.refetch();
              exito(t('pacientes.estado.ok'));
            }}
          />
        </div>
      )}
    </div>
  );
};
