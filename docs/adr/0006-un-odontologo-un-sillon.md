# ADR 0006 — Un odontólogo y un sillón, con el modelo preparado para más

- **Fecha:** 2026-10-02 · **Estado:** aceptada

## Contexto

El proyecto es, por ahora, para **un odontólogo y una silla**. Sin embargo, agenda, citas y
reportes son las áreas donde añadir personal después obliga a migrar datos y reescribir
consultas si el modelo asumió un único profesional.

## Decisión

Modelar **`dentist_id` y `chair_id`** en citas y sesiones desde el inicio, con **un único
registro por defecto** de cada uno, y validar en la lógica de negocio que hoy solo hay uno
activo. La interfaz no expone selectores de odontólogo ni de sillón en esta etapa.

## Consecuencias

- ✅ Añadir un segundo odontólogo o sillón más adelante es crear registros, no migrar tablas.
- ✅ Los reportes ya agrupan por profesional (aunque hoy haya uno).
- ⚠️ Un poco de complejidad extra en el esquema y en las consultas de agenda.
- ⚠️ Regla explícita: si en el futuro se activan varios, habrá que revisar la validación de
  solapamiento de horarios por profesional y por sillón.
