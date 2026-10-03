# ADR 0022 — TypeScript 5.9 en lugar de 7.x

- **Fecha:** 2026-10-02 · **Estado:** aceptada (revisar cuando la herramienta lo permita)

## Contexto

Al instalar dependencias (2026-10-02) la última versión publicada de TypeScript era la **7.0.2**
(el compilador portado a Go). Pero `typescript-eslint@8.71` —la versión estable actual— declara
como rango soportado `typescript >=4.8.4 <6.1.0`. Usar TS 7 habría dejado el lint sin soporte
oficial: exactamente el tipo de grieta que aparece a mitad de una fase.

## Decisión

Fijar **TypeScript 5.9.3** (última 5.x) en todo el monorepo, junto con ESLint 10 y
`typescript-eslint` 8.71.

## Consecuencias

- ✅ Herramientas soportadas oficialmente entre sí; lint y compilación sin avisos de versión.
- ✅ Un solo `tsconfig.base.json` estricto para los nueve servicios y los paquetes.
- ⚠️ Se pierden las mejoras de rendimiento de TS 7 por ahora. **Revisión:** cuando
  `typescript-eslint` publique soporte para TS 6/7, se actualiza en un commit propio
  (`chore(deps)`) y se reejecuta `npm run verify`; al tratarse de un cambio transversal, entra
  como primer paso de la fase siguiente, no a mitad de una.
