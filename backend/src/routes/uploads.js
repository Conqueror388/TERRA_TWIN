import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requireAuth } from '../lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.join(__dirname, '../../uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

// Magic-byte signatures for image formats.
// Checking actual file bytes prevents a disguised upload
// (e.g. a .php file claiming to be image/jpeg via the Content-Type header).
function validateMagicBytes(buffer) {
  if (!buffer || buffer.length < 12) return false;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true;
  // WEBP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return true;
  // HEIC / HEIF: ftyp box at offset 4 with brand mif1, heic, heix, or mif1
  const ftyp = buffer.slice(4, 8).toString('ascii');
  if (['ftyp', 'mif1', 'heic', 'heix', 'hevc', 'avif'].some((b) => ftyp.includes(b))) return true;
  return false;
}

// Use memoryStorage so we can inspect bytes BEFORE writing to disk.
// Only write to disk after magic-byte validation passes.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB — phone photos from a job site
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WEBP, or HEIC images are accepted.'));
    }
    cb(null, true);
  },
});

const router = Router();

// POST /api/uploads/photo — authenticated workers attach a photo to a discovery
// report. requireAuth ensures only signed-in users can upload files. Magic-byte
// validation ensures the file content matches the claimed image type.
router.post('/photo', requireAuth, (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded.' });

    // Validate actual file content — not just the browser-supplied MIME header.
    if (!validateMagicBytes(req.file.buffer)) {
      return res.status(400).json({ error: 'File content does not match a recognised image format.' });
    }

    // Write the validated buffer to disk with a random name.
    const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const dest = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(dest, req.file.buffer);

    res.status(201).json({
      url: `/uploads/${filename}`,
      sizeBytes: req.file.size,
      mimeType: req.file.mimetype,
    });
  });
});

export default router;
