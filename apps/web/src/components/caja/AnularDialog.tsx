import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input } from '@odontocrm/ui';
import { useState } from 'react';

import { apiErrorMessage } from '../../lib/api';
import { billingApi } from '../../lib/endpoints';
import { t } from '../../lib/i18n';

export interface AnularFacturaDialogProps {
  /** Un borrador se **descarta** (nunca fue documento); una factura emitida se anula con nota. */
  modo: 'factura' | 'borrador';
  documento: { id: string; numberLabel: string | null };
  onClose: () => void;
  onDone: (mensaje: string) => void;
}

/**
 * **Anular**: dos actos distintos que se parecen, y por eso van en el mismo diálogo con textos
 * distintos (ADR 0048).
 *
 * - **descartar un borrador**: no consumió número fiscal, así que se anula con su motivo y **sin**
 *   nota de crédito;
 * - **anular una factura emitida**: la ley exige la **nota de crédito**, un documento nuevo con su
 *   numeración y su PDF. La factura se conserva: no se borra ni se edita.
 *
 * El motivo no es decorativo: queda en la nota y en la auditoría, y el `CHECK` de la tabla lo exige
 * para cualquier fila anulada.
 */
export const AnularFacturaDialog = ({
  modo,
  documento,
  onClose,
  onDone,
}: AnularFacturaDialogProps) => {
  const [motivo, setMotivo] = useState('');

  const anular = useMutation({
    mutationFn: () =>
      modo === 'borrador'
        ? billingApi.discardDraft(documento.id, motivo.trim())
        : billingApi.voidInvoice(documento.id, motivo.trim()),
  });

  const esBorrador = modo === 'borrador';
  const minimo = esBorrador ? 3 : 5;
  const puedeConfirmar = motivo.trim().length >= minimo && !anular.isPending;

  const confirmar = async (): Promise<void> => {
    try {
      const salida = await anular.mutateAsync();
      onDone(
        esBorrador
          ? t('caja.descartar.exito')
          : t('caja.anular.exito', { nota: salida.creditNote?.creditNoteLabel ?? '' }),
      );
    } catch {
      // El error se ve abajo y el diálogo se queda abierto para corregir el motivo.
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        esBorrador
          ? t('caja.descartar.titulo')
          : t('caja.anular.titulo', { numero: documento.numberLabel ?? '' })
      }
      description={esBorrador ? t('caja.descartar.texto') : t('caja.anular.texto')}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={anular.isPending}>
            {t('comun.cancelar')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              void confirmar();
            }}
            disabled={!puedeConfirmar}
            loading={anular.isPending}
            loadingLabel={t('comun.guardando')}
          >
            {esBorrador ? t('caja.descartar') : t('caja.anular')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {anular.isError && (
          <Alert variant="danger" title={t('secretaria.error.accion')}>
            {apiErrorMessage(anular.error)}
          </Alert>
        )}

        <Field
          label={esBorrador ? t('caja.descartar.motivo') : t('caja.anular.motivo')}
          hint={esBorrador ? undefined : t('caja.anular.motivoAyuda')}
        >
          <Input
            autoComplete="off"
            autoFocus
            value={motivo}
            onChange={(evento) => setMotivo(evento.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
};

export interface AnularCobroDialogProps {
  cobro: { id: string; receiptLabel: string; amountCentsUsd: number };
  onClose: () => void;
  onDone: (mensaje: string) => void;
}

/**
 * **Anular un cobro**: el recibo no se borra —se conserva, como el récipe emitido— y el saldo de la
 * factura se rehace desde los cobros que siguen vigentes, así que el estado retrocede solo.
 */
export const AnularCobroDialog = ({ cobro, onClose, onDone }: AnularCobroDialogProps) => {
  const [motivo, setMotivo] = useState('');

  const anular = useMutation({
    mutationFn: () => billingApi.voidPayment(cobro.id, motivo.trim()),
  });

  const confirmar = async (): Promise<void> => {
    try {
      await anular.mutateAsync();
      onDone(t('caja.cobro.anularExito', { recibo: cobro.receiptLabel }));
    } catch {
      // Ídem: el motivo se puede corregir sin cerrar.
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('caja.cobro.anularTitulo', { recibo: cobro.receiptLabel })}
      description={t('caja.cobro.anularTexto')}
      dismissOnBackdrop={false}
      closeLabel={t('comun.cerrar')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={anular.isPending}>
            {t('comun.cancelar')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              void confirmar();
            }}
            disabled={motivo.trim().length < 3 || anular.isPending}
            loading={anular.isPending}
            loadingLabel={t('comun.guardando')}
          >
            {t('caja.cobro.anular')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {anular.isError && (
          <Alert variant="danger" title={t('secretaria.error.accion')}>
            {apiErrorMessage(anular.error)}
          </Alert>
        )}

        <Field label={t('caja.cobro.anularMotivo')}>
          <Input
            autoComplete="off"
            autoFocus
            value={motivo}
            onChange={(evento) => setMotivo(evento.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
};
