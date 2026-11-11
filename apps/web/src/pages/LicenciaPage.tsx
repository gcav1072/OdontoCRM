import type { AdminLicensingView } from '@odontocrm/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Spinner,
  Textarea,
} from '@odontocrm/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Upload } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import { NoticeBanner } from '../components/NoticeBanner';
import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import { licensingApi } from '../lib/endpoints';
import { formatDate } from '../lib/format';
import { t } from '../lib/i18n';
import {
  diasTexto,
  licensingKeys,
  origenTexto,
  tipoTexto,
  tituloEstado,
  tonoEstado,
  vencimientoTexto,
} from '../lib/licensing';
import { useAuth } from '../providers/AuthProvider';

/** Qué botón de copiar está mostrando «Copiado» en este momento. */
type CampoCopy = 'instalacion' | 'mensaje' | 'codigo' | null;

interface DatoProps {
  etiqueta: string;
  children: ReactNode;
}

/** Fila de la ficha: rótulo pequeño y valor. */
const Dato = ({ etiqueta, children }: DatoProps) => (
  <div className="min-w-0 space-y-0.5">
    <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{etiqueta}</dt>
    <dd className="break-words text-sm text-ink">{children}</dd>
  </div>
);

/**
 * `/licencia` ([ADR 0075](../../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)): el panel del
 * **administrador** para ver el estado de la prueba o de la licencia, copiar la solicitud que se manda al
 * proveedor y activar el archivo `.lic` que este devuelve.
 *
 * La licencia se verifica en el servidor, sin internet: aquí no hay claves ni nada parecido. Tras
 * activarla se renueva la sesión (`useAuth().refresh()`, el mismo `authApi.refresh()` del cliente) para
 * que el token nuevo recupere los permisos de escritura **sin volver a iniciar sesión**.
 *
 * El acceso lo corta la ruta (`RequirePermission permission="licensing:manage"`) y la API lo vuelve a
 * comprobar: sin el permiso la pantalla no se ve, pero tampoco se podría activar saltándosela.
 */
export const LicenciaPage = () => {
  const { refresh } = useAuth();
  const consultas = useQueryClient();
  const { notice, mostrar, exito, error, limpiar } = useNotice();

  const [copiado, setCopiado] = useState<CampoCopy>(null);
  const [licencia, setLicencia] = useState('');
  /** Nombre del archivo cargado (solo informativo); el texto vive en `licencia`. */
  const [archivo, setArchivo] = useState<string | null>(null);
  const inputArchivo = useRef<HTMLInputElement | null>(null);

  const estadoQuery = useQuery({
    queryKey: licensingKeys.estado,
    queryFn: ({ signal }) => licensingApi.status(signal),
  });

  const vista: AdminLicensingView | undefined = estadoQuery.data;

  /** Copia al portapapeles y deja «Copiado» dos segundos en el botón que se pulsó. */
  const copiar = async (texto: string, campo: Exclude<CampoCopy, null>): Promise<void> => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(campo);
      window.setTimeout(() => {
        setCopiado((actual) => (actual === campo ? null : actual));
      }, 2_000);
    } catch {
      // Sin permiso de portapapeles: el texto se puede seleccionar a mano.
      setCopiado(null);
    }
  };

  const activar = useMutation({
    mutationFn: (texto: string) => licensingApi.activate(texto),
    onSuccess: async (nueva) => {
      consultas.setQueryData(licensingKeys.estado, nueva);
      setLicencia('');
      setArchivo(null);
      exito(t('licencia.activar.exito'));
      void consultas.invalidateQueries({ queryKey: licensingKeys.publico });
      // El servidor filtra los permisos según la licencia: sin renovar la sesión, la
      // interfaz seguiría en modo consulta hasta el siguiente refresco del token.
      await refresh();
      await consultas.invalidateQueries({ queryKey: licensingKeys.estado });
    },
    onError: (fallo) => error(apiErrorMessage(fallo), t('licencia.activar.tituloError')),
  });

  /** Lee el `.lic` elegido y lo deja en el área de texto (el servidor acepta el texto). */
  const elegirArchivo = async (file: File): Promise<void> => {
    try {
      const texto = (await file.text()).trim();
      if (texto === '') {
        error(t('licencia.activar.archivoVacio'));
        return;
      }
      setLicencia(texto);
      setArchivo(file.name);
    } catch {
      error(t('licencia.activar.errorArchivo'));
    }
  };

  const enviar = (): void => {
    const texto = licencia.trim();
    if (texto === '') {
      mostrar({ variant: 'warning', message: t('licencia.activar.vacio') });
      return;
    }
    activar.mutate(texto);
  };

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden="true" />
            {t('licencia.titulo')}
          </CardTitle>
          <p className="pt-1 text-sm text-ink-muted">{t('licencia.descripcion')}</p>
        </CardHeader>
      </Card>

      {estadoQuery.isError ? (
        <Alert variant="danger" title={t('licencia.error')}>
          {apiErrorMessage(estadoQuery.error)}
        </Alert>
      ) : estadoQuery.isPending || vista === undefined ? (
        <div className="py-10">
          <Spinner label={t('licencia.cargando')} showLabel />
        </div>
      ) : (
        <>
          <Alert variant={tonoEstado(vista.estado)} title={tituloEstado(vista.estado)}>
            {vista.mensaje}
          </Alert>

          <Card>
            <CardHeader>
              <CardTitle as="h2">{t('licencia.detalle.titulo')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-4 @2xl:grid-cols-2">
                <Dato etiqueta={t('licencia.detalle.origen')}>{origenTexto(vista.origen)}</Dato>
                <Dato etiqueta={t('licencia.detalle.tipo')}>
                  {vista.tipo === null ? (
                    t('comun.sinDato')
                  ) : (
                    <Badge variant="primary">{tipoTexto(vista.tipo)}</Badge>
                  )}
                </Dato>
                <Dato etiqueta={t('licencia.detalle.vence')}>{vencimientoTexto(vista)}</Dato>
                <Dato etiqueta={t('licencia.detalle.dias')}>
                  {vista.diasRestantes === null
                    ? t('comun.sinDato')
                    : diasTexto(vista.diasRestantes)}
                </Dato>
                <Dato etiqueta={t('licencia.detalle.instaladaEn')}>
                  {formatDate(vista.instaladaEn)}
                </Dato>
                <Dato etiqueta={t('licencia.detalle.ultimaVez')}>
                  {formatDate(vista.ultimaVezVisto)}
                </Dato>
                <Dato etiqueta={t('licencia.detalle.consultorio')}>
                  {vista.consultorio.nombre}
                  {vista.consultorio.rif === null
                    ? null
                    : ` · ${t('licencia.detalle.rif')} ${vista.consultorio.rif}`}
                </Dato>
                <Dato etiqueta={t('licencia.detalle.instalacion')}>
                  <span className="flex flex-wrap items-center gap-2">
                    <code className="break-all text-xs">{vista.instalacion}</code>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void copiar(vista.instalacion, 'instalacion')}
                      leadingIcon={
                        copiado === 'instalacion' ? (
                          <Check className="size-3.5" aria-hidden="true" />
                        ) : (
                          <Copy className="size-3.5" aria-hidden="true" />
                        )
                      }
                    >
                      {copiado === 'instalacion' ? t('comun.copiado') : t('comun.copiar')}
                    </Button>
                  </span>
                </Dato>
              </dl>

              <div className="mt-5 border-t border-border pt-4">
                <p className="text-sm font-semibold text-ink">{t('licencia.licencia.titulo')}</p>
                {vista.licencia === null ? (
                  <p className="pt-1 text-sm text-ink-muted">
                    {t('licencia.licencia.sinLicencia')}
                  </p>
                ) : (
                  <dl className="mt-3 grid gap-x-6 gap-y-4 @2xl:grid-cols-2">
                    <Dato etiqueta={t('licencia.licencia.identificador')}>
                      <code className="text-xs">{vista.licencia.id}</code>
                    </Dato>
                    <Dato etiqueta={t('licencia.licencia.cliente')}>
                      {vista.licencia.cliente.nombre}
                      {vista.licencia.cliente.rif === undefined
                        ? null
                        : ` · ${vista.licencia.cliente.rif}`}
                    </Dato>
                    <Dato etiqueta={t('licencia.licencia.emitida')}>
                      {formatDate(vista.licencia.emitidaEn)}
                    </Dato>
                    <Dato etiqueta={t('licencia.licencia.activada')}>
                      {formatDate(vista.licencia.activadaEn)}
                    </Dato>
                  </dl>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-5 @5xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle as="h2">{t('licencia.solicitud.titulo')}</CardTitle>
                <CardDescription>{t('licencia.solicitud.descripcion')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Field label={t('licencia.solicitud.mensaje')}>
                  <Textarea
                    readOnly
                    rows={6}
                    value={vista.solicitud.texto}
                    className="font-mono text-xs"
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="secondary"
                    onClick={() => void copiar(vista.solicitud.texto, 'mensaje')}
                    leadingIcon={
                      copiado === 'mensaje' ? (
                        <Check className="size-4" aria-hidden="true" />
                      ) : (
                        <Copy className="size-4" aria-hidden="true" />
                      )
                    }
                  >
                    {copiado === 'mensaje'
                      ? t('comun.copiado')
                      : t('licencia.solicitud.copiarMensaje')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void copiar(vista.solicitud.codigo, 'codigo')}
                    leadingIcon={
                      copiado === 'codigo' ? (
                        <Check className="size-4" aria-hidden="true" />
                      ) : (
                        <Copy className="size-4" aria-hidden="true" />
                      )
                    }
                  >
                    {copiado === 'codigo'
                      ? t('comun.copiado')
                      : t('licencia.solicitud.copiarCodigo')}
                  </Button>
                </div>
                <Field label={t('licencia.solicitud.codigo')}>
                  <Input readOnly value={vista.solicitud.codigo} className="font-mono text-xs" />
                </Field>
                <p className="text-xs text-ink-subtle">{t('licencia.solicitud.aviso')}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2">{t('licencia.activar.titulo')}</CardTitle>
                <CardDescription>{t('licencia.activar.descripcion')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Field label={t('licencia.activar.token')} hint={t('licencia.activar.tokenAyuda')}>
                  <Textarea
                    rows={5}
                    value={licencia}
                    onChange={(event) => setLicencia(event.target.value)}
                    placeholder={t('licencia.activar.placeholder')}
                    className="font-mono text-xs"
                    disabled={activar.isPending}
                  />
                </Field>

                <div className="flex flex-wrap items-center gap-3">
                  <input
                    ref={inputArchivo}
                    type="file"
                    accept=".lic,.txt,text/plain"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file !== undefined) void elegirArchivo(file);
                    }}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => inputArchivo.current?.click()}
                    leadingIcon={<Upload className="size-4" aria-hidden="true" />}
                    disabled={activar.isPending}
                  >
                    {t('licencia.activar.subir')}
                  </Button>
                  {archivo !== null && (
                    <span className="text-xs text-ink-muted">
                      {t('licencia.activar.archivo', { archivo })}
                    </span>
                  )}
                </div>

                <Button
                  onClick={enviar}
                  loading={activar.isPending}
                  loadingLabel={t('licencia.activar.activando')}
                  disabled={licencia.trim() === ''}
                >
                  {t('licencia.activar.boton')}
                </Button>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
};
