// Запись таблицы «код СУИП → модели» прямо в Google-таблицу через API.
//
// НЕОБЯЗАТЕЛЬНЫЙ путь: содержимое собирает deploy/models-table.mjs, и обычно достаточно
// сделать им .xlsx и залить его в таблицу руками (Файл → Импорт). Этот скрипт нужен, только
// если захочется обновлять лист одной командой — за это придётся один раз завести сервисный
// аккаунт Google и выдать ему доступ к таблице (см. DEPLOY.md).
//
// Конфигурация из окружения:
//   S3_* — как у остальных скриптов деплоя
//   GOOGLE_SERVICE_ACCOUNT_KEY — путь к JSON-ключу сервисного аккаунта (умолчание deploy/google-key.json)
//   GOOGLE_SHEET_ID, GOOGLE_SHEET_TAB, SITE_BASE_URL — опционально
//
// Запуск:
//   . .\deploy\config.local.ps1 ; node deploy/sheet-sync.mjs --dry
//   . .\deploy\config.local.ps1 ; node deploy/sheet-sync.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildRows, fetchServiceData, resolveDevStand, HEADER, LAST_COL, SEPARATOR, DEFAULT_SHEET_ID,
} from './models-table.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// ─────────────────────────── авторизация сервисного аккаунта ─────────────────

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(keyPath) {
  let key;
  try {
    key = JSON.parse(await readFile(keyPath, 'utf8'));
  } catch (err) {
    throw new Error(`не читается ключ Google (${keyPath}): ${err.message}`);
  }
  if (!key.client_email || !key.private_key) {
    throw new Error(`в ${keyPath} нет client_email/private_key — это точно ключ сервисного аккаунта?`);
  }
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: key.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claim))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
  const jwt = `${unsigned}.${signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const res = await fetch(claim.aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google не выдал токен (${res.status}): ${body.error_description || body.error || ''}`);
  return { token: body.access_token, email: key.client_email };
}

async function sheetsFetch(token, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = body.error?.message || text || res.statusText;
    if (res.status === 403) throw new Error(`${msg}\n  → дайте сервисному аккаунту доступ «Редактор» к таблице.`);
    throw new Error(`Sheets API ${res.status}: ${msg}`);
  }
  return body;
}

// Ячейка, начинающаяся с =, +, - или @, была бы прочитана как формула.
function safeText(value) {
  const s = value == null ? '' : String(value);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

function a1(tab, range) {
  return encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${range}`);
}

// ─────────────────────────────── синхронизация ───────────────────────────────

/**
 * Читает бакет и таблицу, пересобирает лист и записывает его обратно.
 * @param {{ sheetId?: string, tab?: string, keyPath?: string, siteBase?: string, dry?: boolean }} opts
 */
export async function syncSheet(opts = {}) {
  const sheetId = opts.sheetId || process.env.GOOGLE_SHEET_ID || DEFAULT_SHEET_ID;
  const keyPath = opts.keyPath || process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    || path.join(root, 'deploy', 'google-key.json');

  const data = await fetchServiceData();
  const siteBase = (opts.siteBase || process.env.SITE_BASE_URL
    || `https://${data.bucket}.website.yandexcloud.net/`).replace(/\/*$/, '/');
  const dev = await resolveDevStand(opts, data.bucket);

  const { token, email } = await getAccessToken(keyPath);
  console.log(`Google: сервисный аккаунт ${email}`);

  // Лист: указанный или первый.
  const meta = await sheetsFetch(token, `${SHEETS_API}/${sheetId}?fields=sheets.properties`);
  const wanted = opts.tab || process.env.GOOGLE_SHEET_TAB;
  const sheet = wanted ? meta.sheets.find((s) => s.properties.title === wanted) : meta.sheets[0];
  if (!sheet) throw new Error(`лист «${wanted}» в таблице не найден`);
  const tab = sheet.properties.title;

  // UNFORMATTED_VALUE — чтобы числовые коды не приехали с разделителями разрядов.
  const before = await sheetsFetch(token, `${SHEETS_API}/${sheetId}/values/${a1(tab, `A1:${LAST_COL}`)}?valueRenderOption=UNFORMATTED_VALUE`);
  const oldRows = before.values || [];

  // Порядок кодов = колонка A, без шапки и без нижнего блока «без проекта».
  const codeOrder = [];
  for (let i = 1; i < oldRows.length; i += 1) {
    const cell = String(oldRows[i]?.[0] ?? '').trim();
    if (cell === SEPARATOR) break;
    if (cell) codeOrder.push(cell);
  }

  const built = buildRows(data, codeOrder, siteBase, dev);
  const rows = built.rows.map((row) => row.map(safeText));
  const { stats, dropped } = built;

  console.log(`Таблица «${tab}»: было строк ${Math.max(oldRows.length - 1, 0)}, станет ${stats.dataRows}`);
  console.log(`  строк с моделью: ${stats.withModel}`);
  console.log(`  в блоке «без проекта»: ${stats.unknownRows}`);
  if (dev) console.log(`  со ссылкой на дев: ${stats.devCodes} кодов`);
  if (stats.devMissing?.length) console.log(`  на деве есть, а в таблице нет: ${stats.devMissing.join(', ')}`);
  if (stats.addedCodes.length) console.log(`  новых кодов: ${stats.addedCodes.length} (${stats.addedCodes.slice(0, 10).join(', ')}${stats.addedCodes.length > 10 ? ', …' : ''})`);
  if (dropped.length) console.log(`  удалено кодов (нет в сервисе): ${dropped.length} (${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ', …' : ''})`);

  if (opts.dry) {
    console.log('— dry-run, таблица не изменена.');
    return { rows, stats, dropped };
  }

  // Бэкап прежнего содержимого — рядом со скриптом, в .gitignore.
  const backupPath = path.join(root, 'deploy', 'sheet-backup.json');
  await writeFile(backupPath, JSON.stringify({ sheetId, tab, savedAt: new Date().toISOString(), values: oldRows }, null, 2), 'utf8');
  console.log(`  бэкап прежнего листа: ${path.relative(root, backupPath)}`);

  // Гарантируем размер сетки (иначе update упрётся в границы листа).
  const grid = sheet.properties.gridProperties || {};
  const needRows = rows.length + 20;
  if ((grid.rowCount || 0) < needRows || (grid.columnCount || 0) < HEADER.length) {
    await sheetsFetch(token, `${SHEETS_API}/${sheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          updateSheetProperties: {
            properties: {
              sheetId: sheet.properties.sheetId,
              gridProperties: {
                rowCount: Math.max(grid.rowCount || 0, needRows),
                columnCount: Math.max(grid.columnCount || 0, HEADER.length),
              },
            },
            fields: 'gridProperties.rowCount,gridProperties.columnCount',
          },
        }],
      }),
    });
  }

  // Чистим прежний диапазон и пишем новый — так исчезают «хвосты» от прошлых прогонов.
  await sheetsFetch(token, `${SHEETS_API}/${sheetId}/values/${a1(tab, `A1:${LAST_COL}`)}:clear`, { method: 'POST', body: '{}' });
  await sheetsFetch(
    token,
    `${SHEETS_API}/${sheetId}/values/${a1(tab, `A1:${LAST_COL}${rows.length}`)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ range: `'${tab}'!A1:${LAST_COL}${rows.length}`, majorDimension: 'ROWS', values: rows }) },
  );

  // Шапка: жирная и закреплённая. Идемпотентно, можно гонять каждый раз.
  await sheetsFetch(token, `${SHEETS_API}/${sheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: { sheetId: sheet.properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId: sheet.properties.sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
      ],
    }),
  });

  console.log(`✓ Лист «${tab}» обновлён: https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
  return { rows, stats, dropped };
}

// ─────────────────────────────────── CLI ─────────────────────────────────────

function argValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  syncSheet({
    dry: args.includes('--dry'),
    sheetId: argValue(args, '--sheet'),
    tab: argValue(args, '--tab'),
    keyPath: argValue(args, '--key'),
    siteBase: argValue(args, '--site'),
    devBucket: argValue(args, '--dev-bucket'),
    devSite: argValue(args, '--dev-site'),
    noDev: args.includes('--no-dev'),
  }).catch((err) => {
    console.error('✗ Ошибка синхронизации:', err.message || err);
    process.exit(1);
  });
}
