import {
  CLINICAL_ATTACHMENT_KINDS,
  clinicalAttachmentKindLabel,
  type ClinicalAttachment,
  type ClinicalAttachmentKind,
} from '@odontocrm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Spinner,
  cn,
} from '@odontocrm/ui';
import { FileText, ImageOff, Plus, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useNotice } from '../../hooks/useNotice';
import { apiErrorMessage } from '../../lib/api';
import { clinicalApi } from '../../lib/endpoints';
import { formatDate } from '../../lib/format';
import { t } from '../../lib/i18n';
import { NoticeBanner } from '../NoticeBanner';

/**
 * Adjuntos de la sesión: radiografías, fotos clínicas y documentos.
 *
 * La **miniatura la hace el navegador**: el archivo se pide por el endpoint
 * autorizado (nunca por una URL pública) y se pinta pequeño. No hay generación de
 * miniaturas en el servidor a propósito: haría falta una librería de imágenes para
 * un recorte que el navegador ya sabe hacer, y el original tiene que estar igual de
 * accesible para el visor.
 *
 * El **visor** abre el adjunto a pantalla completa con zoom (botones y rueda del
 * ratón); los PDF se muestran en su visor incrustado.
 */

const TAMANO_MAXIMO = 20 * 1024 * 1024;

export interface SessionAttachmentsProps {
  sessionId: string;
  /** Sin permiso de escritura no se sube ni se borra nada. */
  canWrite: boolean;
  /** La sesión cerrada conserva sus adjuntos: son parte del documento. */
  sessionClosed: boolean;
}

/** Objeto URL del adjunto, revocado al desmontar (no se filtra memoria). */
const useAttachmentBlob = (
  sessionId: string,
  attachment: ClinicalAttachment | null,
): { url: string | null; loading: boolean; error: boolean } => {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (attachment === null) {
      setUrl(null);
      return;
    }
    let vivo = true;
    let creado: string | null = null;
    setLoading(true);
    setError(false);

    clinicalApi
      .downloadAttachment(sessionId, attachment.id)
      .then((blob) => {
        if (!vivo) return;
        creado = URL.createObjectURL(blob);
        setUrl(creado);
      })
      .catch(() => {
        if (vivo) setError(true);
      })
      .finally(() => {
        if (vivo) setLoading(false);
      });

    return () => {
      vivo = false;
      if (creado !== null) URL.revokeObjectURL(creado);
      setUrl(null);
    };
  }, [sessionId, attachment]);

  return { url, loading, error };
};

/** Miniatura: la imagen se pinta pequeña; un PDF se representa con su icono. */
const Thumbnail = ({
  sessionId,
  attachment,
  onOpen,
  onDelete,
  canWrite,
  sessionClosed,
}: {
  sessionId: string;
  attachment: ClinicalAttachment;
  onOpen: () => void;
  onDelete: () => void;
  canWrite: boolean;
  sessionClosed: boolean;
}) => {
  const esPdf = attachment.mime === 'application/pdf';
  // Las miniaturas de PDF no se piden: no hay nada que enseñar y son pesados.
  const { url } = useAttachmentBlob(sessionId, esPdf ? null : attachment);

  return (
    <li className="overflow-hidden rounded-control border border-border">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full bg-surface-muted transition-colors hover:bg-surface"
        aria-label={t('clinica.adjunto.abrir', { nombre: attachment.originalName })}
      >
        <span className="flex h-28 items-center justify-center">
          {esPdf ? (
            <FileText className="size-10 text-ink-subtle" aria-hidden />
          ) : url === null ? (
            <ImageOff className="size-8 text-ink-subtle" aria-hidden />
          ) : (
            <img
              src={url}
              alt={attachment.caption ?? attachment.originalName}
              className="h-28 w-full object-cover"
            />
          )}
        </span>
      </button>

      <div className="space-y-1 border-t border-border px-3 py-2">
        <p className="truncate text-xs font-medium text-ink" title={attachment.originalName}>
          {attachment.caption ?? attachment.originalName}
        </p>
        <p className="text-xs text-ink-subtle">
          {clinicalAttachmentKindLabel(attachment.kind)}
          {attachment.toothNumber === null
            ? ''
            : ` · ${t('clinica.adjunto.pieza', { pieza: attachment.toothNumber })}`}
          {` · ${formatDate(attachment.createdAt)}`}
        </p>
        {canWrite && !sessionClosed && (
          <Button
            variant="ghost"
            size="sm"
            className="text-danger"
            leadingIcon={<Trash2 className="size-3.5" aria-hidden />}
            onClick={onDelete}
          >
            {t('clinica.adjunto.quitar')}
          </Button>
        )}
      </div>
    </li>
  );
};

/** Visor con zoom: botones, rueda del ratón y teclas `+` / `-`. */
const AttachmentViewer = ({
  sessionId,
  attachment,
  onClose,
}: {
  sessionId: string;
  attachment: ClinicalAttachment;
  onClose: () => void;
}) => {
  const [zoom, setZoom] = useState(1);
  const { url, loading, error } = useAttachmentBlob(sessionId, attachment);

  useEffect(() => {
    const alTeclear = (evento: KeyboardEvent): void => {
      if (evento.key === 'Escape') onClose();
      if (evento.key === '+' || evento.key === '=') setZoom((valor) => Math.min(4, valor + 0.25));
      if (evento.key === '-') setZoom((valor) => Math.max(0.5, valor - 0.25));
    };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/80"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.originalName}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 bg-black/60 px-4 py-2 text-white">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {attachment.caption ?? attachment.originalName}
          </p>
          <p className="text-xs text-white/70">
            {clinicalAttachmentKindLabel(attachment.kind)}
            {attachment.toothNumber === null
              ? ''
              : ` · ${t('clinica.adjunto.pieza', { pieza: attachment.toothNumber })}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-white"
            aria-label={t('clinica.adjunto.alejar')}
            onClick={() => setZoom((valor) => Math.max(0.5, valor - 0.25))}
            leadingIcon={<ZoomOut className="size-4" aria-hidden />}
          >
            {Math.round(zoom * 100)} %
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-white"
            aria-label={t('clinica.adjunto.acercar')}
            onClick={() => setZoom((valor) => Math.min(4, valor + 0.25))}
            leadingIcon={<ZoomIn className="size-4" aria-hidden />}
          >
            {t('clinica.adjunto.acercar')}
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('comun.cerrar')}
          </Button>
        </div>
      </div>

      <div
        className="flex-1 overflow-auto p-4"
        onWheel={(evento) => {
          if (!evento.ctrlKey) return;
          evento.preventDefault();
          setZoom((valor) =>
            Math.min(4, Math.max(0.5, valor + (evento.deltaY < 0 ? 0.25 : -0.25))),
          );
        }}
      >
        {loading && <Spinner showLabel label={t('comun.cargando')} />}
        {error && <Alert variant="danger">{t('clinica.adjunto.error')}</Alert>}
        {url !== null &&
          (attachment.mime === 'application/pdf' ? (
            <iframe
              title={attachment.originalName}
              src={url}
              className="h-[85vh] w-full rounded-control bg-white"
            />
          ) : (
            <img
              src={url}
              alt={attachment.caption ?? attachment.originalName}
              style={{ transform: `scale(${String(zoom)})`, transformOrigin: 'top left' }}
              className="rounded-control bg-white"
            />
          ))}
      </div>
    </div>
  );
};

export const SessionAttachments = ({
  sessionId,
  canWrite,
  sessionClosed,
}: SessionAttachmentsProps) => {
  const cliente = useQueryClient();
  const { notice, limpiar, exito, error } = useNotice();
  const selectorRef = useRef<HTMLInputElement | null>(null);

  const [archivo, setArchivo] = useState<File | null>(null);
  const [tipo, setTipo] = useState<ClinicalAttachmentKind>('radiografia');
  const [pieza, setPieza] = useState('');
  const [leyenda, setLeyenda] = useState('');
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null);
  const [visor, setVisor] = useState<ClinicalAttachment | null>(null);

  const clave = ['clinica', 'adjuntos', sessionId] as const;
  const adjuntosQuery = useQuery({
    queryKey: clave,
    queryFn: ({ signal }) => clinicalApi.attachments(sessionId, signal),
  });

  const refrescar = (): void => {
    void cliente.invalidateQueries({ queryKey: clave });
  };

  const subir = useMutation({
    mutationFn: (entrada: {
      file: File;
      kind: ClinicalAttachmentKind;
      caption: string;
      toothNumber: number | null;
    }) => clinicalApi.uploadAttachment(sessionId, entrada),
    onSuccess: () => {
      setArchivo(null);
      setLeyenda('');
      setPieza('');
      if (selectorRef.current !== null) selectorRef.current.value = '';
      refrescar();
      exito(t('clinica.adjunto.exito.subido'));
    },
    onError: (fallo) => error(apiErrorMessage(fallo)),
  });

  const borrar = useMutation({
    mutationFn: (id: string) => clinicalApi.deleteAttachment(sessionId, id),
    onSuccess: () => {
      refrescar();
      exito(t('clinica.adjunto.exito.quitado'));
    },
    onError: (fallo) => error(apiErrorMessage(fallo)),
  });

  const elegir = (elegido: File | null): void => {
    setErrorArchivo(null);
    if (elegido === null) {
      setArchivo(null);
      return;
    }
    if (elegido.size > TAMANO_MAXIMO) {
      setErrorArchivo(t('clinica.adjunto.muyGrande'));
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(elegido.type)) {
      setErrorArchivo(t('clinica.adjunto.tipoNoValido'));
      return;
    }
    setArchivo(elegido);
  };

  const adjuntos = adjuntosQuery.data?.items ?? [];

  return (
    <Card>
      <CardHeader className="flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>{t('clinica.adjunto.titulo')}</CardTitle>
          <p className="mt-0.5 text-sm text-ink-muted">{t('clinica.adjunto.texto')}</p>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <NoticeBanner notice={notice} onClose={limpiar} className="mb-0" />

        {adjuntosQuery.isLoading && <Spinner showLabel label={t('comun.cargando')} />}
        {adjuntosQuery.isError && (
          <Alert variant="danger">{apiErrorMessage(adjuntosQuery.error)}</Alert>
        )}

        {adjuntos.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {adjuntos.map((adjunto) => (
              <Thumbnail
                key={adjunto.id}
                sessionId={sessionId}
                attachment={adjunto}
                canWrite={canWrite}
                sessionClosed={sessionClosed}
                onOpen={() => setVisor(adjunto)}
                onDelete={() => borrar.mutate(adjunto.id)}
              />
            ))}
          </ul>
        )}

        {adjuntos.length === 0 && !adjuntosQuery.isLoading && (
          <p className="text-sm text-ink-muted">{t('clinica.adjunto.vacio')}</p>
        )}

        {canWrite && !sessionClosed && (
          <div className="rounded-control border border-dashed border-border-strong p-3">
            <p className="text-sm font-medium text-ink">{t('clinica.adjunto.subir')}</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label={t('clinica.adjunto.archivo')}>
                <input
                  ref={selectorRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  className="w-full text-sm text-ink"
                  onChange={(evento) => elegir(evento.target.files?.[0] ?? null)}
                />
              </Field>
              <Field label={t('clinica.adjunto.tipo')}>
                <Select
                  value={tipo}
                  onChange={(evento) => setTipo(evento.target.value as ClinicalAttachmentKind)}
                >
                  {CLINICAL_ATTACHMENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {clinicalAttachmentKindLabel(kind)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('clinica.adjunto.piezaLabel')} hint={t('clinica.adjunto.piezaAyuda')}>
                <Input
                  value={pieza}
                  inputMode="numeric"
                  placeholder="26"
                  onChange={(evento) => setPieza(evento.target.value.replace(/\D/g, ''))}
                />
              </Field>
              <Field label={t('clinica.adjunto.leyenda')}>
                <Input
                  value={leyenda}
                  maxLength={240}
                  placeholder={t('clinica.adjunto.leyendaPlaceholder')}
                  onChange={(evento) => setLeyenda(evento.target.value)}
                />
              </Field>
            </div>

            {errorArchivo !== null && (
              <Alert variant="warning" className="mt-3">
                {errorArchivo}
              </Alert>
            )}

            <div className="mt-3">
              <Button
                loading={subir.isPending}
                disabled={archivo === null}
                leadingIcon={<Plus className="size-4" aria-hidden />}
                onClick={() => {
                  if (archivo === null) return;
                  subir.mutate({
                    file: archivo,
                    kind: tipo,
                    caption: leyenda,
                    toothNumber: pieza === '' ? null : Number(pieza),
                  });
                }}
              >
                {t('clinica.adjunto.subirAccion')}
              </Button>
            </div>
          </div>
        )}

        {sessionClosed && adjuntos.length > 0 && (
          <p className="text-xs text-ink-subtle">{t('clinica.adjunto.sesionCerrada')}</p>
        )}
      </CardContent>

      {visor !== null && (
        <AttachmentViewer sessionId={sessionId} attachment={visor} onClose={() => setVisor(null)} />
      )}
    </Card>
  );
};

/** Icono de la tarjeta de adjuntos: se usa en la pestaña cuando no hay ninguno. */
export const AttachmentIcon = ({ className }: { className?: string }) => (
  <FileText className={cn('size-5', className)} aria-hidden />
);

/**
 * Los adjuntos de **todas** las sesiones del paciente: es lo que se ve en su ficha
 * (radiografías y fotos de sus visitas, cada una con la sesión a la que pertenece).
 * Solo lectura: se suben desde la sesión en la que se tomaron.
 */
export const PatientAttachmentsCard = ({ patientId }: { patientId: string }) => {
  const [visor, setVisor] = useState<ClinicalAttachment | null>(null);
  const clave = ['clinica', 'adjuntos-paciente', patientId] as const;

  const adjuntosQuery = useQuery({
    queryKey: clave,
    queryFn: ({ signal }) => clinicalApi.patientAttachments(patientId, signal),
  });

  const adjuntos = adjuntosQuery.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('clinica.adjunto.paciente.titulo')}</CardTitle>
        <p className="mt-0.5 text-sm text-ink-muted">{t('clinica.adjunto.paciente.texto')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {adjuntosQuery.isLoading && <Spinner showLabel label={t('comun.cargando')} />}
        {adjuntosQuery.isError && (
          <Alert variant="danger">{apiErrorMessage(adjuntosQuery.error)}</Alert>
        )}
        {!adjuntosQuery.isLoading && adjuntos.length === 0 && (
          <p className="text-sm text-ink-muted">{t('clinica.adjunto.paciente.vacio')}</p>
        )}

        {adjuntos.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {adjuntos.map((adjunto) => (
              <Thumbnail
                key={adjunto.id}
                sessionId={adjunto.sessionId}
                attachment={adjunto}
                canWrite={false}
                sessionClosed
                onOpen={() => setVisor(adjunto)}
                onDelete={() => undefined}
              />
            ))}
          </ul>
        )}

        {visor !== null && (
          <AttachmentViewer
            sessionId={visor.sessionId}
            attachment={visor}
            onClose={() => setVisor(null)}
          />
        )}
      </CardContent>
    </Card>
  );
};
