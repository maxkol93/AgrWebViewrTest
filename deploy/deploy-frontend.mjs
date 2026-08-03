// Заливает сайт (index.html + script.js) в бакет Yandex Object Storage.
// Подставляет реальные URL вместо плейсхолдеров прямо в памяти —
// файлы в репозитории остаются с плейсхолдерами.
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
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

async function put(key, body, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'no-cache, max-age=0', // сайт всегда свежий, без ожидания CDN/кэша
  }));
  const size = Buffer.byteLength(body);
  console.log(`  ✓ ${key.padEnd(12)} (${(size / 1024).toFixed(0)} КБ)`);
}

async function main() {
  console.log(`→ Заливаю сайт в бакет "${S3_BUCKET}" (окружение: ${APP_ENV})…`);

  // На не-прод стенде версия помечается суффиксом: v0.2.7-dev
  const version = appVersion() + (isProd ? '' : `-${APP_ENV}`);
  console.log(`  версия: ${version}`);

  let html = await readFile(path.join(root, 'index.html'), 'utf8');
  html = html
    .replaceAll('STORAGE_BASE_URL_PLACEHOLDER', STORAGE_BASE_URL)
    .replaceAll('API_BASE_URL_PLACEHOLDER', API_BASE_URL)
    .replaceAll('VERSION_PLACEHOLDER', version)
    .replaceAll('<!-- ENV_BADGE_PLACEHOLDER -->',
      isProd ? '' : `<div id="env-badge">${APP_ENV.toUpperCase()}</div>`);

  // Префикс во вкладке — чтобы дев-вкладку нельзя было принять за прод
  if (!isProd) html = html.replace('<title>', `<title>[${APP_ENV.toUpperCase()}] `);

  if (html.includes('_PLACEHOLDER')) {
    console.error('✗ В index.html остались неподставленные плейсхолдеры — прерываю.');
    process.exit(1);
  }

  const js = await readFile(path.join(root, 'script.js'), 'utf8');

  await put('index.html', html, 'text/html; charset=utf-8');
  await put('script.js', js, 'application/javascript; charset=utf-8');

  console.log('✓ Сайт обновлён.');
}

main().catch((err) => {
  console.error('✗ Ошибка заливки сайта:', err.message || err);
  process.exit(1);
});
