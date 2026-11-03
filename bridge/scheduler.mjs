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
// The next image is never scheduled sooner than this after a push; longer
// than DUE_TOLERANCE_MS, so it isn't due the moment it's scheduled
const MIN_PUSH_GAP_MS = 2 * 60_000;
// After this many failed attempts at a due image, give up on it and try
// again later rather than keeping the display awake
const MAX_ATTEMPTS = 3;
const RETRY_LATER_MS = 15 * 60_000;
// Standby mode: how often to retry Wake-on-LAN for a display that won't answer
const WAKE_RETRY_MS = 2 * 60_000;
// Config that decides when images are due. The server re-sends the whole
// config on any edit; only a change to these moves the next run, so saving a
// device name can't skip a due image or cancel a retry.
const SCHEDULE_KEYS = ['auto_rotate', 'rotate_cron', 'sleep_schedule_enabled', 'sleep_schedule_start', 'sleep_schedule_end'];

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

  // `before` is the config from before the change (Store.updateConfig)
  configChanged(before) {
    const { config } = this.store;
    const scheduleChanged = SCHEDULE_KEYS.some(key => JSON.stringify(before[key]) !== JSON.stringify(config[key]));
    if (scheduleChanged) {
      if (!config.auto_rotate) {
        this.store.updateState({ nextRunAt: null });
      } else if (this.store.state.lastPushAt) {
        // A new schedule takes effect from now
        this.store.updateState({ nextRunAt: this._computeNextRun(Date.now()) });
      } else {
        // Nothing shown yet: show the first image right away
        this.store.updateState({ nextRunAt: Date.now() });
      }
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
      pendingImage: !!state.pendingImage,
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

  // The bridge reports a cron schedule (rotate_cron) like current firmware,
  // so the server always sends one; the rotate_interval it adds for old
  // firmware is ignored
  _computeNextRun(from) {
    const next = nextRun(this.store.config.rotate_cron, { from: new Date(from), quiet: quietHoursFromConfig(this.store.config) });
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
    // The slot this delivery serves, read before config from the server can
    // move it
    const slot = this.store.state.nextRunAt;
    const pendingId = this.store.state.pendingImage;
    let pendingSource = null;
    if (pendingId) {
      try {
        pendingSource = fs.readFileSync(this.store.pendingImagePath(pendingId));
      } catch {
        // Pending flag without its file: nothing to show
        this.store.clearPendingImage(pendingId);
      }
    }
    if (!pendingSource && !due) return;

    // One MDC session for the battery read and the push
    const device = this.createDevice();
    try {
      // Read the battery while the display is awake, before fetching: the
      // server records it from the image request (X-Battery-Percentage).
      // Once per image, not again on each retry.
      if (this._attempts === 0) {
        const battery = await this._readBattery(device);
        if (battery !== null) this.store.updateState({ battery, batteryAt: now });
      }

      let source = pendingSource;
      if (!source) {
        // The server can take minutes (AI sources): don't hold the
        // display's session open across that
        await device.disconnect().catch(() => {});
        source = await fetchFrameImage({ store: this.store, frame: this.frame, onConfig: before => this._configFromServer(before) });
      }

      const image = await this._toDisplayJpeg(source);
      await this.contentServer.push(device, image);
      fs.writeFileSync(this.store.lastImagePath, image);
      log.info(`Pushed ${pendingSource ? 'manual' : 'scheduled'} image (${Math.round(image.length / 1024)} KB)`);

      if (pendingSource) this.store.clearPendingImage(pendingId);
      const update = { lastPushAt: now };
      // A manual push at the due time stands in for the scheduled one. The
      // next run comes after the slot just served (the display can wake a
      // little early) and not right after this push (a late catch-up can
      // land just before the next slot), or one wake shows two images
      if (due) {
        const served = Math.max(now, slot ?? now);
        update.nextRunAt = this._computeNextRun(served + MIN_PUSH_GAP_MS);
      }
      this.store.updateState(update);
      this._attempts = 0;
    } catch (err) {
      this._attempts++;
      log.error(`Delivery failed (attempt ${this._attempts}/${MAX_ATTEMPTS}): ${err.message}`);
      if (this._attempts >= MAX_ATTEMPTS) {
        this._attempts = 0;
        if (pendingSource) {
          log.error('Dropping the manual image');
          this.store.clearPendingImage(pendingId);
        } else {
          this.store.updateState({ nextRunAt: now + RETRY_LATER_MS });
          log.info(`Next attempt at ${new Date(now + RETRY_LATER_MS).toLocaleString()}`);
        }
      }
    } finally {
      await device.disconnect().catch(() => {});
    }
  }

  // The server already rendered the image at the panel's size in the
  // requested orientation; this only fixes up the size if it doesn't match,
  // applies the mounting rotation, and encodes JPEG (the display's most
  // reliable format). No tone or color changes: those happened server-side.
  async _toDisplayJpeg(buffer) {
    const [width, height] = this.frame.dims();
    let decoded;
    try {
      // EXIF orientation and the mounting rotation are two rotate() calls,
      // and sharp takes one per pipeline: hand raw pixels to the second
      decoded = await sharp(buffer).rotate().resize(width, height, { fit: 'cover' })
        .raw().toBuffer({ resolveWithObject: true });
    } catch (err) {
      throw new Error(`Unreadable image (${err.message}) — is the server sending full-color PNG for display_type "rgb"?`);
    }
    let pipeline = sharp(decoded.data, { raw: decoded.info });
    if (this.frame.rotation) pipeline = pipeline.rotate(this.frame.rotation);
    return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  }

  // Leaves the session open for the push; _deliver disconnects
  async _readBattery(device) {
    try {
      await device.connect({ timeout: 5_000 });
      const { level } = await device.getBatteryState();
      return Number.isInteger(level) && level >= 0 && level <= 100 ? level : null;
    } catch {
      return null;
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
  _configFromServer(before) {
    log.info('Applied config from the server');
    this.configChanged(before);
  }

}
