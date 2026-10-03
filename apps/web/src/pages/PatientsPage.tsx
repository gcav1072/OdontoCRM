import {
  DEFAULT_PAGE_SIZE,
  DOC_TYPES,
  PATIENT_STATUSES,
  SEXES,
  type DocType,
  type PatientStatus,
  type PatientSummary,
  type Sex,
} from '@odontocrm/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
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
import { ContactRound, RotateCcw, Search, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { apiErrorMessage } from '../lib/api';
import { patientsApi } from '../lib/endpoints';
import { formatNumber } from '../lib/format';
import { DOC_TYPE_LABELS, PATIENT_STATUS_LABELS, SEX_LABELS, t } from '../lib/i18n';
import { useAuth } from '../providers/AuthProvider';
import { LinkButton } from '../components/LinkButton';

const TAMANOS_PAGINA = [10, DEFAULT_PAGE_SIZE, 50] as const;

const varianteDeEstado = (status: PatientStatus) => {
  if (status === 'activo') return 'success' as const;
  if (status === 'inactivo') return 'neutral' as const;
  return 'info' as const;
};

/** Edad como número entero, o `null` si el campo está vacío. */
const aNumero = (valor: string): number | undefined => {
  const limpio = valor.trim();
  if (limpio === '') return undefined;
  const numero = Number.parseInt(limpio, 10);
  return Number.isNaN(numero) ? undefined : numero;
};

/**
 * `/pacientes`: listado con búsqueda diferida por nombre, documento o teléfono,
 * filtros por estado, tipo de documento, sexo y rango de edad, y paginación.
 */
export const PatientsPage = () => {
  const { hasPermission } = useAuth();

  const [busqueda, setBusqueda] = useState('');
  const [estado, setEstado] = useState<'' | PatientStatus>('');
  const [tipoDocumento, setTipoDocumento] = useState<'' | DocType>('');
  const [sexo, setSexo] = useState<'' | Sex>('');
  const [edadMin, setEdadMin] = useState('');
  const [edadMax, setEdadMax] = useState('');
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState<number>(DEFAULT_PAGE_SIZE);

  const busquedaDiferida = useDebouncedValue(busqueda, 350);
  const min = aNumero(edadMin);
  const max = aNumero(edadMax);
  const rangoInvalido = min !== undefined && max !== undefined && min > max;
  // Un rango invertido se avisa pero no se envía: la lista sigue mostrando
  // resultados útiles mientras se corrige el filtro.
  const edadDesde = rangoInvalido ? undefined : min;
  const edadHasta = rangoInvalido ? undefined : max;

  // Cualquier cambio de filtro vuelve a la primera página.
  useEffect(() => {
    setPagina(1);
  }, [busquedaDiferida, estado, tipoDocumento, sexo, edadDesde, edadHasta, porPagina]);

  const pacientesQuery = useQuery({
    queryKey: [
      'pacientes',
      {
        busqueda: busquedaDiferida,
        estado,
        tipoDocumento,
        sexo,
        edadDesde,
        edadHasta,
        pagina,
        porPagina,
      },
    ],
    queryFn: ({ signal }) =>
      patientsApi.list(
        {
          search: busquedaDiferida.trim() === '' ? undefined : busquedaDiferida.trim(),
          status: estado === '' ? undefined : estado,
          docType: tipoDocumento === '' ? undefined : tipoDocumento,
          sex: sexo === '' ? undefined : sexo,
          ageMin: edadDesde,
          ageMax: edadHasta,
          page: pagina,
          pageSize: porPagina,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  const limpiarFiltros = () => {
    setBusqueda('');
    setEstado('');
    setTipoDocumento('');
    setSexo('');
    setEdadMin('');
    setEdadMax('');
  };

  const hayFiltros =
    busqueda !== '' ||
    estado !== '' ||
    tipoDocumento !== '' ||
    sexo !== '' ||
    edadMin !== '' ||
    edadMax !== '';

  const datos = pacientesQuery.data;
  const total = datos?.total ?? 0;
  const totalPaginas = datos?.totalPages ?? 1;
  const desde = total === 0 ? 0 : (pagina - 1) * porPagina + 1;
  const hasta = Math.min(pagina * porPagina, total);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex-1">
            <CardTitle as="h2">{t('pacientes.lista.titulo')}</CardTitle>
            <p className="pt-1 text-sm text-ink-muted">{t('pacientes.lista.descripcion')}</p>
          </div>
          {hasPermission('patients:write') && (
            <LinkButton
              to="/registro"
              leadingIcon={<UserPlus className="size-4" aria-hidden="true" />}
            >
              {t('pacientes.lista.nuevo')}
            </LinkButton>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-4">
            <Field label={t('pacientes.lista.buscar')} className="lg:col-span-2">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  className="pl-9"
                  placeholder={t('pacientes.lista.buscarPlaceholder')}
                  value={busqueda}
                  onChange={(event) => setBusqueda(event.target.value)}
                />
              </div>
            </Field>

            <Field label={t('pacientes.filtro.estado')}>
              <Select
                value={estado}
                onChange={(event) => setEstado(event.target.value as '' | PatientStatus)}
              >
                <option value="">{t('pacientes.filtro.todos')}</option>
                {PATIENT_STATUSES.map((valor) => (
                  <option key={valor} value={valor}>
                    {PATIENT_STATUS_LABELS[valor]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t('pacientes.filtro.docType')}>
              <Select
                value={tipoDocumento}
                onChange={(event) => setTipoDocumento(event.target.value as '' | DocType)}
              >
                <option value="">{t('pacientes.filtro.todos')}</option>
                {DOC_TYPES.map((valor) => (
                  <option key={valor} value={valor}>
                    {DOC_TYPE_LABELS[valor]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t('pacientes.filtro.sexo')}>
              <Select value={sexo} onChange={(event) => setSexo(event.target.value as '' | Sex)}>
                <option value="">{t('pacientes.filtro.todos')}</option>
                {SEXES.map((valor) => (
                  <option key={valor} value={valor}>
                    {SEX_LABELS[valor]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t('pacientes.filtro.edadMin')}>
              <Input
                type="number"
                min={0}
                max={120}
                inputMode="numeric"
                value={edadMin}
                invalid={rangoInvalido}
                onChange={(event) => setEdadMin(event.target.value)}
              />
            </Field>

            <Field
              label={t('pacientes.filtro.edadMax')}
              error={rangoInvalido ? t('pacientes.filtro.rangoInvalido') : undefined}
            >
              <Input
                type="number"
                min={0}
                max={120}
                inputMode="numeric"
                value={edadMax}
                invalid={rangoInvalido}
                onChange={(event) => setEdadMax(event.target.value)}
              />
            </Field>

            <div className="flex items-end gap-2">
              <Field label={t('pacientes.lista.porPagina')} className="flex-1">
                <Select
                  value={String(porPagina)}
                  onChange={(event) => setPorPagina(Number(event.target.value))}
                >
                  {TAMANOS_PAGINA.map((tamano) => (
                    <option key={tamano} value={tamano}>
                      {tamano}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="secondary"
                onClick={limpiarFiltros}
                disabled={!hayFiltros}
                leadingIcon={<RotateCcw className="size-4" aria-hidden="true" />}
              >
                {t('pacientes.lista.limpiar')}
              </Button>
            </div>
          </div>

          {pacientesQuery.isError && (
            <Alert variant="danger" title={t('pacientes.lista.error')}>
              {apiErrorMessage(pacientesQuery.error)}
            </Alert>
          )}

          {pacientesQuery.isPending ? (
            <div className="py-10">
              <Spinner label={t('pacientes.lista.cargando')} showLabel />
            </div>
          ) : datos && datos.items.length === 0 ? (
            <EmptyState
              icon={<ContactRound className="size-6" aria-hidden="true" />}
              title={t('pacientes.lista.vacioTitulo')}
              description={t('pacientes.lista.vacio')}
              action={
                hasPermission('patients:write') ? (
                  <LinkButton to="/registro" variant="secondary" size="sm">
                    {t('pacientes.lista.nuevo')}
                  </LinkButton>
                ) : undefined
              }
            />
          ) : (
            <Table
              caption={t('pacientes.lista.paginacion', {
                pagina: formatNumber(pagina),
                paginas: formatNumber(totalPaginas),
                total: formatNumber(total),
              })}
            >
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('pacientes.lista.columna.documento')}</TableHead>
                  <TableHead>{t('pacientes.lista.columna.nombre')}</TableHead>
                  <TableHead>{t('pacientes.lista.columna.sexo')}</TableHead>
                  <TableHead>{t('pacientes.lista.columna.telefono')}</TableHead>
                  <TableHead>{t('pacientes.lista.columna.estado')}</TableHead>
                  <TableHead className="text-right">
                    {t('pacientes.lista.columna.acciones')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {datos?.items.map((paciente: PatientSummary) => (
                  <TableRow key={paciente.id}>
                    <TableCell className="font-mono text-xs">{paciente.document}</TableCell>
                    <TableCell>
                      <Link
                        to={`/pacientes/${paciente.id}`}
                        className="block font-medium text-ink hover:text-primary"
                      >
                        {paciente.fullName}
                      </Link>
                      <span className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs text-ink-subtle">
                        {t('pacientes.form.edad', { edad: paciente.age })}
                        {paciente.isMinor && <Badge variant="info">{t('pacientes.menor')}</Badge>}
                        {paciente.hasGuardian && (
                          <Badge variant="neutral">{t('pacientes.campo.guardian')}</Badge>
                        )}
                        {paciente.isFictitious && (
                          <Badge variant="warning">{t('pacientes.ficticio')}</Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-ink-muted">
                      {SEX_LABELS[paciente.sex]}
                    </TableCell>
                    <TableCell className="text-sm text-ink-muted">{paciente.phone}</TableCell>
                    <TableCell>
                      <Badge variant={varianteDeEstado(paciente.status)} dot>
                        {PATIENT_STATUS_LABELS[paciente.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="flex justify-end">
                        <LinkButton
                          to={`/pacientes/${paciente.id}`}
                          variant="ghost"
                          size="sm"
                          aria-label={`${t('pacientes.lista.ver')}: ${paciente.fullName}`}
                        >
                          {t('pacientes.lista.ver')}
                        </LinkButton>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-ink-subtle">
              {t('pacientes.lista.indicador', {
                desde: formatNumber(desde),
                hasta: formatNumber(hasta),
                total: formatNumber(total),
              })}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={pagina <= 1 || pacientesQuery.isFetching}
                onClick={() => setPagina((valor) => Math.max(1, valor - 1))}
              >
                {t('pacientes.lista.anterior')}
              </Button>
              <span className="text-xs text-ink-muted">
                {t('pacientes.lista.paginacion', {
                  pagina: formatNumber(pagina),
                  paginas: formatNumber(totalPaginas),
                  total: formatNumber(total),
                })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={pagina >= totalPaginas || pacientesQuery.isFetching}
                onClick={() => setPagina((valor) => valor + 1)}
              >
                {t('pacientes.lista.siguiente')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
