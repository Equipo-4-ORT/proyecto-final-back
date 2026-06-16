/* eslint-disable no-console */
require('dotenv').config();

/**
 * Diagnóstico de la recolección de actividad de Drive fuera de "Mi unidad".
 *
 * Recorre las MISMAS capas que persistDriveActivities, pero imprimiendo en cada
 * paso qué devuelve la API real para tu cuenta, sin tragar errores. Sirve para
 * ver DÓNDE se corta la cadena cuando un cambio fuera de "Mi unidad" no se trackea:
 *   1. Scopes OAuth realmente otorgados al refresh token.
 *   2. Enumeración de Unidades compartidas (drives.list).
 *   3. Enumeración de "Compartido conmigo" (files.list, sharedWithMe).
 *   4. Por cada scope: cuántas actividades crudas trae la Activity API.
 *   5. Cuántas pasan el filtro de actor (isCurrentUser) → lo que se persistiría.
 *
 * Uso (PowerShell):
 *   node scripts/diagnose-drive.js --email martinexequield@gmail.com
 *   node scripts/diagnose-drive.js --email tu@mail.com --start 2026-06-15T00:00:00Z --end 2026-06-17T00:00:00Z
 *
 * Si no pasás ventana, usa los últimos 7 días hasta ahora.
 */

const { google } = require('googleapis');
const prisma = require('../src/shared/database/prisma');
const { decrypt } = require('../src/shared/utils/crypto');
const { getAuthenticatedGoogleClient } = require('../src/modules/google/google.service');
const { buildDriveScopes } = require('../src/modules/drive/drive-scope.service');
const { isCurrentUserActivity } = require('../src/modules/drive/drive-activity.service');

const parseArgs = () => {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
  }
  return args;
};

const ACTION_FILTERS = ['EDIT', 'CREATE', 'RENAME', 'COMMENT', 'PERMISSION_CHANGE', 'MOVE', 'DELETE'];

const describeActors = (activity) =>
  (activity.actors || []).map((a) => {
    if (a.user?.knownUser) {
      const ku = a.user.knownUser;
      return `knownUser(isCurrentUser=${ku.isCurrentUser ?? 'undefined'}, personName=${ku.personName ?? 'none'})`;
    }
    if (a.user?.deletedUser) return 'deletedUser';
    if (a.user?.unknownUser) return 'unknownUser';
    if (a.anonymous) return 'anonymous';
    if (a.system) return 'system';
    if (a.impersonation) return 'impersonation';
    if (a.administrator) return 'administrator';
    return JSON.stringify(a);
  });

const scopeLabel = (scope) => scope.ancestorName ?? scope.itemName ?? JSON.stringify(scope);

async function main() {
  const { email, userId: userIdArg, start, end, file } = parseArgs();

  const now = new Date();
  const timeMax = end || now.toISOString();
  const timeMin = start || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const timeFilter = `time >= "${timeMin}" AND time < "${timeMax}"`;

  console.log('=== Diagnóstico de actividad de Drive ===');
  console.log(`Ventana: ${timeMin}  →  ${timeMax}\n`);

  // ── 0. Resolver usuario y token ───────────────────────────────────────────
  const where = userIdArg ? { id: userIdArg } : { email };
  if (!email && !userIdArg) {
    console.error('Falta --email o --userId');
    process.exit(1);
  }
  const user = await prisma.user.findUnique({
    where,
    select: { id: true, email: true, refreshToken: true, googleId: true },
  });
  if (!user) {
    console.error(`No se encontró el usuario (${JSON.stringify(where)})`);
    process.exit(1);
  }
  if (!user.refreshToken) {
    console.error(`El usuario ${user.email} no tiene refreshToken guardado.`);
    process.exit(1);
  }
  const selfPersonName = user.googleId ? `people/${user.googleId}` : null;
  console.log(`Usuario: ${user.email} (${user.id})`);
  console.log(`selfPersonName esperado (people/{googleId}): ${selfPersonName ?? '⚠ googleId NULL'}\n`);

  const refreshToken = decrypt(user.refreshToken);
  const auth = getAuthenticatedGoogleClient(refreshToken);

  // ── 1. Scopes OAuth realmente otorgados ───────────────────────────────────
  console.log('--- 1. Scopes OAuth otorgados al token ---');
  try {
    const { token } = await auth.getAccessToken();
    const info = await auth.getTokenInfo(token);
    const granted = info.scopes || [];
    const need = [
      'https://www.googleapis.com/auth/drive.activity.readonly',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
    ];
    for (const s of need) {
      console.log(`  ${granted.includes(s) ? '✓' : '✗ FALTA'}  ${s}`);
    }
    const extra = granted.filter((s) => s.includes('drive'));
    console.log(`  (scopes drive presentes: ${extra.join(', ') || 'ninguno'})`);
  } catch (err) {
    console.log(`  ⚠ No se pudo leer tokenInfo: ${err.message}`);
  }
  console.log();

  // ── 2. Enumeración de Unidades compartidas ────────────────────────────────
  console.log('--- 2. Unidades compartidas (drives.list) ---');
  const drive = google.drive({ version: 'v3', auth });
  try {
    const res = await drive.drives.list({ pageSize: 100, fields: 'drives(id,name)' });
    const drives = res.data.drives || [];
    console.log(`  Encontradas: ${drives.length}`);
    drives.forEach((d) => console.log(`    - ${d.name} (${d.id})`));
  } catch (err) {
    console.log(`  ⚠ drives.list falló: ${err.message} (code ${err.code})`);
  }
  console.log();

  // ── 3. Enumeración de "Compartido conmigo" ────────────────────────────────
  console.log('--- 3. "Compartido conmigo" (files.list, sharedWithMe) ---');
  try {
    const res = await drive.files.list({
      q: 'sharedWithMe = true and trashed = false',
      fields: 'files(id,name,mimeType,modifiedTime)',
      pageSize: 50,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files = res.data.files || [];
    console.log(`  Encontrados: ${files.length} (muestra hasta 50)`);
    files.slice(0, 20).forEach((f) =>
      console.log(`    - ${f.name} [${f.mimeType}] mod=${f.modifiedTime} (${f.id})`),
    );
    if (files.length === 0) {
      console.log('  ⚠ NINGÚN archivo "Compartido conmigo". Si tu doc fuera de Mi unidad');
      console.log('    no aparece acá, no se le crea scope itemName y su actividad no se trackea.');
    }
  } catch (err) {
    console.log(`  ⚠ files.list falló: ${err.message} (code ${err.code})`);
  }
  console.log();

  // ── 4. Scopes finales que consultará la recolección ───────────────────────
  console.log('--- 4. Scopes que consultará la Activity API (buildDriveScopes) ---');
  const scopes = await buildDriveScopes(refreshToken, timeMin, timeMax);
  console.log(`  Total: ${scopes.length}`);
  scopes.forEach((s) => console.log(`    - ${scopeLabel(s)}`));
  console.log();

  // ── 5. Actividad cruda por scope + filtro de actor ────────────────────────
  console.log('--- 5. Actividad por scope (cruda → pasa filtro isCurrentUser) ---');
  const driveactivity = google.driveactivity({ version: 'v2', auth });

  let totalRaw = 0;
  let totalOwn = 0;

  // Identidades propias para atribuir docs fuera de "Mi unidad" (mismo criterio
  // que persistDriveActivities): people/{googleId} + personName de actividades
  // que la API sí marcó isCurrentUser (items/root va primero, así las siembra).
  const selfPersonNames = new Set();
  if (selfPersonName) selfPersonNames.add(selfPersonName);

  for (const scope of scopes) {
    const queries = [
      { ...scope, filter: timeFilter, consolidationStrategy: { legacy: {} }, pageSize: 100 },
      ...ACTION_FILTERS.map((action) => ({
        ...scope,
        filter: `${timeFilter} AND detail.action_detail_case:${action}`,
        consolidationStrategy: { legacy: {} },
        pageSize: 100,
      })),
    ];

    let raw = [];
    try {
      const results = await Promise.all(
        queries.map((requestBody) =>
          driveactivity.activity.query({ requestBody }).then((r) => r.data.activities || []),
        ),
      );
      raw = results.flat();
    } catch (err) {
      console.log(`  ${scopeLabel(scope)}: ✗ query falló → ${err.message} (code ${err.code})`);
      continue;
    }

    // Sembrar selfPersonNames con los personName que la API marcó como propios.
    for (const a of raw) {
      for (const actor of a.actors || []) {
        const ku = actor?.user?.knownUser;
        if (ku?.isCurrentUser === true && ku.personName) selfPersonNames.add(ku.personName);
      }
    }

    const own = raw.filter((a) => isCurrentUserActivity(a, selfPersonNames));
    totalRaw += raw.length;
    totalOwn += own.length;

    console.log(`  ${scopeLabel(scope)}: crudas=${raw.length}  propias(isCurrentUser)=${own.length}`);

    // Mostrar actores de una muestra para ver si isCurrentUser viene o no.
    raw.slice(0, 3).forEach((a) => {
      const fileId = a.targets?.[0]?.driveItem?.name ?? a.targets?.[0]?.fileComment?.parent?.name;
      const action = Object.keys(a.primaryActionDetail || {})[0];
      console.log(`      · ${action} ${fileId} | actores: ${describeActors(a).join(', ')}`);
    });
  }

  console.log();
  console.log('=== Resumen ===');
  console.log(`  Actividades crudas (todas las ubicaciones): ${totalRaw}`);
  console.log(`  Atribuidas a vos (isCurrentUser + personName): ${totalOwn}`);
  if (totalRaw > 0 && totalOwn === 0) {
    console.log('  ⚠ Llegan actividades pero NINGUNA pasa el filtro de actor: revisar isCurrentUser/personName.');
  }
  if (totalRaw === 0) {
    console.log('  ⚠ Ningún scope devolvió actividad: revisar ventana de tiempo y/o demora de la API.');
  }

  // ── Inspección puntual de un archivo (--file <fileId>) ────────────────────
  // Muestra TODA la actividad del archivo en la ventana, todos los actores, y
  // marca si tu personName aparece. Útil para confirmar "edité este doc y se
  // trackea": editás el doc, copiás su id de la URL, y verificás acá.
  if (file) {
    console.log();
    console.log(`--- 6. Inspección directa del archivo items/${file} ---`);
    try {
      const res = await driveactivity.activity.query({
        requestBody: {
          itemName: `items/${file}`,
          filter: timeFilter,
          consolidationStrategy: { legacy: {} },
          pageSize: 100,
        },
      });
      const acts = res.data.activities || [];
      console.log(`  Actividades en la ventana: ${acts.length}`);
      let mine = 0;
      for (const a of acts) {
        const action = Object.keys(a.primaryActionDetail || {})[0];
        const ts = a.timeRange?.startTime ?? a.timestamp;
        const isMine = isCurrentUserActivity(a, selfPersonNames);
        if (isMine) mine += 1;
        console.log(
          `      · ${isMine ? '★ VOS' : '      '} ${action} @ ${ts} | ${describeActors(a).join(', ')}`,
        );
      }
      console.log(
        mine > 0
          ? `  ✓ ${mine} actividad(es) tuya(s) en este archivo → se trackearían.`
          : '  ⚠ Ninguna actividad tuya en la ventana. Si lo acabás de editar, esperá unos minutos (indexación) y reintentá; o el doc no es el que editaste.',
      );
    } catch (err) {
      console.log(`  ✗ query falló: ${err.message} (code ${err.code})`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Diagnóstico abortó:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* noop */
  }
  process.exit(1);
});
