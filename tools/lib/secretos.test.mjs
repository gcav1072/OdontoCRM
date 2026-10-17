import { describe, expect, it } from 'vitest';

import { hallazgosDeLinea, isForbiddenPath } from './secretos.mjs';

/**
 * El escáner de secretos corre en cada commit y dentro de `npm run verify`, así que un patrón
 * que salta de más rompe la puerta de calidad en un árbol limpio y uno que salta de menos deja
 * pasar un secreto real. Aquí se fijan las dos caras: lo que tiene que **tolerar**, con líneas
 * de verdad del repositorio, y lo que tiene que **ver**.
 *
 * Los secretos de mentira se arman por trozos (`pega`). Es la regla que ya sigue
 * `services/identity/src/settings.integration.test.ts`: un literal con forma de secreto real en
 * el archivo es indistinguible de uno de verdad para quien revise, y además el escáner lo
 * marcaría a él —con razón— al commitear esta prueba. Con los trozos, ninguna línea suelta
 * tiene forma de secreto y la cadena que se prueba es exactamente la misma.
 */
const CONEXION = 'cadena de conexión con contraseña real';

/** Junta trozos para que el literal completo no aparezca en ninguna línea del archivo. */
const pega = (...trozos) => trozos.join('');

/** ¿La línea se leería como un secreto? Se responde con los nombres de los patrones. */
const salta = (linea) => hallazgosDeLinea(linea).length > 0;

describe('el escáner de secretos no marca código ni marcadores de ejemplo', () => {
  it('tolera la plantilla de PowerShell del instalador de Windows', () => {
    // El falso positivo que motivó la tolerancia: la contraseña es una SUBEXPRESIÓN, no un valor.
    const linea =
      '  $url = "postgres://${Usuario}:$([Uri]::EscapeDataString($clave))@${Equipo}:$Puerto/$Base"';
    expect(salta(linea)).toBe(false);
  });

  it('tolera las plantillas de interpolación de variable', () => {
    expect(salta('const url = `postgres://${rol}:${clave}@127.0.0.1:5432/${base}`;')).toBe(false);
    expect(salta('  PG_URL="postgres://$USUARIO:$CLAVE@127.0.0.1:5432/odonto"')).toBe(false);
    expect(salta('  url="postgres://${DB_USER}:${DB_PASS}@localhost:5432/db"')).toBe(false);
  });

  it('tolera los marcadores de ejemplo de las plantillas y los mensajes', () => {
    expect(salta('PG_ADMIN_URL=postgres://postgres:CAMBIAR_ESTO@127.0.0.1:5432/postgres')).toBe(
      false,
    );
    expect(salta('PG_ADMIN_URL=postgres://postgres:TU_PASSWORD@127.0.0.1:5432/postgres')).toBe(
      false,
    );
    expect(salta('  --admin-url="postgres://postgres:TU_CLAVE@127.0.0.1:5432/postgres"')).toBe(
      false,
    );
    expect(
      salta('DATABASE_URL=postgres://odonto_billing:CAMBIAR@127.0.0.1:5432/odonto_billing'),
    ).toBe(false);
  });

  it('tolera la conexión por socket, que no lleva contraseña', () => {
    expect(salta('psql "postgres:///postgres?host=/var/run/postgresql"')).toBe(false);
  });

  it('tolera el código que arma una URL con una función', () => {
    expect(salta('$env:PGPASSWORD = $Clave')).toBe(false);
    expect(salta('password = decodeURIComponent(partes[1])')).toBe(false);
  });
});

describe('el escáner de secretos sigue viendo lo que tiene que ver', () => {
  it('marca una cadena de conexión con una contraseña de verdad', () => {
    expect(
      salta(
        pega(
          'PG_ADMIN_URL=postgres://postgres:',
          'Tr4b4j0-Sup3r-S3creto',
          '@127.0.0.1:5432/postgres',
        ),
      ),
    ).toBe(true);
    expect(
      salta(
        pega(
          '  DATABASE_URL="postgresql://odonto:',
          'r3aL-K3y-32bytesOK',
          '@10.0.0.5:5432/odonto"',
        ),
      ),
    ).toBe(true);
  });

  it('marca un token de Telegram', () => {
    // El secreto de un token real son exactamente 35 caracteres: el patrón lo fija con `\b`,
    // así que una cadena más larga no es un token.
    expect(
      hallazgosDeLinea(
        pega('TELEGRAM_BOT_TOKEN=', '1234567890', ':AAF-abc', 'defghijklmnopqrstuvwxyz01234'),
      ),
    ).toContain('posible token de bot de Telegram');
  });

  it('marca una clave privada PEM', () => {
    expect(hallazgosDeLinea(pega('-----BEGIN ', 'RSA PRIVATE KEY-----'))).toContain(
      'clave privada PEM',
    );
  });

  it('marca una clave de AWS y un token de GitHub', () => {
    expect(hallazgosDeLinea(pega('aws_access_key_id = AKIA', 'IOSFODNN7EXAMPLE'))).toContain(
      'clave de acceso de AWS',
    );
    expect(hallazgosDeLinea(pega('token=ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'))).toContain(
      'token de GitHub',
    );
  });

  it('marca una asignación de secreto en texto plano', () => {
    expect(hallazgosDeLinea(pega('PASSWORD=', 'UnaClaveLargaDeVerdad123'))).toContain(
      'asignación de secreto en texto plano',
    );
  });

  it('nombra el hallazgo del tipo que corresponde', () => {
    expect(hallazgosDeLinea(pega('postgres://u:', 'Zk9-Larga-1234567', '@h:5432/d'))).toEqual([
      CONEXION,
    ]);
  });
});

describe('las rutas que nunca deben versionarse', () => {
  it('rechaza los archivos de secretos', () => {
    expect(isForbiddenPath('.env')).toBe(true);
    expect(isForbiddenPath('services/billing/.env')).toBe(true);
    expect(isForbiddenPath('infra/windows/secrets/respaldo.txt')).toBe(true);
    expect(isForbiddenPath('services/identity/.keys/jwt-private.pem')).toBe(true);
    expect(isForbiddenPath('certificados/servidor.key')).toBe(true);
    expect(isForbiddenPath('keystore.p12')).toBe(true);
  });

  it('deja pasar las plantillas, que se versionan a propósito', () => {
    expect(isForbiddenPath('.env.example')).toBe(false);
    expect(isForbiddenPath('services/billing/.env.example')).toBe(false);
    expect(isForbiddenPath('services/billing/src/index.ts')).toBe(false);
  });
});
