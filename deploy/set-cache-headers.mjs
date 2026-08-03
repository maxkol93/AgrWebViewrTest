// Разовая утилита: проставляет Cache-Control уже залитым моделям и HDR-картам.
//
// Новые модели получают заголовок сами (backend/index.js подписывает его в
// presigned PUT), но всё, что залито раньше, лежит вообще без Cache-Control —
// браузер уходит в эвристику по Last-Modified и перекачивает 30 МБ заново.
// Ключи уникальны и содержимое по ключу не меняется, поэтому immutable безопасен.
//
// Конфигурация из окружения (те же переменные, что у деплоя):
//   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT (опц.), S3_REGION (опц.)
//
// Запуск:
//   node deploy/set-cache-headers.mjs           — только показать, что будет сделано
//   node deploy/set-cache-headers.mjs --apply   — применить
//
// Через deploy\config.dev.ps1:
//   . .\deploy\config.dev.ps1; node deploy/set-cache-headers.mjs --apply

import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const PREFIXES = ['models/', 'environments/'];

const {
  S3_BUCKET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_ENDPOINT = 'https://storage.yandexcloud.net',
  S3_REGION = 'ru-central1',
} = process.env;

for (const [name, value] of Object.entries({ S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY })) {
  if (!value) {
    console.error(`✗ Не задана переменная ${name}.`);
    process.exit(1);
  }
}

const apply = process.argv.includes('--apply');

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  forcePathStyle: false,
});

async function* listKeys(prefix) {
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    for (const obj of page.Contents || []) yield obj;
    token = page.NextContinuationToken;
  } while (token);
}

async function main() {
  console.log(`→ Бакет "${S3_BUCKET}"${apply ? '' : ' (пробный прогон, ничего не меняю)'}`);

  let touched = 0;
  let skipped = 0;

  for (const prefix of PREFIXES) {
    for await (const obj of listKeys(prefix)) {
      const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
      if (head.CacheControl === CACHE_CONTROL) { skipped++; continue; }

      const mb = (obj.Size / 1024 / 1024).toFixed(1);
      console.log(`  ${apply ? '✓' : '·'} ${obj.Key} (${mb} МБ, было: ${head.CacheControl || '—'})`);

      if (apply) {
        // Копия на себя с MetadataDirective: REPLACE — единственный способ
        // поменять заголовки, не перезаливая объект. Content-Type придётся
        // указать заново: REPLACE сбрасывает все прежние метаданные.
        await s3.send(new CopyObjectCommand({
          Bucket: S3_BUCKET,
          Key: obj.Key,
          CopySource: `/${S3_BUCKET}/${encodeURIComponent(obj.Key).replaceAll('%2F', '/')}`,
          MetadataDirective: 'REPLACE',
          ContentType: head.ContentType || 'application/octet-stream',
          CacheControl: CACHE_CONTROL,
        }));
      }
      touched++;
    }
  }

  console.log(`\n${apply ? '✓ Обновлено' : 'Будет обновлено'}: ${touched}, уже с заголовком: ${skipped}`);
  if (!apply && touched) console.log('  Повторите с --apply, чтобы применить.');
}

main().catch((err) => {
  console.error('✗ Ошибка:', err.message || err);
  process.exit(1);
});
