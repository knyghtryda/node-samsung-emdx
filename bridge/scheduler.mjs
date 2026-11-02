import fs from 'node:fs';
import sharp from 'sharp';

import { sleepDisplay, isOnline, wakeDisplay, POWER_OFF_GRACE_MS } from '../lib/index.mjs';
import { nextRun, quietHoursFromConfig } from './cron.mjs';
import { fetchFrameImage } from './imageServer.mjs';
import log from './log.mjs';

const TICK_MS = 30_000;
// The On Timer is minute-granular and the display takes a moment to boot
// and join Wi-Fi, so a wake shortly before the due time counts as on time
const DUE_TOLERANCE_MS = 90_000;
// After this many failed attempts at a due image, give up on it and try
// again later rather than keeping the display awake
const MAX_ATTEMPTS = 3;
const RETRY_LATER_MS = 15 * 60_000;
// Standby mode: how often to retry Wake-on-LAN for a display that won't answer
const WAKE_RETRY_MS = 2 * 60_000;

// Drives one EMDX display through the frame's rotation schedule:
//   asleep -> (RTC alarm or Wake-on-LAN) -> online -> fetch + push -> awake
//   window -> asleep again with the next alarm armed.
// The display is battery-powered and e-paper keeps the image with the power
// off, so it is only awake long enough to take an image.
export default class Scheduler {

  _busy = false;
  _timer = null;
  _awakeUntil = null; // ms; the display is awake and ours until then
  _sleptAt = null; // ms; when we last powered it off
  _lastWakeAttempt = 0;
  _attempts = 0;

  constructor({ store, createDevice, contentServer, frame }) {
    this.store = store;
    this.createDevice = createDevice;
    this.contentServer = contentServer;
    this.frame = frame; // { version, dims(), rotation, awakeMinutes }
  }

  start() {
    this._ensureNextRun();
    this._timer = setInterval(() => this.tick(), TICK_MS);
    setTimeout(() => this.tick(), 2_000);
  }

  // Something changed (config edit, manual push): act now, not in 30s
  poke() {
    setImmediate(() => this.tick());
  }

  configChanged() {
    const { auto_rotate } = this.store.config;
    if (!auto_rotate) {
      this.store.updateState({ nextRunAt: null });
    } else if (this.store.state.lastPushAt) {
      // A new schedule takes effect from now
      this.store.updateState({ nextRunAt: this._computeNextRun(Date.now()) });
    } else {
      // Nothing shown yet: show the first image right away
      this.store.updateState({ nextRunAt: Date.now() });
    }
    this.poke();
  }

  status() {
    const { state, config } = this.store;
    return {
      autoRotate: !!config.auto_rotate,
      schedule: config.rotate_cron,
      sleepMode: this._sleepMode(),
      awake: this._awakeUntil !== null,
      awakeUntil: this._awakeUntil && new Date(this._awakeUntil).toISOString(),
      nextRunAt: state.nextRunAt && new Date(state.nextRunAt).toISOString(),
      lastPushAt: state.lastPushAt && new Date(state.lastPushAt).toISOString(),
      pendingImage: state.pendingImage,
      battery: state.battery,
      batteryAt: state.batteryAt && new Date(state.batteryAt).toISOString(),
    };
  }

  // Deep sleep only comes back through the On Timer, so it needs a schedule
  // with a next run. Without one, standby keeps the display reachable by
  // Wake-on-LAN for manual pushes.
  _sleepMode() {
    const { config, state } = this.store;
    if (config.deep_sleep_enabled === false) return 'standby';
    if (!config.auto_rotate || state.nextRunAt === null) return 'standby';
    return 'deep';
  }

  _computeNextRun(from) {
    const { rotate_cron, rotate_interval } = this.store.config;
    // Old firmware configs carry a plain interval in seconds instead
    if (!Array.isArray(rotate_cron) && Number.isFinite(rotate_interval) && rotate_interval > 0) {
      return from + rotate_interval * 1000;
    }
    const next = nextRun(rotate_cron, { from: new Date(from), quiet: quietHoursFromConfig(this.store.config) });
    return next ? next.getTime() : null;
  }

  _ensureNextRun() {
    const { state, config } = this.store;
    if (!config.auto_rotate) {
      if (state.nextRunAt !== null) this.store.updateState({ nextRunAt: null });
      return;
    }
    if (state.nextRunAt === null) {
      // Never shown an image: show one right away rather than waiting for the
      // first scheduled slot, so a new setup gives immediate feedback
      this.store.updateState({ nextRunAt: state.lastPushAt ? this._computeNextRun(Date.now()) : Date.now() });
    }
  }

  _isDue(now) {
    const { nextRunAt } = this.store.state;
    return !!this.store.config.auto_rotate && nextRunAt !== null && now >= nextRunAt - DUE_TOLERANCE_MS;
  }

  async tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      await this._tick();
    } catch (err) {
      log.error(`Scheduler: ${err.message}`);
    } finally {
      this._busy = false;
    }
  }

  async _tick() {
    this._ensureNextRun();
    const now = Date.now();
    const due = this._isDue(now);
    const pending = this.store.state.pendingImage;
    const mode = this._sleepMode();

    // Awake window: the display is on and answering
    if (this._awakeUntil !== null) {
      if (pending || due) await this._deliver();
      else if (now >= this._awakeUntil) await this._sleep();
      return;
    }

    // The display just went off and is still answering MDC for a while
    if (this._sleptAt !== null && now - this._sleptAt < POWER_OFF_GRACE_MS) return;

    if (!due && !pending) {
      // Deep sleep's On Timer repeats daily, so schedules with gaps over 24h
      // (and alarms left over from an older schedule) wake the display early.
      // Nothing is due: put it straight back to sleep with the right alarm.
      if (mode === 'deep' && this.store.config.auto_rotate && await isOnline(this.createDevice())) {
        log.info('Display woke with nothing due; back to sleep');
        await this._sleep();
      }
      return;
    }

    let online;
    if (mode === 'standby' || (pending && !due)) {
      // Standby displays wake on LAN. A manual push to a deep-sleeping
      // display can't wake it, but it may have been woken by hand: try both.
      if (now - this._lastWakeAttempt < WAKE_RETRY_MS) return;
      this._lastWakeAttempt = now;
      online = mode === 'standby'
        ? await wakeDisplay(this.createDevice())
        : await isOnline(this.createDevice());
    } else {
      // Deep sleep: wait for the On Timer to bring it up
      online = await isOnline(this.createDevice());
    }
    if (!online) return;

    log.info(due ? 'Display online, image due' : 'Display online, delivering a manual push');
    this._awakeUntil = now + this._awakeWindowMs(now);
    await this._deliver();
  }

  // Stay awake for the configured window, but never past half the time to
  // the next image: the display must be asleep before the next alarm, or
  // the cycle drifts by a full day
  _awakeWindowMs(now) {
    let ms = this.frame.awakeMinutes * 60_000;
    const { nextRunAt } = this.store.state;
    if (this.store.config.auto_rotate && nextRunAt !== null) {
      const next = nextRunAt > now + DUE_TOLERANCE_MS ? nextRunAt : this._computeNextRun(now);
      if (next !== null) ms = Math.min(ms, Math.max(60_000, (next - now) / 2));
    }
    return ms;
  }

  async _deliver() {
    const now = Date.now();
    const due = this._isDue(now);
    const usePending = this.store.state.pendingImage && fs.existsSync(this.store.pendingImagePath);

    // Read the battery while the display is awake, before fetching: the
    // server records it from the image request (X-Battery-Percentage)
    const battery = await this._readBattery();
    if (battery !== null) this.store.updateState({ battery, batteryAt: now });

    let source;
    try {
      if (usePending) {
        source = fs.readFileSync(this.store.pendingImagePath);
      } else if (due) {
        source = await fetchFrameImage({ store: this.store, frame: this.frame, onConfig: () => this._configFromServer() });
      } else {
        // Pending flag without its file: nothing to show
        this.store.updateState({ pendingImage: false });
        return;
      }

      const image = await this._toDisplayJpeg(source);
      await this.contentServer.push(this.createDevice(), image);
      fs.writeFileSync(this.store.lastImagePath, image);
      log.info(`Pushed ${usePending ? 'manual' : 'scheduled'} image (${Math.round(image.length / 1024)} KB)`);

      const update = { lastPushAt: now };
      if (usePending) {
        update.pendingImage = false;
        fs.rmSync(this.store.pendingImagePath, { force: true });
      }
      // A manual push at the due time stands in for the scheduled one
      if (due) update.nextRunAt = this._computeNextRun(now);
      this.store.updateState(update);
      this._attempts = 0;
    } catch (err) {
      this._attempts++;
      log.error(`Delivery failed (attempt ${this._attempts}/${MAX_ATTEMPTS}): ${err.message}`);
      if (this._attempts >= MAX_ATTEMPTS) {
        this._attempts = 0;
        if (usePending) {
          log.error('Dropping the manual image');
          this.store.updateState({ pendingImage: false });
          fs.rmSync(this.store.pendingImagePath, { force: true });
        } else {
          this.store.updateState({ nextRunAt: now + RETRY_LATER_MS });
          log.info(`Next attempt at ${new Date(now + RETRY_LATER_MS).toLocaleString()}`);
        }
      }
    }
  }

  // The server already rendered the image at the panel's size in the
  // requested orientation; this only fixes up the size if it doesn't match,
  // applies the mounting rotation, and encodes JPEG (the display's most
  // reliable format). No tone or color changes: those happened server-side.
  async _toDisplayJpeg(buffer) {
    const [width, height] = this.frame.dims();
    let image;
    try {
      image = await sharp(buffer).rotate().resize(width, height, { fit: 'cover' }).toBuffer();
    } catch (err) {
      throw new Error(`Unreadable image (${err.message}) — is the server sending full-color PNG for display_type "rgb"?`);
    }
    let pipeline = sharp(image);
    if (this.frame.rotation) pipeline = pipeline.rotate(this.frame.rotation);
    return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  }

  async _readBattery() {
    const device = this.createDevice();
    try {
      await device.connect({ timeout: 5_000 });
      const { level } = await device.getBatteryState();
      return Number.isInteger(level) && level >= 0 && level <= 100 ? level : null;
    } catch {
      return null;
    } finally {
      await device.disconnect().catch(() => {});
    }
  }

  async _sleep() {
    const mode = this._sleepMode();
    const { nextRunAt } = this.store.state;
    const wakeAt = mode === 'deep' ? new Date(nextRunAt) : null;
    try {
      await sleepDisplay(this.createDevice(), { mode, wakeAt });
      log.info(`Display off (${mode})${wakeAt ? `, alarm ${wakeAt.toTimeString().slice(0, 5)} for ${wakeAt.toLocaleString()}` : ''}`);
    } catch (err) {
      log.error(`Could not power off the display: ${err.message}`);
    }
    this._awakeUntil = null;
    this._sleptAt = Date.now();
  }

  // The server delivered newer config with the image (X-Config-Payload)
  _configFromServer() {
    log.info('Applied config from the server');
    const { auto_rotate } = this.store.config;
    if (!auto_rotate) this.store.updateState({ nextRunAt: null });
  }

}
