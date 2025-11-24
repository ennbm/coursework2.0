// server.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// ====== Базові налаштування ======
app.use(cors());
app.use(express.json());

// Папки для збереження картинок
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const ORIGINAL_DIR = path.join(UPLOADS_DIR, 'original');
const COMPRESSED_DIR = path.join(UPLOADS_DIR, 'compressed');

// Переконуємось, що папки існують
[UPLOADS_DIR, ORIGINAL_DIR, COMPRESSED_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Роздача статичних файлів
app.use('/uploads', express.static(UPLOADS_DIR));

// Папка з фронтендом
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// ====== Multer (завантаження файлів у памʼять) ======
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ====== Допоміжні функції ======

// Обчислення PSNR між двома буферами raw RGBA однакового розміру
function computePSNR(buf1, buf2) {
  if (buf1.length !== buf2.length) {
    return null;
  }

  let mse = 0;
  // крок 4, бо RGBA (4 канали)
  for (let i = 0; i < buf1.length; i += 4) {
    const rDiff = buf1[i]     - buf2[i];
    const gDiff = buf1[i + 1] - buf2[i + 1];
    const bDiff = buf1[i + 2] - buf2[i + 2];
    // альфа (i + 3) ігноруємо

    mse += rDiff * rDiff + gDiff * gDiff + bDiff * bDiff;
  }

  const pixels = buf1.length / 4;
  mse /= (pixels * 3);

  if (mse === 0) return Infinity;

  const MAX_I = 255;
  const psnr = 10 * Math.log10((MAX_I * MAX_I) / mse);
  return psnr;
}

// Перетворення якості 0..1 у 0..100
function qualityToPercent(q) {
  if (q <= 1) return Math.round(q * 100);
  return Math.round(q);
}

// ====== Маршрут: compress ======
//
// POST /api/compress
// image: файл зображення (будь-який формат, який підтримує sharp)
// config (опційно): JSON-рядок з масивом варіантів
//
app.post('/api/compress', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл зображення не надіслано (field name: image)' });
    }

    const fileBuffer = req.file.buffer;
    const originalName = req.file.originalname || 'image';
    const baseName = Date.now() + '-' + Math.round(Math.random() * 1e9);

    // Зчитуємо оригінал через sharp (будь-який формат)
    const originalSharp = sharp(fileBuffer);
    const metadata = await originalSharp.metadata();

    // Зберігаємо оригінал у PNG як "еталон" (стабільно і без втрат)
    const originalFileName = baseName + '-original.png';
    const originalFilePath = path.join(ORIGINAL_DIR, originalFileName);

    await originalSharp.png().toFile(originalFilePath);

    const originalStats = fs.statSync(originalFilePath);
    const originalSize = originalStats.size;

    // Буфер оригіналу в raw RGBA для PSNR
    const { data: originalRaw, info: originalInfo } = await originalSharp
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    // Конфіг методів стиснення
    let variantsConfig = null;
    if (req.body.config) {
      try {
        variantsConfig = JSON.parse(req.body.config);
      } catch (e) {
        console.warn('Не вдалось розпарсити config, використовуємо дефолтний.');
      }
    }

    // Якщо нічого не передали – дефолтний набір:
    // Lossey: JPEG, WebP, AVIF
    // Lossless: PNG
    if (!Array.isArray(variantsConfig) || variantsConfig.length === 0) {
      variantsConfig = [
        { format: 'jpeg', quality: 0.2, label: 'JPEG (якість 0.2)', lossType: 'lossy' },
        { format: 'jpeg', quality: 0.5, label: 'JPEG (якість 0.5)', lossType: 'lossy' },
        { format: 'jpeg', quality: 0.8, label: 'JPEG (якість 0.8)', lossType: 'lossy' },

        { format: 'webp', quality: 0.5, label: 'WebP (якість 0.5)', lossType: 'lossy' },
        { format: 'webp', quality: 0.8, label: 'WebP (якість 0.8)', lossType: 'lossy' },

        { format: 'avif', quality: 0.5, label: 'AVIF (якість 0.5)', lossType: 'lossy' },
        { format: 'avif', quality: 0.8, label: 'AVIF (якість 0.8)', lossType: 'lossy' },

        { format: 'png',  quality: 1.0, label: 'PNG (без втрат)', lossType: 'lossless' }
      ];
    }

    const results = [];

    // Проходимо по всіх варіантах стискання
    for (const cfg of variantsConfig) {
      const format = (cfg.format || 'jpeg').toLowerCase();
      const label = cfg.label || `${format.toUpperCase()} (quality=${cfg.quality || 0.8})`;
      const q = cfg.quality != null ? cfg.quality : 0.8;
      const qualityPercent = qualityToPercent(q);
      const lossType = cfg.lossType || inferLossType(format);

      const outFileName = `${baseName}-${format}-${qualityPercent}.` +
        (format === 'jpeg' ? 'jpg' : format);

      const outFilePath = path.join(COMPRESSED_DIR, outFileName);

      let pipeline = sharp(fileBuffer);

      if (format === 'jpeg') {
        pipeline = pipeline.jpeg({ quality: qualityPercent });
      } else if (format === 'png') {
        pipeline = pipeline.png(); // PNG — без втрат
      } else if (format === 'webp') {
        pipeline = pipeline.webp({ quality: qualityPercent });
      } else if (format === 'avif') {
        pipeline = pipeline.avif({ quality: qualityPercent });
      } else {
        // невідомий формат – пропускаємо
        continue;
      }

      await pipeline.toFile(outFilePath);

      const stat = fs.statSync(outFilePath);
      const size = stat.size;
      const compressionRatio = originalSize / size;

      const { data: compressedRaw } = await sharp(outFilePath)
        .raw()
        .ensureAlpha()
        .toBuffer({ resolveWithObject: true });

      let psnr = null;
      if (
        compressedRaw.length === originalRaw.length &&
        originalInfo.width === metadata.width &&
        originalInfo.height === metadata.height
      ) {
        psnr = computePSNR(originalRaw, compressedRaw);
      }

      results.push({
        label,
        format,
        quality: qualityPercent,
        fileName: outFileName,
        url: `/uploads/compressed/${outFileName}`,
        size,
        compressionRatio,
        psnr,
        lossType // 'lossy' або 'lossless'
      });
    }

    res.json({
      original: {
        fileName: originalFileName,
        url: `/uploads/original/${originalFileName}`,
        size: originalSize,
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        name: originalName
      },
      variants: results
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  }
});

// Визначення типу стиснення за форматом (як запасний варіант)
function inferLossType(format) {
  const f = format.toLowerCase();
  if (f === 'png') return 'lossless';
  // кодуємо WebP/AVIF/JPEG як lossy за замовчуванням
  return 'lossy';
}

// Простіший ping для перевірки
app.get('/ping', (req, res) => {
  res.send('Image Compressor Lab backend працює 🚀');
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
