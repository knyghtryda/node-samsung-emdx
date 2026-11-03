import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// What a frame keeps on its flash, kept in DATA_DIR as JSON: the config and
// processing settings esp32-photoframe-server pushes to "the frame", and the
// bridge's own schedule state.

// Defaults shaped like the firmware's, so the server's device dialog shows
// the cron schedule editor (rotate_cron as an array) and the URL source.
const CONFIG_DEFAULTS = {
  device_name: 'Samsung EMDX',
  auto_rotate: false,
  rotate_cron: ['0 */12 *'],
  rotation_mode: 'url',
  image_url: '',
  access_token: '',
  display_orientation: 'landscape',
  display_rotation_deg: 0,
  deep_sleep_enabled: true,
  sleep_schedule_enabled: false,
  sleep_schedule_start: 1380,
  sleep_schedule_end: 420,
  timezone: '',
};

// The server's frame-password flow; meaningless without a password gate
const IGNORED_CONFIG_KEYS = ['http_password', 'http_password_current'];

// Tone mapping only: dithering keys are kept for the server's sake but the
// server ignores them for display_type "rgb"
const PROCESSING_DEFAULTS = {
  exposure: 1.0,
  saturation: 1.0,
  toneMode: 'contrast',
  contrast: 1.0,
  strength: 0.5,
  shadowBoost: 0.0,
  highlightCompress: 1.5,
  midpoint: 0.5,
  colorMethod: 'rgb',
  processingMode: 'enhanced',
  ditherAlgorithm: 'floyd-steinberg',
  compressDynamicRange: false,
  scaleMode: 'cover',
  backgroundColor: 'white',
};

const STATE_DEFAULTS = {
  configLastUpdated: 0, // unix seconds, reported as X-Config-Last-Updated
  nextRunAt: null, // ms; next scheduled image
  lastPushAt: null, // ms
  battery: null, // last level read over MDC, 0-100
  batteryAt: null, // ms; when it was read
  pendingImage: null, // id of a manual push waiting for the display to wake
};

export default class Store {

  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    this.config = { ...CONFIG_DEFAULTS, ...this._read('config.json') };
    this.processing = { ...PROCESSING_DEFAULTS, ...this._read('processing.json') };
    this.palette = this._read('palette.json');
    this.state = { ...STATE_DEFAULTS, ...this._read('state.json') };
  }

  pendingImagePath(id) { return path.join(this.dataDir, `pending-${id}.png`); }
  get lastImagePath() { return path.join(this.dataDir, 'last-push.jpg'); }

  _read(name) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir, name), 'utf-8'));
    } catch {
      return {};
    }
  }

  _write(name, data) {
    // Write-then-rename so a crash mid-write can't leave truncated JSON
    const file = path.join(this.dataDir, name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  // Any change the server makes counts as a config edit, so the frame's
  // X-Config-Last-Updated moves forward and the server stops re-sending it
  _touch() {
    this.state.configLastUpdated = Math.max(this.state.configLastUpdated + 1, Math.floor(Date.now() / 1000));
    this._write('state.json', this.state);
  }

  // Merges fields from the server, however they arrive (config API or
  // X-Config-Payload). Returns the config from before, to compare against.
  updateConfig(fields) {
    const before = this.config;
    this.config = { ...this.config, ...fields };
    for (const key of IGNORED_CONFIG_KEYS) delete this.config[key];
    this._write('config.json', this.config);
    this._touch();
    return before;
  }

  replaceProcessing(settings) {
    // The server sends the complete object; overlay it on defaults like the firmware
    this.processing = { ...PROCESSING_DEFAULTS, ...settings };
    this._write('processing.json', this.processing);
    this._touch();
  }

  replacePalette(palette) {
    this.palette = palette;
    this._write('palette.json', this.palette);
    this._touch();
  }

  // A manual push replaces any earlier one still waiting. Each gets its own
  // file, so a delivery in progress can't clear one that arrived meanwhile.
  queuePendingImage(buffer) {
    const previous = this.state.pendingImage;
    const id = randomUUID();
    fs.writeFileSync(this.pendingImagePath(id), buffer);
    this.updateState({ pendingImage: id });
    if (previous) fs.rmSync(this.pendingImagePath(previous), { force: true });
  }

  // Manual push `id` is done with (shown, or given up on)
  clearPendingImage(id) {
    if (this.state.pendingImage === id) this.updateState({ pendingImage: null });
    fs.rmSync(this.pendingImagePath(id), { force: true });
  }

  updateState(fields) {
    this.state = { ...this.state, ...fields };
    this._write('state.json', this.state);
  }

}
