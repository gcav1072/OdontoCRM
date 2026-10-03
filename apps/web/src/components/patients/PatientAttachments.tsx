import {
  ALLOWED_FILE_MIME_TYPES,
  MAX_FILE_BYTES,
  PATIENT_FILE_KINDS,
  type PatientFile,
  type PatientFileKind,
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
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@odontocrm/ui';
import { Download, Paperclip, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

import { useNotice } from '../../hooks/useNotice';
import { apiErrorMessage } from '../../lib/api';
import { patientsApi } from '../../lib/endpoints';
import { formatDateTime, formatNumber } from '../../lib/format';
import { PATIENT_FILE_KIND_LABELS, t } from '../../lib/i18n';
import { useAuth } from '../../providers/AuthProvider';
import { NoticeBanner } from '../NoticeBanner';

const MIME_PERMITIDOS: ReadonlySet<string> = new Set<string>(ALLOWED_FILE_MIME_TYPES);

/** Tamaño legible: 1,4 MB · 320 kB. */
export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024))} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
};

export interface PatientAttachmentsProps {
  patientId: string;
}

/**
 * Adjuntos de la ficha: subir (con tipo de documento y leyenda), listar con
 * tamaño y fecha, descargar y borrar con confirmación.
 *
 * El archivo nunca se sirve por URL pública: la descarga pide el binario con
 * `fetch` y las credenciales de la sesión, y se guarda con un enlace temporal
 * (`URL.createObjectURL`), que se revoca enseguida.
 */
export const PatientAttachments = ({ patientId }: PatientAttachmentsProps) => {
  const { hasPermission } = useAuth();
  const puedeEscribir = hasPermission('patients:write');
  const cliente = useQueryClient();
  const { notice, limpiar, exito, error } = useNotice();

  const selectorRef = useRef<HTMLInputElement | null>(null);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [tipo, setTipo] = useState<PatientFileKind>('radiografia');
  const [leyenda, setLeyenda] = useState('');
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null);
  const [porBorrar, setPorBorrar] = useState<PatientFile | null>(null);
  const [descargando, setDescargando] = useState<string | null>(null);

  const adjuntosQuery = useQuery({
    queryKey: ['paciente-adjuntos', patientId],
    queryFn: ({ signal }) => patientsApi.listFiles(patientId, signal),
  });

  const subir = useMutation({
    mutationFn: (datos: { file: File; kind: PatientFileKind; caption?: string }) =>
      patientsApi.uploadFile(patientId, datos),
  });

  const borrar = useMutation({
    mutationFn: (fileId: string) => patientsApi.deleteFile(patientId, fileId),
  });

  const refrescar = () => cliente.invalidateQueries({ queryKey: ['paciente-adjuntos', patientId] });

  const elegirArchivo = (elegido: File | null) => {
    setErrorArchivo(null);
    if (elegido === null) {
      setArchivo(null);
      return;
    }
    if (!MIME_PERMITIDOS.has(elegido.type)) {
      setArchivo(null);
      setErrorArchivo(t('pacientes.adjuntos.mimeNoPermitido'));
      return;
    }
    if (elegido.size > MAX_FILE_BYTES) {
      setArchivo(null);
      setErrorArchivo(
        t('pacientes.adjuntos.demasiadoGrande', { max: formatFileSize(MAX_FILE_BYTES) }),
      );
      return;
    }
    setArchivo(elegido);
  };

  const enviar = async () => {
    // El botón ya queda bloqueado con `loading`, pero un Enter rápido no debe
    // provocar dos cargas del mismo archivo.
    if (subir.isPending) return;
    if (archivo === null) {
      setErrorArchivo(t('pacientes.adjuntos.sinArchivo'));
      return;
    }
    setErrorArchivo(null);
    try {
      await subir.mutateAsync({ file: archivo, kind: tipo, caption: leyenda.trim() });
      setArchivo(null);
      setLeyenda('');
      if (selectorRef.current) selectorRef.current.value = '';
      await refrescar();
      exito(t('pacientes.adjuntos.ok'));
    } catch (fallo) {
      error(apiErrorMessage(fallo), t('pacientes.adjuntos.error'));
    }
  };

  const descargar = async (adjunto: PatientFile) => {
    setDescargando(adjunto.id);
    try {
      const blob = await patientsApi.downloadFile(patientId, adjunto.id);
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement('a');
      enlace.href = url;
      enlace.download = adjunto.originalName;
      document.body.append(enlace);
      enlace.click();
      enlace.remove();
      URL.revokeObjectURL(url);
    } catch (fallo) {
      error(apiErrorMessage(fallo), t('pacientes.adjuntos.descargaError'));
    } finally {
      setDescargando(null);
    }
  };

  const confirmarBorrado = async () => {
    if (porBorrar === null) return;
    try {
      await borrar.mutateAsync(porBorrar.id);
      setPorBorrar(null);
      await refrescar();
      exito(t('pacientes.adjuntos.borrado'));
    } catch (fallo) {
      setPorBorrar(null);
      error(apiErrorMessage(fallo), t('pacientes.adjuntos.borradoError'));
    }
  };

  const adjuntos = adjuntosQuery.data?.items ?? [];

  return (
    <Card>
      <CardHeader className="gap-1.5">
        <CardTitle as="h3">{t('pacientes.adjuntos.titulo')}</CardTitle>
        <p className="text-sm text-ink-muted">{t('pacientes.adjuntos.texto')}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        <NoticeBanner notice={notice} onClose={limpiar} className="" />

        {puedeEscribir && (
          <div className="space-y-3 rounded-card border border-border bg-surface-muted p-3.5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={t('pacientes.adjuntos.archivo')}
                hint={t('pacientes.adjuntos.archivoAyuda', { max: formatFileSize(MAX_FILE_BYTES) })}
                error={errorArchivo ?? undefined}
              >
                <Input
                  ref={selectorRef}
                  type="file"
                  accept={ALLOWED_FILE_MIME_TYPES.join(',')}
                  onChange={(event) => elegirArchivo(event.target.files?.[0] ?? null)}
                />
              </Field>

              <Field label={t('pacientes.adjuntos.tipo')}>
                <Select
                  value={tipo}
                  onChange={(event) => setTipo(event.target.value as PatientFileKind)}
                >
                  {PATIENT_FILE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {PATIENT_FILE_KIND_LABELS[kind]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field label={t('pacientes.adjuntos.leyenda')}>
                <Input
                  value={leyenda}
                  placeholder={t('pacientes.adjuntos.leyendaPlaceholder')}
                  onChange={(event) => setLeyenda(event.target.value)}
                />
              </Field>
              <Button
                onClick={() => void enviar()}
                loading={subir.isPending}
                loadingLabel={t('pacientes.adjuntos.subiendo')}
                leadingIcon={<Upload className="size-4" aria-hidden="true" />}
              >
                {t('pacientes.adjuntos.subir')}
              </Button>
            </div>
          </div>
        )}

        {adjuntosQuery.isError && (
          <Alert variant="danger" title={t('pacientes.adjuntos.errorLista')}>
            {apiErrorMessage(adjuntosQuery.error)}
          </Alert>
        )}

        {adjuntosQuery.isPending ? (
          <div className="py-6">
            <Spinner label={t('pacientes.adjuntos.cargando')} showLabel />
          </div>
        ) : adjuntos.length === 0 ? (
          <EmptyState
            icon={<Paperclip className="size-6" aria-hidden="true" />}
            title={t('pacientes.adjuntos.vacio')}
          />
        ) : (
          <Table caption={t('pacientes.adjuntos.total', { total: adjuntos.length })}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('pacientes.adjuntos.columna.archivo')}</TableHead>
                <TableHead>{t('pacientes.adjuntos.columna.tipo')}</TableHead>
                <TableHead>{t('pacientes.adjuntos.columna.tamano')}</TableHead>
                <TableHead>{t('pacientes.adjuntos.columna.fecha')}</TableHead>
                <TableHead className="text-right">
                  {t('pacientes.adjuntos.columna.acciones')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {adjuntos.map((adjunto) => (
                <TableRow key={adjunto.id}>
                  <TableCell>
                    <span className="block font-medium text-ink">{adjunto.originalName}</span>
                    {adjunto.caption && (
                      <span className="block text-xs text-ink-subtle">{adjunto.caption}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="neutral">{PATIENT_FILE_KIND_LABELS[adjunto.kind]}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-ink-muted">
                    {formatFileSize(adjunto.size)}
                  </TableCell>
                  <TableCell className="text-sm text-ink-muted">
                    {formatDateTime(adjunto.createdAt)}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`${t('pacientes.adjuntos.descargar')}: ${adjunto.originalName}`}
                        title={t('pacientes.adjuntos.descargar')}
                        loading={descargando === adjunto.id}
                        onClick={() => void descargar(adjunto)}
                        leadingIcon={<Download className="size-4" aria-hidden="true" />}
                      />
                      {puedeEscribir && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`${t('pacientes.adjuntos.borrar')}: ${adjunto.originalName}`}
                          title={t('pacientes.adjuntos.borrar')}
                          onClick={() => setPorBorrar(adjunto)}
                          leadingIcon={<Trash2 className="size-4" aria-hidden="true" />}
                        />
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog
        open={porBorrar !== null}
        onClose={() => setPorBorrar(null)}
        title={t('pacientes.adjuntos.borrarTitulo', { archivo: porBorrar?.originalName ?? '' })}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setPorBorrar(null)}
              disabled={borrar.isPending}
            >
              {t('comun.cancelar')}
            </Button>
            <Button
              variant="danger"
              loading={borrar.isPending}
              loadingLabel={t('comun.guardando')}
              onClick={() => void confirmarBorrado()}
            >
              {t('pacientes.adjuntos.borrar')}
            </Button>
          </>
        }
      >
        <Alert variant="warning">{t('pacientes.adjuntos.borrarTexto')}</Alert>
      </Dialog>
    </Card>
  );
};
