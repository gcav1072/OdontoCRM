import type { ReportSeries } from '@odontocrm/contracts';
import { cn } from '@odontocrm/ui';
import { useMemo, type ReactElement } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { t } from '../../lib/i18n';
import { chartKindFor, reportGroupLabel, seriesToChartData } from '../../lib/reports';
import { useTheme, type ResolvedTheme } from '../../providers/ThemeProvider';

/** Alto del área de dibujo: cabe en la tableta sin obligar a desplazar la página. */
const ALTO = 280;

const MARGEN = { top: 8, right: 16, bottom: 4, left: 0 };

/** Colores de las series, por orden: son los tokens del tema, no valores fijos. */
const NOMBRES_COLOR = [
  '--color-primary',
  '--color-accent',
  '--color-info',
  '--color-warning',
  '--color-success',
  '--color-danger',
] as const;

/**
 * Valores de respaldo de los tokens (los mismos del tema claro y oscuro de
 * `packages/ui/src/styles/tokens.css`). Solo se usan si el DOM no está
 * disponible —pruebas, primer render sin hoja de estilos— o si el token no
 * existe: nunca deberían verse en la aplicación.
 */
const RESPALDO: Readonly<Record<ResolvedTheme, readonly string[]>> = {
  claro: ['#0e7490', '#0d9488', '#1d4ed8', '#b45309', '#15803d', '#b91c1c'],
  oscuro: ['#2aa7c9', '#2dd4bf', '#60a5fa', '#fbbf24', '#4ade80', '#f87171'],
};

interface GraficaTokens {
  series: string[];
  ink: string;
  inkMuted: string;
  border: string;
  surface: string;
}

/**
 * Lee los colores del tema desde las variables CSS que Tailwind publica en
 * `:root`. Recharts pinta con atributos SVG (`fill`, `stroke`), donde `var()`
 * no funciona, así que hay que resolverlos a un color concreto; el valor se
 * recalcula al cambiar de tema porque la clase `dark` vive en `<html>`.
 */
const leerTokens = (tema: ResolvedTheme): GraficaTokens => {
  const respaldo = RESPALDO[tema];
  const base: GraficaTokens = {
    series: [...respaldo],
    ink: tema === 'oscuro' ? '#e9eff8' : '#101c2e',
    inkMuted: tema === 'oscuro' ? '#a8b6ca' : '#4a5a70',
    border: tema === 'oscuro' ? '#26324a' : '#d8e0ea',
    surface: tema === 'oscuro' ? '#121b2c' : '#ffffff',
  };

  if (typeof document === 'undefined') return base;

  const estilos = getComputedStyle(document.documentElement);
  const leer = (nombre: string, alterno: string): string =>
    estilos.getPropertyValue(nombre).trim() || alterno;

  return {
    series: NOMBRES_COLOR.map((nombre, indice) =>
      leer(nombre, respaldo[indice] ?? base.series[0] ?? '#0e7490'),
    ),
    ink: leer('--color-ink', base.ink),
    inkMuted: leer('--color-ink-muted', base.inkMuted),
    border: leer('--color-border', base.border),
    surface: leer('--color-surface', base.surface),
  };
};

export interface ReportChartProps {
  series: ReportSeries;
  /** Alto del área de dibujo en píxeles. */
  height?: number;
  className?: string;
}

/**
 * Gráfica de una serie del documento. El contrato dice **cómo** pintarla
 * (`kind`) y la interfaz solo obedece:
 *
 * - `bar` y `stacked-bar` → barras verticales (apiladas en el segundo caso);
 * - `line` → línea por grupo, para las tasas a lo largo del período;
 * - `pie` → torta por etiqueta (un medicamento, una condición…);
 * - `pyramid` → barras horizontales por grupo (la pirámide de edad por sexo).
 *
 * Todas son responsivas (`ResponsiveContainer`) porque la interfaz se usa en la
 * tableta del consultorio además del escritorio, llevan leyenda con los grupos
 * y `Tooltip` con los textos en español. Los colores salen de los tokens del
 * tema, así que el modo oscuro se ve igual de legible.
 */
export const ReportChart = ({ series, height = ALTO, className }: ReportChartProps) => {
  const { resolved } = useTheme();
  const tokens = useMemo(() => leerTokens(resolved), [resolved]);
  const tipo = chartKindFor(series);
  const { data, groups } = useMemo(() => seriesToChartData(series), [series]);

  const color = (indice: number): string =>
    tokens.series[indice % tokens.series.length] ?? tokens.series[0] ?? '#0e7490';

  const textoEje = { fill: tokens.inkMuted, fontSize: 12 };

  const tooltip = (
    <Tooltip
      contentStyle={{
        backgroundColor: tokens.surface,
        border: `1px solid ${tokens.border}`,
        borderRadius: '0.5rem',
        color: tokens.ink,
        fontSize: '0.75rem',
      }}
      labelStyle={{ color: tokens.inkMuted, fontWeight: 600 }}
      itemStyle={{ color: tokens.ink }}
      cursor={{ fill: tokens.border, fillOpacity: 0.35 }}
    />
  );

  const leyenda = <Legend wrapperStyle={{ fontSize: '0.75rem', color: tokens.inkMuted }} />;
  // Con un solo grupo que se llama como la serie, la leyenda repetiría el
  // título de la gráfica: solo se pinta cuando aporta algo.
  const leyendaUtil = groups.length > 1 || (groups[0] !== undefined && groups[0] !== series.label);

  const rejilla = (vertical: boolean): ReactElement => (
    <CartesianGrid strokeDasharray="3 3" stroke={tokens.border} vertical={vertical} />
  );

  const dibujo = (): ReactElement => {
    if (tipo === 'line') {
      return (
        <LineChart data={data} margin={MARGEN}>
          {rejilla(true)}
          <XAxis dataKey="x" tick={textoEje} stroke={tokens.border} interval="preserveStartEnd" />
          <YAxis tick={textoEje} stroke={tokens.border} width={52} allowDecimals={false} />
          {tooltip}
          {leyendaUtil && leyenda}
          {groups.map((grupo, indice) => (
            <Line
              key={grupo}
              type="monotone"
              dataKey={grupo}
              name={reportGroupLabel(grupo)}
              stroke={color(indice)}
              strokeWidth={2}
              dot={{ r: 2 }}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      );
    }

    if (tipo === 'pie') {
      return (
        <PieChart margin={MARGEN}>
          {tooltip}
          {groups.length <= 1 && leyenda}
          {groups.map((grupo, indiceGrupo) => (
            <Pie
              key={grupo}
              data={data}
              dataKey={grupo}
              nameKey="x"
              name={reportGroupLabel(grupo)}
              outerRadius={96}
              fill={color(indiceGrupo)}
            >
              {data.map((fila, indice) => (
                <Cell key={fila.x} fill={color(indice)} />
              ))}
            </Pie>
          ))}
        </PieChart>
      );
    }

    if (tipo === 'pyramid') {
      /* Barras horizontales: el eje de categorías es el Y y las etiquetas
         —tramos de edad— caben a la izquierda sin girarse. */
      return (
        <BarChart data={data} layout="vertical" margin={{ ...MARGEN, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={tokens.border} horizontal={false} />
          <XAxis type="number" tick={textoEje} stroke={tokens.border} allowDecimals={false} />
          <YAxis type="category" dataKey="x" tick={textoEje} stroke={tokens.border} width={104} />
          {tooltip}
          {leyendaUtil && leyenda}
          {groups.map((grupo, indice) => (
            <Bar
              key={grupo}
              dataKey={grupo}
              name={reportGroupLabel(grupo)}
              fill={color(indice)}
              radius={[0, 4, 4, 0]}
              maxBarSize={22}
            />
          ))}
        </BarChart>
      );
    }

    return (
      <BarChart data={data} margin={MARGEN}>
        {rejilla(false)}
        <XAxis dataKey="x" tick={textoEje} stroke={tokens.border} interval="preserveStartEnd" />
        <YAxis tick={textoEje} stroke={tokens.border} width={52} allowDecimals={false} />
        {tooltip}
        {leyendaUtil && leyenda}
        {groups.map((grupo, indice) => (
          <Bar
            key={grupo}
            dataKey={grupo}
            name={reportGroupLabel(grupo)}
            stackId={tipo === 'stacked-bar' ? 'total' : undefined}
            fill={color(indice)}
            radius={tipo === 'stacked-bar' ? undefined : [4, 4, 0, 0]}
            maxBarSize={48}
          />
        ))}
      </BarChart>
    );
  };

  const ejes = [series.xLabel, series.yLabel].filter(
    (valor): valor is string => valor !== null && valor !== '',
  );

  return (
    <figure className={cn('space-y-2 rounded-card border border-border bg-surface p-4', className)}>
      <figcaption className="space-y-0.5">
        <h3 className="text-sm font-semibold text-ink">{series.label}</h3>
        {ejes.length > 0 && <p className="text-xs text-ink-subtle">{ejes.join(' · ')}</p>}
      </figcaption>

      {data.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-muted">{t('reportes.grafica.vacia')}</p>
      ) : (
        <div
          role="img"
          aria-label={t('reportes.grafica.aria', { titulo: series.label })}
          style={{ height }}
        >
          <ResponsiveContainer width="100%" height="100%">
            {dibujo()}
          </ResponsiveContainer>
        </div>
      )}

      <p className="text-xs text-ink-subtle">{t('reportes.grafica.tablaEquivalente')}</p>
    </figure>
  );
};
