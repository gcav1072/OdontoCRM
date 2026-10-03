# ADR 0013 — Stack del frontend y de las pantallas

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

El sistema tiene una SPA con muchos formularios y tablas (registro, programación, secretaría,
consultorio, reportes, auditoría) y dos pantallas tipo kiosko que deben verse a distancia y
actualizarse solas. Los esquemas de validación ya existen en el backend.

## Decisión

- **Vite + React + TypeScript**, con **Tailwind CSS** y **shadcn/ui** como base visual: los
  componentes quedan en el repositorio y se adaptan al diseño del consultorio.
- **TanStack Query** para datos del servidor y **TanStack Table** para listados; **React Hook
  Form + Zod** para formularios, reutilizando los esquemas de `packages/contracts`.
- **Recharts** para las gráficas de reportes.
- Las pantallas kiosko son **rutas de la misma SPA** (`/pantalla/lobby`,
  `/pantalla/consultorio`) sin el shell de navegación, autenticadas con token de dispositivo y
  actualizadas por **SSE**.
- Tema claro/oscuro/sistema y panel inferior ocultable en el shell.

## Consecuencias

- ✅ Un solo proyecto de interfaz, tipos compartidos con el backend y control total del diseño.
- ✅ Menos dependencias pesadas que un kit completo (Ant Design o MUI) y sin ataduras de estilo.
- ⚠️ Hay que construir a mano piezas como el calendario de selección de fecha y las tablas con
  filtros: se asume como parte del trabajo de las fases 3 y 5.
