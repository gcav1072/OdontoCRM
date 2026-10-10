import {
  CLINICAL_STATE_COLORS,
  PROSTHESIS_BAND_Y,
  PROSTHESIS_KIND_SHORT,
  prosthesisTrack,
  type ArchLayout,
  type ProsthesisArch,
  type ProsthesisRecord,
} from '@odontocrm/contracts';

/**
 * La **doble línea** de las prótesis removibles (PPR/PRT), en la **franja** bajo las
 * piezas y su número.
 *
 * La geometría del tramo la decide el contrato (`prosthesisTrack`): la PPR abarca su
 * intervalo, la PRT la arcada entera. Aquí solo se pinta, con el color del estado
 * —rojo indicada, azul instalada— y los **retenedores** en los extremos de la parcial.
 *
 * Va en su propia banda para no tapar las aspas (ausente/extraída) ni las caras, y cada
 * línea es un objetivo **pulsable** de tamaño cómodo (≥ 24 u): tocarla reabre su ficha.
 */
export interface ProsthesisOverlayProps {
  prostheses: readonly ProsthesisRecord[];
  arch: ProsthesisArch;
  layout: ArchLayout;
  /** Sin interacción: la vista impresa no lleva manejadores. */
  readOnly?: boolean;
  onPress?: (prosthesis: ProsthesisRecord) => void;
}

export const ProsthesisOverlay = ({
  prostheses,
  arch,
  layout,
  readOnly = false,
  onPress,
}: ProsthesisOverlayProps) => {
  const deLaArcada = prostheses.filter((prosthesis) => prosthesis.arch === arch);

  return (
    <g aria-label="Prótesis removibles">
      {deLaArcada.map((prosthesis) => {
        const track = prosthesisTrack(prosthesis, layout);
        if (track === null) return null;

        const color = CLINICAL_STATE_COLORS[prosthesis.state];
        const interactiva = !readOnly && onPress !== undefined;
        const centro = (track.x1 + track.x2) / 2;

        return (
          <g
            key={prosthesis.id}
            role={interactiva ? 'button' : undefined}
            tabIndex={interactiva ? 0 : undefined}
            aria-label={`${PROSTHESIS_KIND_SHORT[prosthesis.kind]} ${arch}`}
            data-protesis={prosthesis.kind}
            data-capa="protesis"
            onClick={interactiva ? () => onPress?.(prosthesis) : undefined}
            onKeyDown={
              interactiva
                ? (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onPress?.(prosthesis);
                  }
                : undefined
            }
            className={interactiva ? 'cursor-pointer' : undefined}
          >
            {/* Las dos líneas paralelas del conector */}
            <line
              x1={track.x1}
              y1={PROSTHESIS_BAND_Y - 4}
              x2={track.x2}
              y2={PROSTHESIS_BAND_Y - 4}
              stroke={color}
              strokeWidth={3}
              strokeLinecap="round"
            />
            <line
              x1={track.x1}
              y1={PROSTHESIS_BAND_Y + 4}
              x2={track.x2}
              y2={PROSTHESIS_BAND_Y + 4}
              stroke={color}
              strokeWidth={3}
              strokeLinecap="round"
            />

            {/* Retenedores/ganchos en los extremos de la parcial (pilares). */}
            {prosthesis.kind === 'ppr' && (
              <>
                <line
                  x1={track.x1}
                  y1={PROSTHESIS_BAND_Y - 9}
                  x2={track.x1}
                  y2={PROSTHESIS_BAND_Y + 9}
                  stroke={color}
                  strokeWidth={3}
                  strokeLinecap="round"
                />
                <line
                  x1={track.x2}
                  y1={PROSTHESIS_BAND_Y - 9}
                  x2={track.x2}
                  y2={PROSTHESIS_BAND_Y + 9}
                  stroke={color}
                  strokeWidth={3}
                  strokeLinecap="round"
                />
              </>
            )}

            <text
              x={centro}
              y={PROSTHESIS_BAND_Y - 10}
              fill={color}
              fontSize={11}
              fontWeight={700}
              textAnchor="middle"
            >
              {PROSTHESIS_KIND_SHORT[prosthesis.kind]}
            </text>

            {/* Zona pulsable cómoda (invisible), por encima del dibujo. */}
            <rect
              x={track.x1}
              y={PROSTHESIS_BAND_Y - 12}
              width={Math.max(track.x2 - track.x1, 8)}
              height={24}
              fill="transparent"
              pointerEvents={interactiva ? 'all' : 'none'}
            />
          </g>
        );
      })}
    </g>
  );
};
