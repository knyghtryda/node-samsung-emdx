import fs from 'node:fs';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';

import log from './log.mjs';

// The ESP32 PhotoFrame HTTP API, as esp32-photoframe-server uses it
// (backend/pkg/photoframe/client.go). Add the bridge in the server as a
// frame at "<bridge-host>:<port>" and the server configures and pushes to
// it like any other frame.
//
// No HTTP password: run the bridge on a trusted network.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const isObject = body => !!body && typeof body === 'object' && !Array.isArray(body);

export default function frameApi({ store, scheduler, frame }) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.get('/api/system-info', (_req, res) => {
    const [width, height] = frame.dims();
    res.json({
      device_name: store.config.device_name,
      width,
      height,
      board_name: 'samsung_emdx',
      version: frame.version,
      // The panel quantizes and dithers on its own: the server must send
      // full-color tone-mapped images, not Spectra 6 dithered ones
      display_type: 'rgb',
    });
  });

  router.get('/api/config', (_req, res) => res.json(store.config));

  // POST carries the full config, PATCH a partial one; both merge
  const updateConfig = (req, res) => {
    if (!isObject(req.body)) return res.status(400).json({ message: 'Expected a JSON object' });
    scheduler.configChanged(store.updateConfig(req.body));
    log.info(`Config updated: ${Object.keys(req.body).join(', ')}`);
    res.json({ status: 'success' });
  };
  router.post('/api/config', updateConfig);
  router.patch('/api/config', updateConfig);

  router.get('/api/settings/processing', (_req, res) => res.json(store.processing));
  router.post('/api/settings/processing', (req, res) => {
    if (!isObject(req.body)) return res.status(400).json({ message: 'Expected a JSON object' });
    store.replaceProcessing(req.body);
    log.info('Processing settings updated');
    res.json({ status: 'success' });
  });

  // Only meaningful to panels the server dithers for; kept so the server's
  // config sync round-trips
  router.get('/api/settings/palette', (_req, res) => res.json(store.palette));
  router.post('/api/settings/palette', (req, res) => {
    if (!isObject(req.body)) return res.status(400).json({ message: 'Expected a JSON object' });
    store.replacePalette(req.body);
    res.json({ status: 'success' });
  });

  // "Push to frame" from the server's gallery. The display may be asleep, so
  // the image is queued and shown as soon as the display answers.
  router.post('/api/display-image', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Missing "image" file' });
    try {
      await sharp(req.file.buffer).metadata();
    } catch {
      return res.status(415).json({
        message: 'Not a PNG/JPEG image. The server must know this frame as display_type "rgb" so it sends full-color PNG.',
      });
    }
    store.queuePendingImage(req.file.buffer);
    log.info(`Manual push queued (${Math.round(req.file.size / 1024)} KB)`);
    scheduler.poke();
    res.json({ status: 'success' });
  });

  // Bridge-only: what the scheduler is doing, and the last image pushed
  router.get('/bridge/status', (_req, res) => res.json(scheduler.status()));
  router.get('/bridge/last-push.jpg', (_req, res) => {
    if (!fs.existsSync(store.lastImagePath)) return res.status(404).json({ message: 'Nothing pushed yet' });
    res.sendFile(store.lastImagePath);
  });

  return router;
}
