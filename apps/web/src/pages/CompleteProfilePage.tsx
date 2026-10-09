import { completeOnboardingSchema } from '@odontocrm/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
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
} from '@odontocrm/ui';
import { Stethoscope } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import type { z } from 'zod';

import { NoticeBanner } from '../components/NoticeBanner';
import { ThemeSelector } from '../components/shell/ThemeSelector';
import { useNotice } from '../hooks/useNotice';
import { apiErrorMessage } from '../lib/api';
import { identityApi } from '../lib/endpoints';
import { applyApiFieldErrors } from '../lib/forms';
import { t } from '../lib/i18n';
import { CLINIC_IDENTITY_QUERY_KEY, useClinicIdentity } from '../providers/ClinicIdentityProvider';
import { useAuth } from '../providers/AuthProvider';

type ValoresFormulario = z.input<typeof completeOnboardingSchema>;
type ValoresEnviados = z.output<typeof completeOnboardingSchema>;

/**
 * El **primer acceso de un odontólogo**: completa su perfil profesional y, si es el
 * **titular** (el primero que se creó), también los datos del consultorio y el logo.
 *
 * Es el reflejo de lo que exige el servidor: mientras falte el perfil, `needsProfile`
 * viaja en el token, el JWT no lleva permisos y el gateway corta todo salvo esta
 * pantalla (ADR 0056). Por eso va **fuera del shell**, como el cambio de contraseña:
 * no hay navegación adónde ir.
 *
 * Al guardar se **refresca la sesión** para que el token nuevo ya no traiga
 * `needsProfile`; sin eso, el usuario seguiría bloqueado hasta el siguiente acceso.
 */
export const CompleteProfilePage = () => {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const { notice, limpiar, error } = useNotice();
  const [logo, setLogo] = useState<File | null>(null);

  const identidad = useClinicIdentity();
  const queryClient = useQueryClient();
  const esTitular =
    identidad !== null &&
    identidad.titularUsername !== null &&
    identidad.titularUsername === user?.username;

  /**
   * Los datos del consultorio se validan **solo cuando sus campos están en pantalla** (el
   * titular). A los demás les queda el hueco `clinic` de los valores por defecto, vacío, y
   * el esquema completo lo rechazaría por unos campos que no existen: `handleSubmit` no
   * llamaría a `enviar` y el botón parecería muerto, sin ningún error que lo explique.
   */
  const esquema = useMemo(
    () => (esTitular ? completeOnboardingSchema : completeOnboardingSchema.pick({ dentist: true })),
    [esTitular],
  );

  const formulario = useForm<ValoresFormulario, unknown, ValoresEnviados>({
    resolver: zodResolver(esquema),
    defaultValues: {
      dentist: { mpps: '', specialty: '', licenseNumber: '', contactEmail: '' },
      clinic: {
        name: identidad?.clinic.name ?? '',
        legalName: '',
        address: identidad?.clinic.address ?? '',
        city: '',
        phones: [],
        email: '',
        rif: '',
        website: '',
      },
    },
  });

  const enviar = async (valores: ValoresEnviados) => {
    limpiar();
    try {
      await identityApi.completeOnboarding({
        dentist: valores.dentist,
        // Solo el titular manda los datos del consultorio; los demás lo omiten.
        ...(esTitular && valores.clinic !== undefined ? { clinic: valores.clinic } : {}),
      });
      if (esTitular && logo !== null) await identityApi.uploadLogo(logo);
      await queryClient.invalidateQueries({ queryKey: CLINIC_IDENTITY_QUERY_KEY });
      await refresh();
      void navigate('/inicio', { replace: true });
    } catch (fallo) {
      if (!applyApiFieldErrors(formulario.setError, fallo)) error(apiErrorMessage(fallo));
    }
  };

  /**
   * `handleSubmit` sin `onInvalid` no hace **nada** cuando la validación falla: se pulsa el
   * botón, no pasa nada y no hay error que mirar. Aquí se avisa siempre.
   */
  const alFallar = () => {
    error(t('perfil.completar.errorValidacion'));
  };

  const { errors, isSubmitting } = formulario.formState;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-canvas px-4 py-10">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-card bg-primary text-primary-ink">
          <Stethoscope className="size-5" aria-hidden="true" />
        </span>
        <div>
          <p className="text-base font-semibold text-ink">{t('app.nombre')}</p>
          <p className="text-xs text-ink-subtle">
            {user?.fullName ?? t('comun.sinDato')} · {user?.username ?? ''}
          </p>
        </div>
      </div>

      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle as="h1">{t('perfil.completar.titulo')}</CardTitle>
          <CardDescription>{t('perfil.completar.texto')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <NoticeBanner notice={notice} onClose={limpiar} />

          <Alert variant="warning" title={t('perfil.completar.avisoTitulo')}>
            {t('perfil.completar.avisoTexto')}
          </Alert>

          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              void formulario.handleSubmit(enviar, alFallar)(event);
            }}
          >
            <h2 className="text-sm font-semibold text-ink">{t('perfil.profesional.titulo')}</h2>

            <Field
              label={t('perfil.campo.mpps')}
              hint={t('perfil.campo.mppsAyuda')}
              error={errors.dentist?.mpps?.message}
              required
            >
              <Input placeholder="MPPS 12345" {...formulario.register('dentist.mpps')} />
            </Field>

            <Field
              label={t('perfil.campo.especialidad')}
              error={errors.dentist?.specialty?.message}
              required
            >
              <Input
                placeholder={t('perfil.campo.especialidadPlaceholder')}
                {...formulario.register('dentist.specialty')}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('perfil.campo.colegiatura')}
                error={errors.dentist?.licenseNumber?.message}
              >
                <Input {...formulario.register('dentist.licenseNumber')} />
              </Field>
              <Field label={t('perfil.campo.correo')} error={errors.dentist?.contactEmail?.message}>
                <Input type="email" {...formulario.register('dentist.contactEmail')} />
              </Field>
            </div>

            {esTitular && (
              <>
                <h2 className="pt-2 text-sm font-semibold text-ink">
                  {t('perfil.consultorio.titulo')}
                </h2>
                <p className="text-xs text-ink-subtle">{t('perfil.consultorio.ayuda')}</p>

                <Field
                  label={t('perfil.consultorio.nombre')}
                  error={errors.clinic?.name?.message}
                  required
                >
                  <Input {...formulario.register('clinic.name')} />
                </Field>

                <Field
                  label={t('perfil.consultorio.direccion')}
                  error={errors.clinic?.address?.message}
                  required
                >
                  <Input {...formulario.register('clinic.address')} />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('perfil.consultorio.rif')} error={errors.clinic?.rif?.message}>
                    <Input placeholder="J-12345678-9" {...formulario.register('clinic.rif')} />
                  </Field>
                  <Field
                    label={t('perfil.consultorio.ciudad')}
                    error={errors.clinic?.city?.message}
                  >
                    <Input {...formulario.register('clinic.city')} />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={t('perfil.consultorio.telefono')}
                    hint={t('perfil.consultorio.telefonoAyuda')}
                    error={errors.clinic?.phones?.message}
                  >
                    <Input
                      placeholder="(+58) 281 123 45 67"
                      onChange={(event) => {
                        const valor = event.target.value.trim();
                        formulario.setValue('clinic.phones', valor === '' ? [] : [valor]);
                      }}
                    />
                  </Field>
                  <Field
                    label={t('perfil.consultorio.correo')}
                    error={errors.clinic?.email?.message}
                  >
                    <Input type="email" {...formulario.register('clinic.email')} />
                  </Field>
                </div>

                <Field
                  label={t('perfil.consultorio.logo')}
                  hint={t('perfil.consultorio.logoAyuda')}
                >
                  <input
                    type="file"
                    accept="image/svg+xml"
                    className="block w-full text-sm text-ink-muted"
                    onChange={(event) => setLogo(event.target.files?.[0] ?? null)}
                  />
                </Field>
              </>
            )}

            <Button
              type="submit"
              fullWidth
              loading={isSubmitting}
              loadingLabel={t('comun.enviando')}
            >
              {t('perfil.completar.enviar')}
            </Button>
          </form>

          <p className="text-xs text-ink-subtle">{t('perfil.completar.pie')}</p>
        </CardContent>
      </Card>

      <div className="flex flex-col items-center gap-2">
        <ThemeSelector />
        <p className="text-xs text-ink-subtle">{t('app.pie')}</p>
      </div>
    </div>
  );
};
