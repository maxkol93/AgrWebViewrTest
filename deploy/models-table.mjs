// Сборка таблицы «код СУИП → модели» в файл .xlsx (без авторизации в Google).
//
// Колонки: код СУИП / ПРОЕКТ / ОЧЕРЕДЬ\ЭТАП / МОДЕЛЬ (да-нет) / ССЫЛКА / ССЫЛКА (ДЕВ) /
// ДАТА / КОРОТКОЕ ИМЯ / КОММЕНТАРИЙ / ФАЙЛ. Несколько версий модели у одного этапа —
// несколько строк подряд (сверху свежая). Модели проекта Unknown — блоком в самом низу.
//
// «ССЫЛКА (ДЕВ)» считается по отдельному чтению дев-бакета: там моделей меньше, поэтому
// ссылка ставится, только если код на деве реально есть (в т.ч. когда на проде модели нет).
//
// Порядок строк берётся из существующей Google-таблицы (её публичный CSV-экспорт, читается
// без ключей), поэтому пересборка не тасует проекты: знакомые коды остаются на своих местах,
// новые дописываются в конец блока своего проекта, пропавшие из сервиса исчезают.
// Если таблица недоступна (нет сети/закрыт доступ) — порядок берётся из docs/projects_codes.json.
//
// Конфигурация из окружения:
//   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT (опц.), S3_REGION (опц.)
//   GOOGLE_SHEET_ID (опц.) — откуда брать порядок строк, по умолчанию рабочая таблица
//   SITE_BASE_URL   (опц.) — база ссылок, по умолчанию https://<бакет>.website.yandexcloud.net/
//   DEV_S3_BUCKET / DEV_SITE_BASE_URL (опц.) — дев-стенд, по умолчанию <бакет>-dev
//
// Запуск:
//   . .\deploy\config.local.ps1 ; node deploy/models-table.mjs
//   . .\deploy\config.local.ps1 ; node deploy/models-table.mjs --out C:\temp\модели.xlsx
//   . .\deploy\config.local.ps1 ; node deploy/models-table.mjs --no-dev   # без колонки дева

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_SHEET_ID = '1yXj-B9JxBmEDUtZrtK2dXq7WV0py0OCgMoem0SsQ7uI';
export const SEPARATOR = '— Модели без проекта —';
const UNKNOWN_PROJECT_ID = 'unknown';

// Первые три колонки — исходный каталог, дальше наши.
export const HEADER = [
  'код СУИП', 'ПРОЕКТ', 'ОЧЕРЕДЬ\\ЭТАП',
  'МОДЕЛЬ', 'ССЫЛКА', 'ССЫЛКА (ДЕВ)', 'ДАТА', 'КОРОТКОЕ ИМЯ', 'КОММЕНТАРИЙ', 'ФАЙЛ',
];
const COL_WIDTHS = [12, 24, 34, 9, 46, 46, 12, 34, 40, 30];

// ─────────────────────────────── чтение бакета ───────────────────────────────

// Ключи у стендов общие (см. DEPLOY.md), поэтому вторым бакетом читается соседний стенд.
function makeS3(bucketOverride) {
  const {
    S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
    S3_ENDPOINT = 'https://storage.yandexcloud.net', S3_REGION = 'ru-central1',
  } = process.env;
  for (const [name, value] of Object.entries({ S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY })) {
    if (!value) {
      console.error(`✗ Не задана переменная ${name}. Загрузите deploy/config.local.ps1.`);
      process.exit(1);
    }
  }
  const client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
    forcePathStyle: false,
  });
  return { client, bucket: bucketOverride || S3_BUCKET };
}

async function readJsonKey({ client, bucket }, key, fallback) {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await res.Body.transformToString());
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return fallback;
    throw err;
  }
}

/** Читает projects/subprojects/models из бакета. */
export async function fetchServiceData() {
  const s3 = makeS3();
  const [projects, subprojects, models] = await Promise.all([
    readJsonKey(s3, 'projects.json', []),
    readJsonKey(s3, 'subprojects.json', []),
    readJsonKey(s3, 'models.json', []),
  ]);
  console.log(`Бакет ${s3.bucket}: проектов ${projects.length}, подпроектов ${subprojects.length}, моделей ${models.length}`);
  return { projects, subprojects, models, bucket: s3.bucket };
}

/** Коды подпроектов, у которых на соседнем стенде есть хотя бы одна модель. */
export async function fetchStandCodes(bucket) {
  const s3 = makeS3(bucket);
  const [subprojects, models] = await Promise.all([
    readJsonKey(s3, 'subprojects.json', []),
    readJsonKey(s3, 'models.json', []),
  ]);
  const byId = new Map(subprojects.map((s) => [s.id, s]));
  const codes = new Set();
  for (const m of models) {
    const sub = byId.get(m.subprojectId);
    if (sub && sub.code) codes.add(String(sub.code));
  }
  return { codes, models: models.length };
}

/**
 * Готовит данные для колонки «ССЫЛКА (ДЕВ)»: множество кодов дев-стенда + база ссылок.
 * Дев читается отдельно от прода — там моделей меньше, и ссылка не должна вести в пустоту.
 * Недоступный дев не валит выгрузку: колонка просто останется пустой.
 *
 * @returns {Promise<{ codes: Set<string>, base: string } | null>}
 */
export async function resolveDevStand(opts = {}, currentBucket) {
  if (opts.noDev) return null;
  const bucket = opts.devBucket || process.env.DEV_S3_BUCKET
    || (/-dev$/.test(currentBucket) ? currentBucket : `${currentBucket}-dev`);
  if (bucket === currentBucket) {
    console.warn('⚠ Дев-бакет совпадает с текущим — колонка «ССЫЛКА (ДЕВ)» пропущена.');
    return null;
  }
  const base = (opts.devSite || process.env.DEV_SITE_BASE_URL
    || `https://${bucket}.website.yandexcloud.net/`).replace(/\/*$/, '/');
  try {
    const { codes, models } = await fetchStandCodes(bucket);
    console.log(`Дев-бакет ${bucket}: моделей ${models}, кодов с моделью ${codes.size}`);
    return { codes, base };
  } catch (err) {
    console.warn(`⚠ Дев-бакет ${bucket} не прочитан (${err.message}) — колонка «ССЫЛКА (ДЕВ)» будет пустой.`);
    return null;
  }
}

// ───────────────────────── порядок строк из Google-таблицы ────────────────────

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * Порядок кодов из публичного CSV-экспорта таблицы (первая колонка, до разделителя).
 * Возвращает [] и пишет предупреждение, если таблица недоступна.
 */
export async function fetchSheetOrder(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('вместо CSV пришла HTML-страница (закрыт доступ по ссылке?)');
    const codes = [];
    for (const row of parseCsv(text).slice(1)) {
      const code = String(row[0] ?? '').trim();
      if (code === SEPARATOR) break;
      if (code) codes.push(code);
    }
    console.log(`Порядок строк: из Google-таблицы (${codes.length} кодов)`);
    return codes;
  } catch (err) {
    console.warn(`⚠ Таблица недоступна (${err.message}) — порядок берём из docs/projects_codes.json.`);
    try {
      const catalog = JSON.parse(await readFile(path.join(root, 'docs', 'projects_codes.json'), 'utf8'));
      return catalog.map((r) => String(r.code ?? '').trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
}

// ─────────────────────────────── сборка строк ────────────────────────────────

function isoDate(model) {
  const raw = model.modelDate || model.uploadedAt || '';
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function shortName(model) {
  const base = model.displayName || model.name || '';
  return model.versionName ? `${base} — ${model.versionName}` : base;
}

function modelsSorted(models) {
  return [...models].sort((a, b) => {
    const d = String(b.modelDate || '').localeCompare(String(a.modelDate || ''));
    return d !== 0 ? d : String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || ''));
  });
}

/**
 * Строит содержимое листа: [шапка, ...строки]. Все ячейки — строки (дата в ISO).
 *
 * @param {object}   data              — { projects, subprojects, models } из бакета
 * @param {string[]} existingCodeOrder — коды из текущей таблицы, сверху вниз (порядок сохраняем)
 * @param {string}   siteBase          — база ссылок вида https://…/
 * @param {{codes: Set<string>, base: string}|null} dev — дев-стенд для колонки «ССЫЛКА (ДЕВ)»
 * @returns {{ rows: string[][], stats: object, dropped: string[] }}
 */
export function buildRows({ projects, subprojects, models }, existingCodeOrder, siteBase, dev = null) {
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const subById = new Map(subprojects.map((s) => [s.id, s]));

  const modelsBySub = new Map();
  const orphans = []; // модели, чей подпроект вообще не нашёлся
  for (const m of models) {
    if (!subById.has(m.subprojectId)) { orphans.push(m); continue; }
    if (!modelsBySub.has(m.subprojectId)) modelsBySub.set(m.subprojectId, []);
    modelsBySub.get(m.subprojectId).push(m);
  }

  // Каталожная часть: всё, кроме проекта Unknown. Common-подпроекты попадают сюда же —
  // они принадлежат реальному проекту, просто без этапа; но пустой Common (а он есть
  // у каждого проекта по умолчанию) таблицу не засоряет.
  const catalogSubs = subprojects.filter((s) => s.projectId !== UNKNOWN_PROJECT_ID
    && (!s.isCommon || (modelsBySub.get(s.id) || []).length > 0));
  const unknownSubs = subprojects.filter((s) => s.projectId === UNKNOWN_PROJECT_ID);

  const subByCode = new Map(catalogSubs.map((s) => [String(s.code), s]));

  // 1) коды, уже стоящие в таблице, — в прежнем порядке; пропавшие из сервиса отбрасываем
  const ordered = [];
  const placed = new Set();
  const dropped = [];
  for (const code of existingCodeOrder) {
    const key = String(code);
    if (placed.has(key)) continue;
    const sub = subByCode.get(key);
    if (!sub) { if (key) dropped.push(key); continue; }
    ordered.push(sub);
    placed.add(key);
  }

  // 2) новые коды — в конец блока своего проекта, иначе в конец каталога
  const added = [];
  for (const sub of catalogSubs) {
    if (placed.has(String(sub.code))) continue;
    let insertAt = -1;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      if (ordered[i].projectId === sub.projectId) { insertAt = i + 1; break; }
    }
    if (insertAt === -1) ordered.push(sub);
    else ordered.splice(insertAt, 0, sub);
    placed.add(String(sub.code));
    added.push(String(sub.code));
  }

  const link = (code) => `${siteBase}?model=${encodeURIComponent(code)}`;
  // На деве модель может быть, когда на проде её ещё нет (и наоборот) — ссылку ставим,
  // только если код действительно есть на дев-стенде.
  const devLink = (code) => (dev && dev.codes.has(String(code))
    ? `${dev.base}?model=${encodeURIComponent(code)}`
    : '');

  const devCodesUsed = new Set();
  const rowsForSub = (sub, projectName) => {
    const list = modelsSorted(modelsBySub.get(sub.id) || []);
    const head = [String(sub.code), projectName, sub.isCommon ? 'Common' : sub.name];
    const onDev = devLink(sub.code);
    if (onDev) devCodesUsed.add(String(sub.code));
    if (list.length === 0) return [[...head, 'нет', '', onDev, '', '', '', '']];
    return list.map((m) => [
      ...head, 'да', link(sub.code), onDev, isoDate(m), shortName(m), m.comment || '', m.name || '',
    ]);
  };

  const rows = [HEADER];
  let withModel = 0;
  for (const sub of ordered) {
    const project = projectById.get(sub.projectId);
    const subRows = rowsForSub(sub, project ? project.name : '');
    if (subRows[0][3] === 'да') withModel += subRows.length;
    rows.push(...subRows);
  }

  // 3) низ таблицы: модели без проекта
  const bottom = [];
  for (const sub of unknownSubs) {
    if (!(modelsBySub.get(sub.id) || []).length) continue;
    bottom.push(...rowsForSub(sub, 'Unknown'));
  }
  for (const m of orphans) {
    bottom.push(['', 'Unknown', '(подпроект удалён)', 'да', '', '', isoDate(m), shortName(m), m.comment || '', m.name || '']);
  }
  if (bottom.length) {
    rows.push(new Array(HEADER.length).fill(''));
    rows.push([SEPARATOR, ...new Array(HEADER.length - 1).fill('')]);
    rows.push(...bottom);
    withModel += bottom.length;
  }

  // Коды, которые есть на деве, но в таблицу не попали (нет такого подпроекта на проде).
  const devMissing = dev ? [...dev.codes].filter((c) => !devCodesUsed.has(c)) : [];

  return {
    rows,
    dropped,
    stats: {
      dataRows: rows.length - 1,
      unknownRows: bottom.length,
      withModel,
      addedCodes: added,
      devCodes: devCodesUsed.size,
      devMissing,
    },
  };
}

// ────────────────────────────── запись .xlsx ─────────────────────────────────
// Минимальный OOXML: zip из пяти XML-частей. Внешних зависимостей не нужно.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.from(data, 'utf8');
    const deflated = zlib.deflateRawSync(body);
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // флаг UTF-8 имён
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(0, 10);           // время
    local.writeUInt16LE(0x21, 12);        // дата (1.1.1996 — фиксированная, чтобы файл был воспроизводим)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(body.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42); // смещение локального заголовка
    central.push(Buffer.concat([dir, nameBuf]));

    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

function esc(value) {
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// Excel считает дни от 1899-12-30.
function dateSerial(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const days = (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
  return Number.isFinite(days) ? days : null;
}

const DATE_COL = HEADER.indexOf('ДАТА');
export const LAST_COL = colName(HEADER.length - 1);

/** Собирает .xlsx (Buffer) из массива строк; первая строка — шапка. */
export function buildXlsx(rows, sheetName = 'Модели') {
  const hyperlinks = [];
  const body = rows.map((row, r) => {
    const cells = [];
    for (let c = 0; c < HEADER.length; c += 1) {
      const raw = row[c] == null ? '' : String(row[c]);
      if (raw === '') continue;
      const ref = `${colName(c)}${r + 1}`;
      if (r === 0) { cells.push(`<c r="${ref}" s="1" t="inlineStr"><is><t>${esc(raw)}</t></is></c>`); continue; }
      if (c === DATE_COL) {
        const serial = dateSerial(raw);
        if (serial !== null) { cells.push(`<c r="${ref}" s="2"><v>${serial}</v></c>`); continue; }
      }
      if (/^https?:\/\//.test(raw)) {
        hyperlinks.push({ ref, target: raw });
        cells.push(`<c r="${ref}" s="3" t="inlineStr"><is><t>${esc(raw)}</t></is></c>`);
        continue;
      }
      // Числовые коды пишем числом — как в исходной таблице (кроме ведущих нулей).
      if (c === 0 && /^[1-9]\d{0,14}$/.test(raw)) { cells.push(`<c r="${ref}"><v>${raw}</v></c>`); continue; }
      cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(raw)}</t></is></c>`);
    }
    return `<row r="${r + 1}">${cells.join('')}</row>`;
  }).join('');

  const lastRef = `${colName(HEADER.length - 1)}${rows.length}`;
  const cols = COL_WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const linkRels = hyperlinks.map((h, i) => `<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(h.target)}" TargetMode="External"/>`).join('');
  const linkTags = hyperlinks.length
    ? `<hyperlinks>${hyperlinks.map((h, i) => `<hyperlink ref="${h.ref}" r:id="rIdL${i + 1}"/>`).join('')}</hyperlinks>`
    : '';

  const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  const files = [
    {
      name: '[Content_Types].xml',
      data: `${xmlHead}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: `${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `${xmlHead}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>`
        + `<sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`
        + `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `${xmlHead}<styleSheet xmlns="${MAIN}">`
        + '<numFmts count="1"><numFmt numFmtId="164" formatCode="DD.MM.YYYY"/></numFmts>'
        + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'
        + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
        + '<font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Calibri"/></font></fonts>'
        + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        + '<fill><patternFill patternType="gray125"/></fill></fills>'
        + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
        + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `${xmlHead}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">`
        + `<dimension ref="A1:${lastRef}"/>`
        + '<sheetViews><sheetView workbookViewId="0">'
        + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        + '<sheetFormatPr defaultRowHeight="15"/>'
        + `<cols>${cols}</cols><sheetData>${body}</sheetData>`
        + `<autoFilter ref="A1:${lastRef}"/>${linkTags}</worksheet>`,
    },
  ];
  if (hyperlinks.length) {
    files.push({
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      data: `${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${linkRels}</Relationships>`,
    });
  }
  return zip(files);
}

// ─────────────────────────────────── CLI ─────────────────────────────────────

function argValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

/** Читает сервис + порядок из таблицы и кладёт .xlsx на диск. */
export async function exportXlsx(opts = {}) {
  const sheetId = opts.sheetId || process.env.GOOGLE_SHEET_ID || DEFAULT_SHEET_ID;
  const data = await fetchServiceData();
  const siteBase = (opts.siteBase || process.env.SITE_BASE_URL
    || `https://${data.bucket}.website.yandexcloud.net/`).replace(/\/*$/, '/');
  const dev = await resolveDevStand(opts, data.bucket);
  const order = opts.order || await fetchSheetOrder(sheetId);

  const { rows, stats, dropped } = buildRows(data, order, siteBase, dev);
  const outPath = path.resolve(opts.out || path.join(root, 'models-table.xlsx'));
  await writeFile(outPath, buildXlsx(rows));

  console.log(`Строк: ${stats.dataRows} (с моделью ${stats.withModel}, в блоке «без проекта» ${stats.unknownRows})`);
  if (dev) console.log(`  со ссылкой на дев: ${stats.devCodes} кодов`);
  if (stats.devMissing?.length) console.log(`  на деве есть, а в таблице нет: ${stats.devMissing.join(', ')}`);
  if (stats.addedCodes.length) console.log(`  новых кодов: ${stats.addedCodes.length} (${stats.addedCodes.slice(0, 10).join(', ')}${stats.addedCodes.length > 10 ? ', …' : ''})`);
  if (dropped.length) console.log(`  нет в сервисе, из таблицы убраны: ${dropped.length} (${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ', …' : ''})`);
  console.log(`✓ Файл: ${outPath}`);
  return { rows, stats, dropped, outPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  exportXlsx({
    out: argValue(args, '--out'),
    sheetId: argValue(args, '--sheet'),
    siteBase: argValue(args, '--site'),
    devBucket: argValue(args, '--dev-bucket'),
    devSite: argValue(args, '--dev-site'),
    noDev: args.includes('--no-dev'),
  }).catch((err) => {
    console.error('✗ Ошибка сборки таблицы:', err.message || err);
    process.exit(1);
  });
}
