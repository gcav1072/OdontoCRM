#!/usr/bin/env node
/**
 * Prueba de humo del acceso (Fase 1) contra el gateway real.
 *
 *   npm run dev            # o: pm2 start infra/windows/ecosystem.config.cjs
 *   npm run smoke:auth
 *
 * No modifica contraseñas: usa el usuario `admin` sembrado y recorre el ciclo de
 * sesión completo. Sale con código 1 si alguna comprobación falla.
 */
const GATEWAY = process.env.SMOKE_GATEWAY_URL ?? 'http://127.0.0.1:8090';
const credentials = {
  username: process.env.SMOKE_USERNAME ?? 'admin',
  password: process.env.SMOKE_PASSWORD ?? 'admin-odontocrm-2026',
};

const call = async (path, options = {}) => {
  const response = await fetch(`${GATEWAY}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: response.status, body, headers: response.headers };
};

let failures = 0;
const check = (label, condition, detail = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? '✔' : '✖'} ${label}${detail === '' ? '' : ` → ${detail}`}`);
};

// 1) Salud pública.
const health = await call('/api/v1/auth/health');
check('salud de identity por el gateway', health.status === 200, `status ${health.status}`);

// 2) Sin token, la API está cerrada; tampoco sirve inventarse la identidad.
const noToken = await call('/api/v1/users');
check('sin token responde 401', noToken.status === 401, `status ${noToken.status}`);

const spoof = await call('/api/v1/users', {
  headers: { 'x-user-id': 'inventado', 'x-user-roles': 'admin' },
});
check('cabeceras de identidad falseadas no sirven', spoof.status === 401, `status ${spoof.status}`);

// 3) Credenciales incorrectas.
const badLogin = await call('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...credentials, password: 'clave-incorrecta' }),
});
check(
  'login con contraseña incorrecta responde 401',
  badLogin.status === 401,
  badLogin.body?.detail,
);

// 4) Login correcto: token en memoria + cookie de refresco httpOnly.
const login = await call('/api/v1/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(credentials),
});
check('login correcto responde 200', login.status === 200, `usuario ${login.body?.user?.username}`);
check('devuelve token de acceso', typeof login.body?.accessToken === 'string');
check('marca la contraseña pendiente de cambio', login.body?.user?.mustChangePassword === true);

const setCookie = login.headers.getSetCookie?.() ?? [];
const cookieHeader = setCookie.map((value) => value.split(';')[0]).join('; ');
check('entrega la cookie de refresco', /odontocrm_refresh=/.test(cookieHeader));
check(
  'la cookie es httpOnly y solo para /api/v1/auth',
  setCookie.some((value) => /HttpOnly/i.test(value) && /Path=\/api\/v1\/auth/i.test(value)),
);

const token = login.body?.accessToken ?? '';
const authHeaders = { authorization: `Bearer ${token}` };

// 5) Con la contraseña pendiente, los módulos quedan bloqueados.
const pending = await call('/api/v1/users', { headers: authHeaders });
check(
  'usuarios bloqueado hasta cambiar la contraseña',
  pending.status === 403,
  pending.body?.detail,
);

// 6) Datos de la sesión para el panel inferior.
const me = await call('/api/v1/auth/me', { headers: authHeaders });
check('/me responde la sesión actual', me.status === 200, `loginAt ${me.body?.loginAt ?? '-'}`);
check('incluye usuario y roles', me.body?.user?.roles?.includes('admin') === true);

// 7) Rotación del refresco.
const refreshed = await call('/api/v1/auth/refresh', {
  method: 'POST',
  headers: { cookie: cookieHeader },
});
check(
  'el refresco rota la sesión',
  refreshed.status === 200 && Boolean(refreshed.body?.accessToken),
);

const rotatedCookies = (refreshed.headers.getSetCookie?.() ?? [])
  .map((value) => value.split(';')[0])
  .join('; ');
check('el refresco devuelve una cookie nueva', rotatedCookies !== cookieHeader);

// 8) Token inválido y cierre de sesión.
const forged = await call('/api/v1/users', { headers: { authorization: 'Bearer inventado' } });
check('token inválido responde 401', forged.status === 401);

const logout = await call('/api/v1/auth/logout', {
  method: 'POST',
  headers: { cookie: rotatedCookies },
});
check('cerrar sesión responde 204', logout.status === 204, `status ${logout.status}`);

const afterLogout = await call('/api/v1/auth/refresh', {
  method: 'POST',
  headers: { cookie: rotatedCookies },
});
check(
  'la sesión cerrada ya no se refresca',
  afterLogout.status === 401,
  `status ${afterLogout.status}`,
);

if (failures > 0) {
  console.error(`\n${String(failures)} comprobación(es) fallaron contra ${GATEWAY}`);
  process.exit(1);
}
console.log(`\nPrueba de humo del acceso correcta contra ${GATEWAY}`);
