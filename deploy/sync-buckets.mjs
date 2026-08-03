// Копирует ДАННЫЕ из прод-бакета в дев-бакет (модели, HDR, каталог).
// Нужен, чтобы на дев-стенде тестировать на реальных данных.
//
// Что важно понимать:
//   • копирование серверное (S3 CopyObject) — байты не проходят через машину,
//     30 МБ модель копируется мгновенно и не тратит трафик;
//   • сайт (index.html / script.js) НЕ копируется: он деплоится из репозитория,
//     иначе дев затёрся бы прод-версией с прод-URL внутри;
//   • по умолчанию скрипт НИЧЕГО не удаляет — только добавляет и обновляет;
//   • направление задаётся снаружи и проверяется (см. «Защита» ниже).
//
// Защита от копирования не туда:
//   1) SRC_BUCKET === DEST_BUCKET → отказ;
//   2) имя DEST_BUCKET должно выглядеть как не-прод (dev/test/stage) — иначе отказ,
//      снимается флагом --force (осознанное действие);
//   3) удаление лишнего в приёмнике — только по явному --prune;
//   4) --dry показывает план, ничего не меняя.
//
// Конфигурация из окружения:
//   SRC_BUCKET, DEST_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
//   S3_ENDPOINT (опц.), S3_REGION (опц.)
//
// Запуск:
//   $env:SRC_BUCKET="agr-viewer"; $env:DEST_BUCKET="agr-viewer-dev"
//   . .\deploy\config.local.ps1                 # креды S3
//   node deploy/sync-buckets.mjs --dry          # посмотреть план
//   node deploy/sync-buckets.mjs                # скопировать
//   node deploy/sync-buckets.mjs --prune        # ещё и удалить в деве лишнее

import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const prune = args.includes('--prune');
const force = args.includes('--force');

// Ключи сайта: деплоятся из репозитория, копировать их между стендами нельзя.
const SITE_KEYS = new Set(['index.html', 'script.js']);

// Лимит серверного копирования одним запросом в Object Storage.
const MAX_COPY_BYTES = 5 * 1024 * 1024 * 1024;

const {
  SRC_BUCKET,
  DEST_BUCKET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_ENDPOINT = 'https://storage.yandexcloud.net',
  S3_REGION = 'ru-central1',
} = process.env;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function required(name, value) {
  if (!value) fail(`Не задана переменная ${name}.`);
  return value;
}

required('SRC_BUCKET', SRC_BUCKET);
required('DEST_BUCKET', DEST_BUCKET);
required('S3_ACCESS_KEY_ID', S3_ACCESS_KEY_ID);
required('S3_SECRET_ACCESS_KEY', S3_SECRET_ACCESS_KEY);

// ── Защита направления ───────────────────────────────────────────────────────
if (SRC_BUCKET === DEST_BUCKET) {
  fail(`SRC_BUCKET и DEST_BUCKET совпадают ("${SRC_BUCKET}") — копировать нечего и некуда.`);
}
if (!/(dev|test|stage|staging|sandbox)/i.test(DEST_BUCKET) && !force) {
  fail(
    `Приёмник "${DEST_BUCKET}" не похож на тестовый бакет (нет dev/test/stage в имени).\n` +
    `   Если вы правда хотите писать именно в него — добавьте --force.`
  );
}

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  forcePathStyle: false,
});

/** Все объекты бакета: Map<key, { size, etag }>. */
async function listAll(bucket) {
  const out = new Map();
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: token,
    }));
    for (const o of res.Contents || []) {
      out.set(o.Key, { size: o.Size, etag: o.ETag });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** CopySource требует URL-кодирования ключа, но слэши остаются разделителями. */
function copySource(bucket, key) {
  return `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

async function main() {
  console.log(`→ Синхронизация ${SRC_BUCKET} → ${DEST_BUCKET}${dryRun ? '  [--dry, без записи]' : ''}`);

  const [src, dest] = await Promise.all([listAll(SRC_BUCKET), listAll(DEST_BUCKET)]);
  console.log(`  в источнике ${src.size} объект(ов), в приёмнике ${dest.size}`);

  const toCopy = [];
  let skipped = 0;
  let tooBig = 0;

  for (const [key, meta] of src) {
    if (SITE_KEYS.has(key)) continue;               // сайт — из репозитория
    const there = dest.get(key);
    // Совпали размер и ETag — объект уже такой же, копировать незачем.
    if (there && there.size === meta.size && there.etag === meta.etag) {
      skipped++;
      continue;
    }
    if (meta.size > MAX_COPY_BYTES) {
      console.warn(`  ! пропуск ${key} — ${mb(meta.size)}, больше лимита копирования`);
      tooBig++;
      continue;
    }
    toCopy.push([key, meta]);
  }

  const toDelete = [];
  if (prune) {
    for (const key of dest.keys()) {
      if (SITE_KEYS.has(key)) continue;             // сайт деву принадлежит свой
      if (!src.has(key)) toDelete.push(key);
    }
  }

  const totalBytes = toCopy.reduce((sum, [, m]) => sum + m.size, 0);
  console.log(
    `  к копированию ${toCopy.length} (${mb(totalBytes)}), ` +
    `уже совпадает ${skipped}` +
    (prune ? `, к удалению в приёмнике ${toDelete.length}` : '') +
    (tooBig ? `, пропущено по размеру ${tooBig}` : '')
  );

  if (dryRun) {
    for (const [key, meta] of toCopy) console.log(`  + ${key}  (${mb(meta.size)})`);
    for (const key of toDelete) console.log(`  - ${key}`);
    console.log('✓ Это был --dry: ничего не изменено.');
    return;
  }

  let done = 0;
  for (const [key, meta] of toCopy) {
    await s3.send(new CopyObjectCommand({
      Bucket: DEST_BUCKET,
      Key: key,
      CopySource: copySource(SRC_BUCKET, key),
      MetadataDirective: 'COPY',                    // сохранить Content-Type и заголовки
    }));
    done++;
    console.log(`  ✓ ${key}  (${mb(meta.size)})  [${done}/${toCopy.length}]`);
  }

  if (toDelete.length) {
    // DeleteObjects принимает максимум 1000 ключей за запрос.
    for (let i = 0; i < toDelete.length; i += 1000) {
      const chunk = toDelete.slice(i, i + 1000);
      await s3.send(new DeleteObjectsCommand({
        Bucket: DEST_BUCKET,
        Delete: { Objects: chunk.map((Key) => ({ Key })) },
      }));
      for (const key of chunk) console.log(`  - удалён ${key}`);
    }
  }

  console.log(`✓ Готово: скопировано ${done}, удалено ${toDelete.length}, без изменений ${skipped}.`);
}

main().catch((err) => {
  console.error('✗ Ошибка синхронизации:', err.message || err);
  process.exit(1);
});
