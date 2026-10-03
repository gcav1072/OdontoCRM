# Plan de Implementación: Servicio de Odontograma (OdontoCloud CRM)

## 1. Resumen Ejecutivo y Alcance
Este documento define la arquitectura técnica, modelo de datos, contratos de API/eventos e interfaz de usuario para el **Servicio de Odontograma** dentro de un ecosistema de microservicios odontológicos.

* **Patrón de captura:** "Data entry por excepción" (solo se persisten anomalías; las piezas/caras no registradas se asumen e interpretan como sanas en lectura).
* **Estándar clínico:** Nomenclatura FDI de 2 dígitos (permanente y temporal).
* **Motor gráfico:** Odontograma geométrico reactivo basado en polígonos SVG (cero dependencia de assets binarios/dibujo manual).

---

## 2. Ubicación en la Arquitectura de Microservicios

```
                   ┌──────────────────────────────────────┐
                   │             API Gateway              │
                   └──────────────────┬───────────────────┘
                                      │ (REST / gRPC)
                                      ▼
                   ┌──────────────────────────────────────┐
                   │          Odontogram Service          │
                   │  - Node.js + TypeScript (Fastify)    │
                   │  - PostgreSQL + Event Publishing     │
                   └───────┬──────────────────────┬───────┘
                           │                      │
       (Asynchronous Events)                      │ (Data Storage)
                           ▼                      ▼
             ┌─────────────────────────┐   ┌───────────────┐
             │ Event Bus (RabbitMQ/    │   │ PostgreSQL DB │
             │ Kafka / Redis Streams)  │   └───────────────┘
             └─────────────┬───────────┘
                           │
       ┌───────────────────┴───────────────────┐
       ▼                                       ▼
┌──────────────┐                       ┌──────────────┐
│  Treatment   │                       │   Billing    │
│  Plan / EHR  │                       │   Service    │
│   Service    │                       └──────────────┘
└──────────────┘
```

### Límites de Dominio (Bounded Context)
* **Odontogram Service (Propietario):** Estado actual e histórico de las piezas dentales del paciente, caras anatómicas y superficies afectadas.
* **Treatment Plan Service:** Agrupa los hallazgos en presupuestos o fases de tratamiento.
* **Billing / Facturación:** Precios de procedimientos, cálculo de cuotas y seguros.

---

## 3. Modelo de Dominio y Contratos TypeScript Compartidos

Archivo común (`@shared/odontogram-types`):

```typescript
// Sistema FDI
export type ToothNumber = number; // 11-48 (adultos), 51-85 (pediátricos)

export type ToothSurface = 
  | 'vestibular' 
  | 'lingual' 
  | 'occlusal' 
  | 'mesial' 
  | 'distal';

export type ClinicalState = 'pending' | 'completed';

export type SurfaceCondition = 'caries' | 'restoration';

export type WholeToothCondition = 
  | 'missing'
  | 'extraction_indicated'
  | 'crown'
  | 'implant'
  | 'endodontics';

export interface SurfaceFinding {
  surface: ToothSurface;
  condition: SurfaceCondition;
  state: ClinicalState;
}

export interface ToothFinding {
  toothNumber: ToothNumber;
  surfaces: Partial<Record<ToothSurface, SurfaceFinding>>;
  wholeToothCondition?: WholeToothCondition;
  isEndodontics?: boolean;
  endodonticsState?: ClinicalState;
  notes?: string;
}

export interface OdontogramSnapshot {
  id: string;
  patientId: string;
  type: 'initial' | 'evolution';
  createdAt: string;
  updatedAt: string;
  findings: Record<ToothNumber, ToothFinding>; // O(1) lookup
}
```

---

## 4. Esquema de Persistencia (PostgreSQL)

Se implementa una tabla para el odontograma base y una tabla de hallazgos normalizada. La ausencia de fila para una pieza implica automáticamente estado **SANO**.

```sql
CREATE TABLE odontograms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'initial', -- 'initial' o 'evolution'
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_odontograms_patient_id ON odontograms(patient_id);

CREATE TABLE tooth_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    odontogram_id UUID NOT NULL REFERENCES odontograms(id) ON DELETE CASCADE,
    tooth_number SMALLINT NOT NULL,
    surface VARCHAR(15), -- NULL si aplica a la pieza entera (ej: missing, crown)
    condition VARCHAR(30) NOT NULL, -- caries, restoration, missing, etc.
    state VARCHAR(15) NOT NULL, -- 'pending' (rojo) o 'completed' (azul)
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_tooth_surface_finding UNIQUE(odontogram_id, tooth_number, surface)
);

CREATE INDEX idx_tooth_findings_odontogram ON tooth_findings(odontogram_id);
```

---

## 5. Diseño de API REST / Endpoints

### 5.1 Obtener Odontograma Activo del Paciente
`GET /api/v1/patients/:patientId/odontogram`

**Respuesta (200 OK):**
```json
{
  "id": "e9b4d8a1-79b8-4c8d-b35f-a63e9f456789",
  "patientId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "type": "initial",
  "updatedAt": "2026-10-02T15:30:00Z",
  "findings": {
    "16": {
      "toothNumber": 16,
      "surfaces": {
        "occlusal": { "surface": "occlusal", "condition": "caries", "state": "pending" },
        "mesial": { "surface": "mesial", "condition": "restoration", "state": "completed" }
      }
    },
    "48": {
      "toothNumber": 48,
      "surfaces": {},
      "wholeToothCondition": "missing"
    }
  }
}
```

### 5.2 Registrar o Actualizar Hallazgo (Data Entry Rápido)
`POST /api/v1/patients/:patientId/odontogram/findings`

**Payload:**
```json
{
  "toothNumber": 24,
  "surface": "occlusal",
  "condition": "caries",
  "state": "pending",
  "notes": "Lesión de fosa profunda"
}
```

### 5.3 Eliminar Hallazgo (Marcar nuevamente como Sano)
`DELETE /api/v1/patients/:patientId/odontogram/findings?toothNumber=24&surface=occlusal`

---

## 6. Integración Asíncrona (Eventos de Dominio)

Cuando se registra una condición en estado `pending`, otros servicios (como planes de tratamiento) deben reaccionar:

* **Tópico/Cola:** `odontology.odontogram.finding.recorded`
* **Contrato del Mensaje:**
```json
{
  "eventId": "b3e0c01e-7b79-4d67-9c9e-5e60d0999518",
  "eventType": "TOOTH_FINDING_RECORDED",
  "occurredAt": "2026-10-02T20:00:00Z",
  "data": {
    "patientId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
    "odontogramId": "e9b4d8a1-79b8-4c8d-b35f-a63e9f456789",
    "toothNumber": 16,
    "surface": "occlusal",
    "condition": "caries",
    "state": "pending"
  }
}
```

---

## 7. Frontend: Componente Geométrico SVG y Layout de Cuadrantes

### 7.1 Polígonos SVG Parametrizados (100x100)
Cada cara es un polígono puro sin dependencias de fuentes externas:

```tsx
// Coordenadas fijas para un lienzo 100x100
const SURFACE_COORDINATES = {
  vestibular: '0,0 100,0 75,25 25,25',
  distal:     '100,0 100,100 75,75 75,25',
  lingual:    '100,100 0,100 25,75 75,75',
  mesial:     '0,100 0,0 25,25 25,75',
  occlusal:   '25,25 75,25 75,75 25,75',
};
```

### 7.2 Distribución de Cuadrantes FDI
```
Arcada Superior:
[ Cuadrante 1: 18 -> 11 ] | [ Cuadrante 2: 21 -> 28 ]
------------------------------------------------------
Arcada Inferior:
[ Cuadrante 4: 48 -> 41 ] | [ Cuadrante 3: 31 -> 38 ]
```

---

## 8. Fases de Ejecución

| Fase | Tareas Principales | Entregables |
| :--- | :--- | :--- |
| **Fase 1: Core & API** | - Setup del servicio Node/TS y migraciones SQL.<br>- Endpoints CRUD de hallazgos y normalización de datos.<br>- Validaciones Zod de número de pieza FDI y caras. | Microservicio funcional con pruebas unitarias de API. |
| **Fase 2: Componente SVG** | - Implementación de `<GeometricTooth />` en React.<br>- Mapeo de estados clínicos a colores (#ef4444 pendiente, #3b82f6 completado).<br>- Soporte de estados de pieza completa (X de extracción/ausente). | Componente interactivo y aislado en Storybook o app de prueba. |
| **Fase 3: Flujo de Carga Rápida** | - Formulario de teclado con shortcut de número de pieza.<br>- Switch rápido entre caries/obturación/ausente.<br>- Sincronización optimista en React Query / Zustand. | Carga de odontograma completa en menos de 30 segundos por teclado. |
| **Fase 4: Integración Microservicios** | - Publicador de eventos en RabbitMQ/Kafka.<br>- Consumo en el servicio de planes de tratamiento para auto-crear presupuestos. | Integración end-to-end completada. |