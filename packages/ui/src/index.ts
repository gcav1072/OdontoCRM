/**
 * Sistema de diseño de OdontoCRM.
 *
 * Se consume como código fuente (el bundler compila estos `.tsx`), por eso el
 * paquete exporta componentes y utilidades, pero **no** importa
 * `styles/tokens.css`: ese archivo lo importa la hoja raíz de la aplicación
 * (`apps/web/src/index.css`) porque contiene un bloque `@theme` que solo
 * entiende el compilador de Tailwind.
 */

export { cn } from './lib/cn';

export { Alert, type AlertProps, type AlertVariant } from './components/Alert';
export { Badge, type BadgeProps, type BadgeVariant } from './components/Badge';
export {
  Button,
  buttonClasses,
  type ButtonProps,
  type ButtonSize,
  type ButtonStyleOptions,
  type ButtonVariant,
} from './components/Button';
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  type CardProps,
  type CardTitleProps,
} from './components/Card';
export { Checkbox, type CheckboxProps } from './components/Checkbox';
export { Dialog, type DialogProps, type DialogSize } from './components/Dialog';
export { EmptyState, type EmptyStateProps } from './components/EmptyState';
export { Field, type FieldProps } from './components/Field';
export { FieldContext, useFieldControl, type FieldControlState } from './components/field-context';
export { Input, type InputProps } from './components/Input';
export { Label, type LabelProps } from './components/Label';
export { Select, type SelectProps } from './components/Select';
export { Spinner, type SpinnerProps, type SpinnerSize } from './components/Spinner';
export { Switch, type SwitchProps } from './components/Switch';
export {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  type TableEmptyProps,
  type TableProps,
} from './components/Table';
