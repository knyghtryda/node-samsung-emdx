import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { ContentServer } from '../lib/index.mjs';
import Scheduler from './scheduler.mjs';
import Store from './store.mjs';

const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'emdx-bridge-')));

const fakeDevice = () => ({
  connect: async () => {},
  disconnect: async () => {},
  getBatteryState: async () => ({ level: 80 }),
});

function scheduler(store, { push = async () => {}, rotation = 0 } = {}) {
  const s = new Scheduler({
    store,
    createDevice: fakeDevice,
    contentServer: { push },
    frame: { version: 'test', rotation, awakeMinutes: 5, dims: () => [64, 36] },
  });
  s.poke = () => {};
  return s;
}

const png = (width, height) => sharp({
  create: { width, height, channels: 3, background: '#808080' },
}).png().toBuffer();

test('a config save that leaves the schedule alone keeps the next run', () => {
  const store = tmpStore();
  store.updateConfig({ auto_rotate: true, rotate_cron: ['0 * *'] });
  store.updateState({ lastPushAt: 1, nextRunAt: 12345 });
  const s = scheduler(store);

  s.configChanged(store.updateConfig({ device_name: 'Hall', auto_rotate: true, rotate_cron: ['0 * *'] }));
  assert.equal(store.state.nextRunAt, 12345);

  s.configChanged(store.updateConfig({ rotate_cron: ['30 * *'] }));
  assert.notEqual(store.state.nextRunAt, 12345, 'a new schedule takes effect');

  s.configChanged(store.updateConfig({ auto_rotate: false }));
  assert.equal(store.state.nextRunAt, null);
});

test('the frame password never reaches config.json', () => {
  const store = tmpStore();
  store.updateConfig({ device_name: 'Hall', http_password: 'x', http_password_current: 'y' });
  const saved = JSON.parse(fs.readFileSync(path.join(store.dataDir, 'config.json'), 'utf-8'));
  assert.equal(saved.device_name, 'Hall');
  assert.equal('http_password' in saved, false);
  assert.equal('http_password_current' in saved, false);
});

test('a manual push that arrives during a delivery is kept', async () => {
  const store = tmpStore();
  store.queuePendingImage(await png(64, 36));
  const second = await png(64, 36);
  let pushes = 0;
  const s = scheduler(store, {
    // The next manual push lands while the first is on its way
    push: async () => {
      if (pushes++ === 0) store.queuePendingImage(second);
    },
  });

  await s._deliver();
  const id = store.state.pendingImage;
  assert.ok(id, 'the second push is still pending');
  assert.deepEqual(fs.readFileSync(store.pendingImagePath(id)), second);

  await s._deliver();
  assert.equal(store.state.pendingImage, null);
  assert.equal(fs.existsSync(store.pendingImagePath(id)), false);
});

test('the mounting rotation applies on top of the panel size', async () => {
  const s = scheduler(tmpStore(), { rotation: 90 });
  const jpeg = await s._toDisplayJpeg(await png(128, 72));
  const { width, height, format } = await sharp(jpeg).metadata();
  assert.equal(format, 'jpeg');
  assert.deepEqual([width, height], [36, 64]);
});

test('a push timeout during the MDC commands is not an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = err => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const server = new ContentServer({ baseUrl: 'http://127.0.0.1:1' });
    const slowDevice = {
      connect: () => new Promise(resolve => setTimeout(resolve, 50)),
      setNetworkStandby: async () => {},
      setContentDownload: async () => {},
      disconnect: async () => {},
    };
    await assert.rejects(server.push(slowDevice, Buffer.alloc(1), { timeout: 10 }), /did not download/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
