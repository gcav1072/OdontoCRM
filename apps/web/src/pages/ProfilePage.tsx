import { updateClinicProfileSchema, updateDentistProfileSchema } from '@odontocrm/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Spinner,
} from '@odontocrm/ui';
import { useEffect, useState } from 'react';

import { NoticeBanner } from '../components/NoticeBanner';
import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import { identityApi } from '../lib/endpoints';
import { t } from '../lib/i18n';
import { useAuth } from '../providers/AuthProvider';
import { CLINIC_IDENTITY_QUERY_KEY, useClinicIdentity } from '../providers/ClinicIdentityProvider';

/**
 * **Mi perfil**: el odontólogo edita sus datos profesionales (los que firman sus
 * documentos) y, si es el **titular**, también los del consultorio y el logo.
 *
 * Es la mitad «esa cuenta en cuestión» de la regla del ADR 0056: cada quien edita lo
 * suyo, y el administrador puede editar a cualquiera desde `/usuarios`. El **motivo es
 * obligatorio** y todo cambio queda en la auditoría.
 */
export const ProfilePage = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const identidad = useClinicIdentity();
  const { notice, limpiar, exito, error } = useNotice();

  const [mpps, setMpps] = useState('');
  const [especialidad, setEspecialidad] = useState('');
  const [colegiatura, setColegiatura] = useState('');
  const [correo, setCorreo] = useState('');
  const [motivoPerfil, setMotivoPerfil] = useState('');
  const [guardandoPerfil, setGuardandoPerfil] = useState(false);

  const [nombre, setNombre] = useState('');
  const [rif, setRif] = useState('');
  const [direccion, setDireccion] = useState('');
  const [telefono, setTelefono] = useState('');
  const [correoConsultorio, setCorreoConsultorio] = useState('');
  const [motivoConsultorio, setMotivoConsultorio] = useState('');
  const [guardandoConsultorio, setGuardandoConsultorio] = useState(false);
  const [logo, setLogo] = useState<File | null>(null);

  const esTitular =
    identidad !== null &&
    identidad.titularUsername !== null &&
    identidad.titularUsername === user?.username;

  const perfilConsulta = useQuery({
    queryKey: ['mi-perfil-odontologo'],
    queryFn: ({ signal }) => identityApi.myDentistProfile(signal),
    staleTime: 30_000,
  });

  useEffect(() => {
    const perfil = perfilConsulta.data?.profile ?? null;
    if (perfil === null) return;
    setMpps(perfil.mpps);
    setEspecialidad(perfil.specialty);
    setColegiatura(perfil.licenseNumber ?? '');
    setCorreo(perfil.contactEmail ?? '');
  }, [perfilConsulta.data]);

  useEffect(() => {
    if (identidad === null) return;
    setNombre(identidad.clinic.name);
    setRif(identidad.clinic.rif ?? '');
    setDireccion(identidad.clinic.address);
    setTelefono(identidad.clinic.phones[0] ?? '');
    setCorreoConsultorio(identidad.clinic.email ?? '');
  }, [identidad]);

  const guardarPerfil = async () => {
    limpiar();
    const revision = updateDentistProfileSchema.safeParse({
      mpps,
      specialty: especialidad,
      licenseNumber: colegiatura === '' ? null : colegiatura,
      contactEmail: correo === '' ? null : correo,
      reason: motivoPerfil,
    });
    if (!revision.success) {
      error(revision.error.issues[0]?.message ?? t('perfil.mio.error'));
      return;
    }
    setGuardandoPerfil(true);
    try {
      await identityApi.updateMyDentistProfile(revision.data);
      await perfilConsulta.refetch();
      setMotivoPerfil('');
      exito(t('perfil.mio.ok'));
    } catch (fallo) {
      error(apiErrorMessage(fallo));
    } finally {
      setGuardandoPerfil(false);
    }
  };

  const guardarConsultorio = async () => {
    limpiar();
    const revision = updateClinicProfileSchema.safeParse({
      name: nombre,
      legalName: identidad?.clinic.legalName ?? null,
      address: direccion,
      city: identidad?.clinic.city ?? null,
      phones: telefono.trim() === '' ? [] : [telefono.trim()],
      email: correoConsultorio === '' ? null : correoConsultorio,
      rif: rif === '' ? null : rif,
      website: identidad?.clinic.website ?? null,
      reason: motivoConsultorio,
    });
    if (!revision.success) {
      error(revision.error.issues[0]?.message ?? t('perfil.mio.error'));
      return;
    }
    setGuardandoConsultorio(true);
    try {
      await identityApi.updateClinic(revision.data);
      if (logo !== null) await identityApi.uploadLogo(logo);
      setLogo(null);
      setMotivoConsultorio('');
      await queryClient.invalidateQueries({ queryKey: CLINIC_IDENTITY_QUERY_KEY });
      exito(t('perfil.mio.consultorioOk'));
    } catch (fallo) {
      error(apiErrorMessage(fallo));
    } finally {
      setGuardandoConsultorio(false);
    }
  };

  return (
    <div className="space-y-5">
      <NoticeBanner notice={notice} onClose={limpiar} />

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t('perfil.mio.titulo')}</CardTitle>
          <CardDescription>{t('perfil.mio.descripcion')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {perfilConsulta.isPending ? (
            <Spinner label={t('usuarios.perfil.cargando')} showLabel />
          ) : perfilConsulta.data?.profile === null ? (
            <Alert variant="warning" title={t('perfil.mio.sinPerfil')}>
              {t('perfil.completar.texto')}
            </Alert>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('perfil.campo.mpps')} required>
                  <Input value={mpps} onChange={(event) => setMpps(event.target.value)} />
                </Field>
                <Field label={t('perfil.campo.especialidad')} required>
                  <Input
                    value={especialidad}
                    onChange={(event) => setEspecialidad(event.target.value)}
                  />
                </Field>
                <Field label={t('perfil.campo.colegiatura')}>
                  <Input
                    value={colegiatura}
                    onChange={(event) => setColegiatura(event.target.value)}
                  />
                </Field>
                <Field label={t('perfil.campo.correo')}>
                  <Input
                    type="email"
                    value={correo}
                    onChange={(event) => setCorreo(event.target.value)}
                  />
                </Field>
              </div>

              <Field label={t('perfil.mio.motivo')} hint={t('perfil.mio.motivoAyuda')} required>
                <Input
                  value={motivoPerfil}
                  onChange={(event) => setMotivoPerfil(event.target.value)}
                />
              </Field>

              <Button loading={guardandoPerfil} onClick={() => void guardarPerfil()}>
                {t('perfil.mio.guardar')}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {esTitular && (
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t('perfil.consultorio.titulo')}</CardTitle>
            <CardDescription>{t('perfil.consultorio.ayuda')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('perfil.consultorio.nombre')} required>
                <Input value={nombre} onChange={(event) => setNombre(event.target.value)} />
              </Field>
              <Field label={t('perfil.consultorio.rif')}>
                <Input
                  placeholder="J-12345678-9"
                  value={rif}
                  onChange={(event) => setRif(event.target.value)}
                />
              </Field>
              <Field label={t('perfil.consultorio.direccion')} required>
                <Input value={direccion} onChange={(event) => setDireccion(event.target.value)} />
              </Field>
              <Field label={t('perfil.consultorio.telefono')}>
                <Input value={telefono} onChange={(event) => setTelefono(event.target.value)} />
              </Field>
              <Field label={t('perfil.consultorio.correo')}>
                <Input
                  type="email"
                  value={correoConsultorio}
                  onChange={(event) => setCorreoConsultorio(event.target.value)}
                />
              </Field>
              <Field label={t('perfil.consultorio.logo')} hint={t('perfil.consultorio.logoAyuda')}>
                <input
                  type="file"
                  accept="image/svg+xml"
                  className="block w-full text-sm text-ink-muted"
                  onChange={(event) => setLogo(event.target.files?.[0] ?? null)}
                />
              </Field>
            </div>

            <Field label={t('perfil.mio.motivo')} hint={t('perfil.mio.motivoAyuda')} required>
              <Input
                value={motivoConsultorio}
                onChange={(event) => setMotivoConsultorio(event.target.value)}
              />
            </Field>

            <Button loading={guardandoConsultorio} onClick={() => void guardarConsultorio()}>
              {t('perfil.mio.guardar')}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
