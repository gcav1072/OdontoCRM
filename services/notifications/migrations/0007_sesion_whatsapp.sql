-- Sesión de WhatsApp por Baileys cifrada en la base (ADR 0073).
--
-- * `whatsapp_auth`: el estado Signal del dispositivo vinculado (creds, claves
--   de pre-key, sesiones, sender-keys, app-state-sync-key, lid-mapping…). Cada
--   valor se guarda como `enc:<base64>` con la clave del almacén; `plain:` queda
--   solo para desarrollo sin clave. No se usa `useMultiFileAuthState`: los
--   ficheros sueltos no entran en el respaldo nocturno ni se cifran.
-- * `whatsapp_session`: estado legible y contadores del limitador diario. La
--   máquina de estados vive en el adaptador; aquí sobrevive a un reinicio.
--
-- El id de canal sigue siendo `whatsapp`: estas tablas son un detalle del
-- proveedor Baileys y no tocan `patient_channels` ni `notifications`.
CREATE TABLE "whatsapp_auth" (
	"session_id" text NOT NULL,
	"categoria" text NOT NULL,
	"clave" text NOT NULL,
	"valor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_auth_session_id_categoria_clave_pk" PRIMARY KEY("session_id","categoria","clave")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_session" (
	"session_id" text PRIMARY KEY NOT NULL,
	"estado" text DEFAULT 'desactivado' NOT NULL,
	"numero" text,
	"nombre" text,
	"vinculado_en" timestamp with time zone,
	"conectado_desde" timestamp with time zone,
	"ultima_desconexion" timestamp with time zone,
	"motivo" text,
	"envios_hoy" integer DEFAULT 0 NOT NULL,
	"envios_dia" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
