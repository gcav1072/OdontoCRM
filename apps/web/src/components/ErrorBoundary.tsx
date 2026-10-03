import { Alert, buttonClasses, Card, CardContent, CardHeader, CardTitle, cn } from '@odontocrm/ui';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { t } from '../lib/i18n';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Última red de seguridad: si un componente falla al dibujarse, en vez de una
 * pantalla en blanco se muestra un aviso legible con salida al inicio.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // El detalle se muestra en pantalla; no se escribe en consola (regla del proyecto).
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <CardTitle as="h1">{t('error.titulo')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="danger">{t('error.texto')}</Alert>

            <details className="rounded-control border border-border bg-surface-muted px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium text-ink-muted">
                {t('error.detalle')}
              </summary>
              <pre className="mt-2 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-ink-subtle">
                {error.message}
              </pre>
            </details>

            <div className="flex flex-wrap gap-2">
              <a href="/inicio" className={buttonClasses({ variant: 'primary' })}>
                {t('comun.irAInicio')}
              </a>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className={cn(buttonClasses({ variant: 'secondary' }))}
              >
                {t('comun.recargar')}
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
