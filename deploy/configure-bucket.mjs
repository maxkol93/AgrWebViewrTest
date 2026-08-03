// Настраивает бакет как хостинг сайта: website-конфиг + CORS.
// Делается через S3 API (те же креды, что у деплоя) — надёжнее, чем флаги CLI.
//
// Конфигурация из окружения:
//   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT (опц.), S3_REGION (опц.)
//
// Запуск:  node deploy/configure-bucket.mjs

import {
  S3Client,
  PutBucketWebsiteCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';

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

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  forcePathStyle: false,
});

async function main() {
  console.log(`→ Настраиваю бакет "${S3_BUCKET}"…`);

  // Главная и страница ошибки — обе index.html: маршрутизация внутри приложения.
  await s3.send(new PutBucketWebsiteCommand({
    Bucket: S3_BUCKET,
    WebsiteConfiguration: {
      IndexDocument: { Suffix: 'index.html' },
      ErrorDocument: { Key: 'index.html' },
    },
  }));
  console.log('  ✓ хостинг сайта включён (index.html)');

  // Браузер тянет .glb и models.json напрямую из бакета, админка кладёт файлы по PUT.
  await s3.send(new PutBucketCorsCommand({
    Bucket: S3_BUCKET,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: ['*'],
        AllowedMethods: ['GET', 'PUT', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3000,
      }],
    },
  }));
  console.log('  ✓ CORS настроен');

  console.log(`✓ Готово. Сайт будет доступен: https://${S3_BUCKET}.website.yandexcloud.net`);
}

main().catch((err) => {
  console.error('✗ Ошибка настройки бакета:', err.message || err);
  process.exit(1);
});
