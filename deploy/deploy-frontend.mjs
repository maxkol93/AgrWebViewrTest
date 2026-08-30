// Заливает сайт (index.html + script.js) и всё, от чего он зависит, в бакет
// Yandex Object Storage: three.js, аддоны three, Draco-декодер и шрифт Unbounded.
// Зависимости раздаются с того же домена, что и сайт (префикс vendor/), чтобы в
// критическом пути не было unpkg.com и *.gstatic.com — у части российских
// провайдеров они режутся, и страница висит на «загрузке модели».
// Подробности: docs/perf-loading-plan.md, п. 2.
//
// Подставляет реальные URL вместо плейсхолдеров прямо в памяти —
// файлы в репозитории остаются с плейсхолдерами.
//
// Кэширование:
//   index.html          — no-cache (всегда свежий)
//   script.<hash>.js    — год + immutable (имя меняется вместе с содержимым)
//   vendor/**           — год + immutable (версии прибиты в deploy/package.json)
// Текстовые файлы жмутся gzip'ом заранее: Object Storage на лету не сжимает.
//
// Конфигурация берётся из переменных окружения:
//   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
//   S3_ENDPOINT (опц.), S3_REGION (опц.),
//   STORAGE_BASE_URL, API_BASE_URL,
//   APP_ENV (опц., 'prod' по умолчанию) — на не-прод стенде добавляет
//     суффикс к версии, бейдж в углу и префикс в <title>, чтобы не спутать вкладки
//
// Запуск:  node deploy/deploy-frontend.mjs

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulesDir = path.join(root, 'deploy', 'node_modules');
const threeDir = path.join(modulesDir, 'three');
const fontDir = path.join(modulesDir, '@fontsource', 'unbounded');

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache, max-age=0';

const TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

// Что жать gzip'ом. woff2 и wasm-в-woff2 уже сжаты, а вот .wasm Draco жмётся вдвое.
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|wasm))/;

// Версия: старшая часть — из файла VERSION (правится вручную),
// патч — число коммитов с момента последнего изменения VERSION
// (после каждого пуша +1, при ручном поднятии VERSION сбрасывается в 0).
function appVersion() {
  let base = '0.0';
  try { base = readFileSync(path.join(root, 'VERSION'), 'utf8').trim() || '0.0'; } catch {}
  const git = (cmd) => execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  let patch = 0;
  try {
    const lastVerCommit = git('git log -1 --format=%H -- VERSION');
    patch = lastVerCommit
      ? Number(git(`git rev-list --count ${lastVerCommit}..HEAD`))
      : Number(git('git rev-list --count HEAD'));
    if (!Number.isFinite(patch)) patch = 0;
  } catch {}
  return `v${base}.${patch}`;
}

const {
  S3_BUCKET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_ENDPOINT = 'https://storage.yandexcloud.net',
  S3_REGION = 'ru-central1',
  STORAGE_BASE_URL,
  API_BASE_URL,
  APP_ENV = 'prod',
} = process.env;

const isProd = APP_ENV === 'prod';

function required(name, value) {
  if (!value) {
    console.error(`✗ Не задана переменная ${name}. Проверьте config.local.ps1 / секреты.`);
    process.exit(1);
  }
  return value;
}

required('S3_BUCKET', S3_BUCKET);
required('S3_ACCESS_KEY_ID', S3_ACCESS_KEY_ID);
required('S3_SECRET_ACCESS_KEY', S3_SECRET_ACCESS_KEY);
required('STORAGE_BASE_URL', STORAGE_BASE_URL);
required('API_BASE_URL', API_BASE_URL);

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  forcePathStyle: false,
});

// Уже лежит ровно это? ETag непрерывной загрузки — это MD5 тела.
// Нужно, чтобы каждый деплой не перезаливал 2.5 МБ неизменных зависимостей.
async function alreadyInBucket(key, payload) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const etag = (head.ETag || '').replaceAll('"', '');
    return etag === createHash('md5').update(payload).digest('hex');
  } catch {
    return false; // нет объекта или нет доступа к HEAD — просто зальём
  }
}

async function put(key, body, contentType, cacheControl, { skipIfSame = false } = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const gzip = COMPRESSIBLE.test(contentType);
  const payload = gzip ? gzipSync(raw, { level: 9 }) : raw;

  if (skipIfSame && await alreadyInBucket(key, payload)) {
    console.log(`  = ${key.padEnd(46)} (не изменился)`);
    return;
  }

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: payload,
    ContentType: contentType,
    ContentEncoding: gzip ? 'gzip' : undefined,
    CacheControl: cacheControl,
  }));

  const size = gzip
    ? `${(raw.length / 1024).toFixed(0)} → ${(payload.length / 1024).toFixed(0)} КБ gzip`
    : `${(raw.length / 1024).toFixed(0)} КБ`;
  console.log(`  ✓ ${key.padEnd(46)} (${size})`);
}

// ── three.js: заливаем только те аддоны, которые реально импортируются ───────
// В examples/jsm сотни файлов; идём по графу импортов от точек входа script.js.
const ADDON_ENTRIES = [
  'controls/OrbitControls.js',
  'loaders/GLTFLoader.js',
  'loaders/DRACOLoader.js',
  'loaders/RGBELoader.js',
  'exporters/GLTFExporter.js',
  // Постпроцессинг (этап B). script.js тянет их динамическим import(), поэтому
  // от статических импортов граф сюда не доходит — список только руками.
  // Забыть строку здесь = 404 в рантайме на стенде при локально рабочей сборке.
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/HBAOPass.js',
  'postprocessing/OutlinePass.js',
  'postprocessing/SMAAPass.js',
  'postprocessing/OutputPass.js',
];

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g;

async function collectAddons() {
  const jsm = path.join(threeDir, 'examples', 'jsm');
  const found = new Map(); // путь относительно examples/jsm → исходник
  const queue = [...ADDON_ENTRIES];

  while (queue.length) {
    const rel = queue.shift();
    if (found.has(rel)) continue;

    let code;
    try {
      code = await readFile(path.join(jsm, rel), 'utf8');
    } catch {
      console.error(`✗ Не найден модуль three/addons/${rel} — проверьте версию three в deploy/package.json.`);
      process.exit(1);
    }
    found.set(rel, code);

    for (const [, spec] of code.matchAll(IMPORT_RE)) {
      // Голый 'three' резолвится importmap'ом; интересны только соседние файлы.
      if (spec.startsWith('.')) queue.push(path.posix.join(path.posix.dirname(rel), spec));
    }
  }
  return found;
}

// ── Шрифт: собираем @font-face сами, чтобы не делать лишний запрос за CSS ────
const FONT_WEIGHTS = [300, 400, 500, 700];   // те же начертания, что просили у Google Fonts
const FONT_SUBSETS = ['cyrillic', 'cyrillic-ext', 'latin', 'latin-ext'];

async function buildFontFaces() {
  const ranges = JSON.parse(await readFile(path.join(fontDir, 'unicode.json'), 'utf8'));
  const files = [];
  const rules = [];

  for (const weight of FONT_WEIGHTS) {
    for (const subset of FONT_SUBSETS) {
      const file = `unbounded-${subset}-${weight}-normal.woff2`;
      files.push(file);
      // unicode-range обязателен: без него браузер скачает только последний
      // подходящий @font-face, а с ним — ровно те подмножества, что нужны тексту.
      rules.push(
        `@font-face{font-family:'Unbounded';font-style:normal;font-display:swap;` +
        `font-weight:${weight};src:url(./vendor/fonts/${file}) format('woff2');` +
        `unicode-range:${ranges[subset]}}`
      );
    }
  }
  return { css: rules.join('\n'), files };
}

async function uploadVendor(fontFiles) {
  const opts = { skipIfSame: true };

  await put(
    'vendor/three/build/three.module.js',
    await readFile(path.join(threeDir, 'build', 'three.module.js')),
    TYPES['.js'], IMMUTABLE, opts,
  );

  const addons = await collectAddons();
  for (const [rel, code] of addons) {
    await put(`vendor/three/examples/jsm/${rel}`, code, TYPES['.js'], IMMUTABLE, opts);
  }

  // Draco: вариант gltf/ — тот же декодер, но собранный только под glTF (вдвое меньше).
  // draco_decoder.js — запасной путь для браузеров без WebAssembly.
  const dracoDir = path.join(threeDir, 'examples', 'jsm', 'libs', 'draco', 'gltf');
  for (const file of ['draco_wasm_wrapper.js', 'draco_decoder.wasm', 'draco_decoder.js']) {
    await put(
      `vendor/draco/${file}`,
      await readFile(path.join(dracoDir, file)),
      TYPES[path.extname(file)], IMMUTABLE, opts,
    );
  }

  // Полифил importmap — нужен только старым браузерам (Safari < 16.4), грузится async.
  await put(
    'vendor/es-module-shims.js',
    await readFile(path.join(modulesDir, 'es-module-shims', 'dist', 'es-module-shims.js')),
    TYPES['.js'], IMMUTABLE, opts,
  );

  for (const file of fontFiles) {
    await put(
      `vendor/fonts/${file}`,
      await readFile(path.join(fontDir, 'files', file)),
      TYPES['.woff2'], IMMUTABLE, opts,
    );
  }
}

// Каждая сборка кладёт script.<hash>.js под новым именем — старые надо убирать,
// иначе бакет засоряется по 250 КБ за деплой.
// Уборка мусора не должна ронять уже успешный деплой: если у ключа нет прав
// на список/удаление, просто предупреждаем.
async function dropOldScripts(keepKey) {
  try {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: 'script.' }));
    const stale = (list.Contents || [])
      .map((o) => o.Key)
      .filter((key) => key !== keepKey && /^script\.[0-9a-f]{10}\.js$/.test(key));

    if (!stale.length) return;
    await s3.send(new DeleteObjectsCommand({
      Bucket: S3_BUCKET,
      Delete: { Objects: stale.map((Key) => ({ Key })) },
    }));
    console.log(`  ✓ убрано старых сборок script.js: ${stale.length}`);
  } catch (err) {
    console.warn(`  ! не удалось убрать старые сборки script.js: ${err.message || err}`);
  }
}

async function main() {
  console.log(`→ Заливаю сайт в бакет "${S3_BUCKET}" (окружение: ${APP_ENV})…`);

  // На не-прод стенде версия помечается суффиксом: v0.2.7-dev
  const version = appVersion() + (isProd ? '' : `-${APP_ENV}`);
  console.log(`  версия: ${version}`);

  const font = await buildFontFaces();

  console.log('\n  Зависимости (three.js, Draco, шрифт):');
  await uploadVendor(font.files);

  const js = await readFile(path.join(root, 'script.js'), 'utf8');
  // Имя с хэшем позволяет держать годовой immutable-кэш: новая сборка — новое имя.
  const jsKey = `script.${createHash('sha256').update(js).digest('hex').slice(0, 10)}.js`;

  let html = await readFile(path.join(root, 'index.html'), 'utf8');
  html = html
    .replaceAll('STORAGE_BASE_URL_PLACEHOLDER', STORAGE_BASE_URL)
    .replaceAll('API_BASE_URL_PLACEHOLDER', API_BASE_URL)
    .replaceAll('VERSION_PLACEHOLDER', version)
    .replaceAll('/* FONT_FACE_PLACEHOLDER */', font.css)
    .replaceAll('./SCRIPT_JS_PLACEHOLDER', `./${jsKey}`)
    .replaceAll('<!-- ENV_BADGE_PLACEHOLDER -->',
      isProd ? '' : `<div id="env-badge">${APP_ENV.toUpperCase()}</div>`);

  // Префикс во вкладке — чтобы дев-вкладку нельзя было принять за прод
  if (!isProd) html = html.replace('<title>', `<title>[${APP_ENV.toUpperCase()}] `);

  if (html.includes('_PLACEHOLDER')) {
    console.error('✗ В index.html остались неподставленные плейсхолдеры — прерываю.');
    process.exit(1);
  }

  console.log('\n  Сайт:');
  await put(jsKey, js, TYPES['.js'], IMMUTABLE);
  await put('index.html', html, 'text/html; charset=utf-8', NO_CACHE);

  // Только после того, как index.html уже указывает на новую сборку.
  await dropOldScripts(jsKey);

  console.log('\n✓ Сайт обновлён.');
}

main().catch((err) => {
  console.error('✗ Ошибка заливки сайта:', err.message || err);
  process.exit(1);
});
