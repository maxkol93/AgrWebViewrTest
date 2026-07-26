// Импорт каталога проектов/подпроектов в бакет (идемпотентный мёрж по коду).
//
// Вход: JSON-массив [{ code, project, subproject }] — по умолчанию docs/projects_codes.json.
// (Excel парсит человек и кладёт сюда JSON; скрипт не зависит от парсеров xlsx.)
//
// Мёрж:
//   • проект ищется по имени (без учёта регистра), новый — создаётся + Common-подпроект;
//   • подпроект ищется по code: есть — обновляем name/projectId; нет — создаём;
//   • НИЧЕГО не удаляем (подпроекты с моделями в безопасности по определению).
//
// Конфигурация из окружения (те же, что у деплоя):
//   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT (опц.), S3_REGION (опц.)
//
// Запуск:
//   . .\deploy\config.local.ps1 ; node deploy/import-catalog.mjs [путь-к-catalog.json] [--dry]

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROJECTS_KEY = 'projects.json';
const SUBPROJECTS_KEY = 'subprojects.json';
const UNKNOWN_PROJECT_ID = 'unknown';
const UNKNOWN_PROJECT_NAME = 'Unknown';
const UNKNOWN_COMMON_ID = 'unknown-common';
const UNKNOWN_COMMON_CODE = 'unknown-common';
const COMMON_NAME = 'Common';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
// --reset: пересобрать projects.json/subprojects.json с нуля (Unknown + Common + каталог),
// отбросив старые плоские проекты. models.json НЕ трогается. Для первого прогона миграции.
const reset = args.includes('--reset');
const catalogPath = args.find((a) => !a.startsWith('--')) || path.join(root, 'docs', 'projects_codes.json');

const {
  S3_BUCKET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_ENDPOINT = 'https://storage.yandexcloud.net',
  S3_REGION = 'ru-central1',
} = process.env;

function required(name, value) {
  if (!value) {
    console.error(`✗ Не задана переменная ${name}. Загрузите deploy/config.local.ps1.`);
    process.exit(1);
  }
  return value;
}
required('S3_BUCKET', S3_BUCKET);
required('S3_ACCESS_KEY_ID', S3_ACCESS_KEY_ID);
required('S3_SECRET_ACCESS_KEY', S3_SECRET_ACCESS_KEY);

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  forcePathStyle: false,
});

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};
function slugify(name) {
  let out = '';
  for (const ch of String(name || '').toLowerCase()) {
    if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += '-';
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '') || 'x';
}
function makeCommonCode(projectName, existingCodes) {
  const base = `${slugify(projectName)}-common`;
  let code = base;
  let i = 2;
  while (existingCodes.has(code)) { code = `${base}-${i}`; i += 1; }
  return code;
}

async function readJsonKey(key, fallback) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const text = await res.Body.transformToString();
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return fallback;
    throw err;
  }
}
async function writeJsonKey(key, data) {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'no-cache, max-age=0',
  }));
}

function ensureCommon(subprojects, project) {
  let common = subprojects.find((s) => s.projectId === project.id && s.isCommon);
  if (common) return common;
  const codes = new Set(subprojects.map((s) => s.code));
  common = {
    id: project.id === UNKNOWN_PROJECT_ID ? UNKNOWN_COMMON_ID : crypto.randomUUID(),
    code: project.id === UNKNOWN_PROJECT_ID ? UNKNOWN_COMMON_CODE : makeCommonCode(project.name, codes),
    projectId: project.id,
    name: COMMON_NAME,
    isCommon: true,
    createdAt: new Date().toISOString(),
  };
  subprojects.push(common);
  return common;
}

async function main() {
  const rawCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  if (!Array.isArray(rawCatalog)) {
    console.error('✗ Каталог должен быть JSON-массивом [{code, project, subproject}].');
    process.exit(1);
  }

  const projects = reset ? [] : (await readJsonKey(PROJECTS_KEY, []) || []);
  const subprojects = reset ? [] : (await readJsonKey(SUBPROJECTS_KEY, []) || []);
  if (reset) console.log('⚠ Режим --reset: каталог пересобирается с нуля (старые проекты отбрасываются).');

  // Гарантируем Unknown/Common.
  if (!projects.some((p) => p.id === UNKNOWN_PROJECT_ID)) {
    projects.unshift({ id: UNKNOWN_PROJECT_ID, name: UNKNOWN_PROJECT_NAME, createdAt: new Date(0).toISOString() });
  }
  ensureCommon(subprojects, projects.find((p) => p.id === UNKNOWN_PROJECT_ID));

  const projByName = new Map(projects.map((p) => [p.name.toLowerCase(), p]));
  const subByCode = new Map(subprojects.map((s) => [String(s.code), s]));

  const stats = { newProjects: 0, newSubprojects: 0, updatedSubprojects: 0, skipped: 0 };

  for (const row of rawCatalog) {
    const code = String(row.code ?? '').trim();
    const projectName = String(row.project ?? '').trim();
    const subName = String(row.subproject ?? '').trim() || projectName;
    if (!code || !projectName) { stats.skipped += 1; continue; }

    // Проект
    let project = projByName.get(projectName.toLowerCase());
    if (!project) {
      project = { id: crypto.randomUUID(), name: projectName, createdAt: new Date().toISOString() };
      projects.push(project);
      projByName.set(projectName.toLowerCase(), project);
      const common = ensureCommon(subprojects, project);
      subByCode.set(String(common.code), common);
      stats.newProjects += 1;
    }

    // Подпроект по коду
    const existing = subByCode.get(code);
    if (existing) {
      if (existing.name !== subName || existing.projectId !== project.id) {
        existing.name = subName;
        existing.projectId = project.id;
        stats.updatedSubprojects += 1;
      }
    } else {
      const sub = {
        id: crypto.randomUUID(),
        code,
        projectId: project.id,
        name: subName,
        isCommon: false,
        createdAt: new Date().toISOString(),
      };
      subprojects.push(sub);
      subByCode.set(code, sub);
      stats.newSubprojects += 1;
    }
  }

  // Добиваем Common каждому проекту (на случай старых проектов без Common).
  for (const p of projects) ensureCommon(subprojects, p);

  console.log(`Каталог: ${rawCatalog.length} строк из ${path.relative(root, catalogPath)}`);
  console.log(`Итог: проектов ${projects.length}, подпроектов ${subprojects.length}`);
  console.log(`  новых проектов: ${stats.newProjects}`);
  console.log(`  новых подпроектов: ${stats.newSubprojects}`);
  console.log(`  обновлено подпроектов: ${stats.updatedSubprojects}`);
  console.log(`  пропущено строк (без кода/проекта): ${stats.skipped}`);

  if (dryRun) {
    console.log('— dry-run, ничего не записано.');
    return;
  }
  await writeJsonKey(PROJECTS_KEY, projects);
  await writeJsonKey(SUBPROJECTS_KEY, subprojects);
  console.log('✓ projects.json и subprojects.json обновлены в бакете.');
}

main().catch((err) => {
  console.error('✗ Ошибка импорта:', err.message || err);
  process.exit(1);
});
