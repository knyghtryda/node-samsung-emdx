#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

import { Device, ContentServer, discover, sleepDisplay } from '../lib/index.mjs';
import express from 'express';
import getPort from 'get-port';
import getLocalIp from '@loxjs/node-local-ip';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const deviceOptions = yargs => yargs
  .option('host', {
    required: true,
    type: 'string',
    describe: 'Display IP address',
  })
  .option('pin', {
    required: true,
    type: 'string',
    describe: 'e.g. 000000',
  })
  .option('mac', {
    required: false,
    type: 'string',
    describe: 'MAC address (for Wake-on-LAN)',
  });

yargs(hideBin(process.argv))
  .command({
    command: 'show-image',
    describe: 'Show an image on Samsung EMDX display',
    builder: yargs => deviceOptions(yargs)
      .option('image', {
        type: 'string',
        describe: 'Path to the image file',
        required: true,
      })
      .option('local-ip', {
        required: false,
        type: 'string',
        describe: 'Local IP address to use for the server',
        default: getLocalIp(),
      })
      .option('sleep-after', {
        type: 'number',
        describe: 'Minutes of inactivity before powering off (0 = never)',
        default: 0,
      }),
    handler: async (argv) => {
      const { host, mac, pin, localIp, sleepAfter } = argv;
      const image = path.resolve(argv.image);

      if (!fs.existsSync(image)) {
        console.error(`❌ Image file not found: ${image}`);
        process.exit(1);
      }

      const port = await getPort({ port: 3000 });
      const fileSize = await fs.promises.stat(image).then(stats => stats.size);
      const extension = path.extname(image).slice(1).toLowerCase();
      const contentType = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' }[extension] || 'application/octet-stream';

      console.log(`Image: ${image} (${fileSize} bytes)`);
      console.log(`Display: ${host}`);
      if (sleepAfter > 0) console.log(`Sleep after: ${sleepAfter} minutes`);
      console.log('');

      console.log('🔄 Starting HTTP server...');
      const contentServer = new ContentServer({ baseUrl: `http://${localIp}:${port}` });
      await new Promise((resolve, reject) => {
        const srv = express()
          .use((req, res, next) => {
            if (!contentServer.handle(req, res)) next();
          })
          .listen(port, resolve);
        srv.on('error', reject);
      });
      console.log(`✅ HTTP server listening at http://${localIp}:${port}`);
      console.log('');

      try {
        const device = new Device({ host, mac, pin });

        if (mac) {
          console.log('🔄 Waking up device...');
          await device.wakeup();
          await new Promise(resolve => setTimeout(resolve, 1000));
          console.log('✅ Device woken up');
          console.log('');
        }

        console.log('🔄 Sending image...');
        await contentServer.push(device, await fs.promises.readFile(image), {
          timeout: 120_000, extension, contentType,
        });
        console.log('✅ Image downloaded by the display');
        console.log('');
      } catch (err) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
      }

      if (sleepAfter > 0) {
        console.log(`⏰ Display will sleep in ${sleepAfter} minutes...`);
        await new Promise(resolve => setTimeout(resolve, sleepAfter * 60_000));
        console.log('');
        console.log('💤 Sleep timer fired — powering off display...');
        try {
          // Network standby off: true deep sleep
          await sleepDisplay(new Device({ host, mac, pin }), { mode: 'deep' });
          console.log('✅ Display powered off — use WoL to wake');
        } catch (err) {
          console.error(`❌ Failed to power off: ${err.message}`);
        }
      }
      process.exit(0);
    },
  })
  .command({
    command: 'discover',
    describe: 'Search the local network for Samsung EMDX displays',
    builder: yargs => yargs
      .option('timeout', {
        type: 'number',
        describe: 'Search duration in seconds',
        default: 4,
      }),
    handler: async (argv) => {
      console.log('🔍 Searching for EMDX displays...');
      const displays = await discover({
        timeout: argv.timeout * 1000,
        onProgress: msg => console.log(`   ${msg}`),
      });

      if (displays.length === 0) {
        console.log('❌ No displays found — sleeping displays do not respond, wake them first');
        return;
      }

      console.log('');
      console.log(`✅ Found ${displays.length} display${displays.length !== 1 ? 's' : ''}:`);
      for (const d of displays) {
        console.log('');
        console.log(`  ${d.name} (${d.model})`);
        console.log(`    Host:   ${d.host}`);
        console.log(`    MAC:    ${d.mac || 'unknown'}`);
        console.log(`    Serial: ${d.serial || 'unknown'}`);
      }
    },
  })
  .command({
    command: 'wake',
    describe: 'Wake the display via Wake-on-LAN',
    builder: yargs => yargs
      .option('mac', {
        required: true,
        type: 'string',
        describe: 'MAC address',
      }),
    handler: async (argv) => {
      const device = new Device({ mac: argv.mac });
      console.log(`🔄 Sending Wake-on-LAN to ${argv.mac}...`);
      await device.wakeup();
      console.log('✅ Magic packet sent');
    },
  })
  .command({
    command: 'sleep',
    describe: 'Power off the display',
    builder: deviceOptions,
    handler: async (argv) => {
      const device = new Device({ host: argv.host, pin: argv.pin, mac: argv.mac });
      console.log(`💤 Powering off ${argv.host} (network standby off)...`);
      await sleepDisplay(device, { mode: 'deep' });
      console.log('✅ Display powered off — use WoL to wake');
    },
  })
  .command({
    command: 'status',
    describe: 'Get display status (power, battery, info)',
    builder: deviceOptions,
    handler: async (argv) => {
      const device = new Device({ host: argv.host, pin: argv.pin, mac: argv.mac });
      console.log(`🔄 Connecting to ${argv.host}...`);
      await device.connect();

      const power = await device.getPowerState().catch(() => 'Unknown');
      console.log(`Power:    ${power}`);

      try {
        const battery = await device.getBatteryState();
        console.log(`Battery:  ${battery.level}%${battery.charging ? ' (charging)' : ''}${battery.healthy ? '' : ' (unhealthy)'}`);
      } catch {
        console.log('Battery:  N/A');
      }

      try {
        const name = await device.getDeviceName();
        console.log(`Name:     ${name}`);
      } catch { /* skip */ }

      try {
        const serial = await device.getSerialNumber();
        console.log(`Serial:   ${serial}`);
      } catch { /* skip */ }

      try {
        const version = await device.getSoftwareVersion();
        console.log(`Software: ${version}`);
      } catch { /* skip */ }

      await device.disconnect();
    },
  })
  .demandCommand()
  .parse();
