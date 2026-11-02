#!/usr/bin/env node

// Bridge between esp32-photoframe-server and a Samsung EMDX e-paper display.
// To the server it looks like an ESP32 PhotoFrame; behind that it drives the
// display over MDC, waking it on the frame's rotation schedule.

import fs from 'node:fs';
import express from 'express';
import getLocalIp from '@loxjs/node-local-ip';

import { Device, ContentServer } from '../lib/index.mjs';
import Store from './store.mjs';
import Scheduler from './scheduler.mjs';
import frameApi from './frameApi.mjs';
import log from './log.mjs';

const { version } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const host = env('EMDX_HOST');
const pin = env('EMDX_PIN');
if (!host || !pin) {
  console.error('EMDX_HOST and EMDX_PIN are required');
  process.exit(1);
}
const mac = env('EMDX_MAC');

const port = parseInt(env('BRIDGE_PORT', '8080'), 10);
// How the DISPLAY reaches the bridge to download images; in a container this
// must be the host's LAN address, not the container's
const advertiseUrl = env('ADVERTISE_URL', `http://${env('ADVERTISE_HOST', getLocalIp())}:${port}`);

// Native panel size in landscape; portrait swaps it, so the server renders
// the image upright and the display gets it as-is
const longSide = parseInt(env('EMDX_WIDTH', '2560'), 10);
const shortSide = parseInt(env('EMDX_HEIGHT', '1440'), 10);
// Extra rotation for how the display is mounted (0, 90, 180, 270)
const rotation = ((parseInt(env('EMDX_ROTATION', '0'), 10) % 360) + 360) % 360;

const store = new Store(env('DATA_DIR', './data'));

const frame = {
  version,
  rotation,
  // Minutes the display stays on after an image, capped at half the time
  // to the next one
  awakeMinutes: Math.max(1, parseFloat(env('AWAKE_MINUTES', '5'))),
  dims: () => (store.config.display_orientation === 'portrait'
    ? [Math.min(longSide, shortSide), Math.max(longSide, shortSide)]
    : [Math.max(longSide, shortSide), Math.min(longSide, shortSide)]),
};

const contentServer = new ContentServer({ baseUrl: advertiseUrl });
const scheduler = new Scheduler({
  store,
  contentServer,
  frame,
  createDevice: () => new Device({ host, pin, mac }),
});

const app = express();
app.use((req, res, next) => {
  if (!contentServer.handle(req, res)) next();
});
app.use(frameApi({ store, scheduler, frame }));

app.listen(port, () => {
  log.info(`EMDX bridge ${version} on :${port} → display ${host}`);
  log.info(`Display downloads from ${advertiseUrl}`);
  log.info(`Time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone} (schedule and display alarm use it)`);
  scheduler.start();
});
