/**
 * Periodontograma (v1.1): componentes y cliente del módulo.
 *
 * El panel y el documento se exportan desde aquí para que la integración (pestaña
 * del consultorio y página de impresión) no dependa de la estructura interna de la
 * carpeta. El resto de archivos (controlador, geometría, presentación, SVG y pad) son
 * detalles internos, aunque se exportan también porque el documento los reutiliza.
 */

export { PeriodontogramPanel, type PeriodontogramPanelProps } from './PeriodontogramPanel';
export { PeriodontogramDocument, type PeriodontogramDocumentProps } from './PeriodontogramDocument';
export { ProbingTouchPad, type ProbingTouchPadProps } from './ProbingTouchPad';
export { PeriodontogramArchSvg, type PeriodontogramArchSvgProps } from './PeriodontogramArchSvg';
