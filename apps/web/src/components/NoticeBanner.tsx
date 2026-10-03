import { Alert } from '@odontocrm/ui';

import type { Notice } from '../hooks/useNotice';

export interface NoticeBannerProps {
  notice: Notice | null;
  onClose?: () => void;
  className?: string;
}

/**
 * Aviso de la página. Es presentacional a propósito: el estado vive en la
 * página (con `useNotice`) para que pueda reemplazarlo la operación siguiente.
 */
export const NoticeBanner = ({ notice, onClose, className }: NoticeBannerProps) =>
  notice ? (
    <Alert
      variant={notice.variant}
      title={notice.title}
      onDismiss={onClose}
      className={className ?? 'mb-5'}
    >
      {notice.message}
    </Alert>
  ) : null;
