import { updateDentistProfileSchema, type DentistProfile } from '@odontocrm/contracts';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Field, Input, Spinner } from '@odontocrm/ui';
import { useEffect, useState } from 'react';

import { NoticeBanner } from '../NoticeBanner';
import { useNotice } from '../../hooks/useNotice';
import { apiErrorMessage } from '../../lib/api';
import { identityApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';

const VACIO: DentistProfile = {
  mpps: '',
  specialty: '',
  licenseNumber: '',
  contactEmail: '',
};

/**
 * El **perfil profesional** de un odontólogo, dentro de «editar usuario».
 *
 * Lo puede editar esa cuenta (en «Mi perfil») y el administrador (aquí). Es el dato que
 * firma sus documentos: el MPPS y la especialidad salen impresos en el récipe. El
 * **motivo es obligatorio** y el cambio queda en la **auditoría** (ADR 0056) — igual que
 * el resto de la edición del usuario.
 *
 * Si el odontólogo aún no completó su perfil en su primer acceso, aquí se dice; el
 * administrador puede rellenarlo por él (útil cuando alguien no entra nunca).
 */
export const EditUserProfileSection = ({
  userId,
  esOdontologo,
}: {
  userId: string;
  esOdontologo: boolean;
}) => {
  const { notice, limpiar, exito, error } = useNotice();
  const [valores, setValores] = useState<DentistProfile>(VACIO);
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);

  const consulta = useQuery({
    queryKey: ['perfil-odontologo', userId],
    queryFn: ({ signal }) => identityApi.dentistProfile(userId, signal),
    enabled: esOdontologo,
  });

  useEffect(() => {
    if (consulta.data?.profile !== undefined && consulta.data.profile !== null) {
      setValores(consulta.data.profile);
    }
  }, [consulta.data]);

  if (!esOdontologo) return null;

  const guardar = async () => {
    limpiar();
    const revision = updateDentistProfileSchema.safeParse({ ...valores, reason: motivo });
    if (!revision.success) {
      error(revision.error.issues[0]?.message ?? t('usuarios.perfil.error'));
      return;
    }
    setGuardando(true);
    try {
      await identityApi.updateDentistProfile(userId, revision.data);
      await consulta.refetch();
      setMotivo('');
      exito(t('usuarios.perfil.ok'));
    } catch (fallo) {
      error(apiErrorMessage(fallo));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <section className="space-y-4 rounded-card border border-border p-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">{t('usuarios.perfil.titulo')}</h3>
        <p className="text-xs text-ink-subtle">{t('usuarios.perfil.ayuda')}</p>
      </div>

      {notice !== null && <NoticeBanner notice={notice} onClose={limpiar} />}

      {consulta.isPending ? (
        <Spinner label={t('usuarios.perfil.cargando')} showLabel />
      ) : consulta.data?.needsProfile === true ? (
        <Alert variant="warning" title={t('usuarios.perfil.pendienteTitulo')}>
          {t('usuarios.perfil.pendienteTexto')}
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('perfil.campo.mpps')}>
          <Input
            value={valores.mpps}
            onChange={(event) => setValores({ ...valores, mpps: event.target.value })}
          />
        </Field>
        <Field label={t('perfil.campo.especialidad')}>
          <Input
            value={valores.specialty}
            onChange={(event) => setValores({ ...valores, specialty: event.target.value })}
          />
        </Field>
        <Field label={t('perfil.campo.colegiatura')}>
          <Input
            value={valores.licenseNumber ?? ''}
            onChange={(event) => setValores({ ...valores, licenseNumber: event.target.value })}
          />
        </Field>
        <Field label={t('perfil.campo.correo')}>
          <Input
            type="email"
            value={valores.contactEmail ?? ''}
            onChange={(event) => setValores({ ...valores, contactEmail: event.target.value })}
          />
        </Field>
      </div>

      <Field label={t('perfil.mio.motivo')} hint={t('perfil.mio.motivoAyuda')} required>
        <Input
          placeholder={t('usuarios.form.motivoPlaceholder')}
          value={motivo}
          onChange={(event) => setMotivo(event.target.value)}
        />
      </Field>

      <Button variant="secondary" loading={guardando} onClick={() => void guardar()}>
        {t('usuarios.perfil.guardar')}
      </Button>
    </section>
  );
};
