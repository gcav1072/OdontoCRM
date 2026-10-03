import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@odontocrm/ui';

import { LinkButton } from '../components/LinkButton';
import { PERMISSION_LABELS, t } from '../lib/i18n';
import { MODULES, type ModuleId } from '../lib/nav';
import { useAuth } from '../providers/AuthProvider';

export interface ModulePlaceholderProps {
  module: ModuleId;
}

/**
 * Pantalla de los módulos que se construyen en fases posteriores. Existe para
 * que el shell sea navegable desde la Fase 1 y para que el usuario vea que el
 * módulo está previsto (y con qué permiso se abrirá), en vez de un enlace roto.
 */
export const ModulePlaceholder = ({ module }: ModulePlaceholderProps) => {
  const definicion = MODULES[module];
  const Icono = definicion.icon;
  const { permissions } = useAuth();

  const permisosQueLoAbren =
    definicion.permission === null
      ? []
      : permissions.filter((permiso) => permiso === definicion.permission);

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-control bg-primary/10 text-primary">
            <Icono className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle as="h2">{t(definicion.labelKey)}</CardTitle>
            <CardDescription>{t(definicion.descriptionKey)}</CardDescription>
          </div>
          <Badge variant="info">{t('placeholder.fase', { fase: definicion.phase })}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="info" title={t('placeholder.titulo')}>
          {t('placeholder.texto', { fase: definicion.phase })}
        </Alert>

        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
              {t('placeholder.permiso')}
            </dt>
            <dd className="text-ink">
              {definicion.permission === null ? (
                t('placeholder.disponible')
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant={permisosQueLoAbren.length > 0 ? 'success' : 'neutral'}>
                    {PERMISSION_LABELS[definicion.permission]}
                  </Badge>
                  <code className="font-mono text-xs text-ink-subtle">{definicion.permission}</code>
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
              {t('placeholder.ruta')}
            </dt>
            <dd className="font-mono text-xs text-ink-muted">{definicion.path}</dd>
          </div>
        </dl>

        <LinkButton to="/inicio" variant="secondary" size="sm">
          {t('comun.irAInicio')}
        </LinkButton>
      </CardContent>
    </Card>
  );
};
