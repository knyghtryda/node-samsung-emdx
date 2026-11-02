// Power helpers for battery-powered EMDX displays. E-paper keeps its image
// with the power off, so between images the display should be off.
//
// Two ways back:
//  - deep sleep: network standby off (lowest drain). Only the display's own
//    RTC On Timer can wake it; Wake-on-LAN does not reach it.
//  - standby: network standby on. Wake-on-LAN wakes it at any time.

// The display stays MDC-reachable for a couple of minutes after a power-off,
// so a probe right after sleeping "finds" the display it just slept.
export const POWER_OFF_GRACE_MS = 150_000;

// Turn the display off. With wakeAt (a Date), deep sleep arms the On Timer
// at wakeAt's local hh:mm, repeating DAILY as a self-healing fallback: if
// the rendezvous is missed (controller asleep, restarting, MDC busy) the
// display retries at the same time tomorrow instead of sleeping forever.
// The display's clock must be in the same time zone as this process.
export async function sleepDisplay(device, { mode = 'deep', wakeAt = null } = {}) {
  try {
    await device.connect();
    if (mode === 'deep') {
      if (wakeAt) {
        await device.setOnTimer({
          enabled: true, repeat: 0x02, hour: wakeAt.getHours(), minute: wakeAt.getMinutes(),
        }).catch(() => {});
      }
      await device.setNetworkStandby({ enabled: false }).catch(() => {});
    } else {
      await device.setNetworkStandby({ enabled: true }).catch(() => {});
    }
    await device.setPower({ power: false }).catch((err) => {
      // Powering off can drop the session before the ACK arrives
      if (err.message !== 'Connection closed') throw err;
    });
  } finally {
    await device.disconnect().catch(() => {});
  }
}

// Whether the display answers MDC right now (connect + PIN auth).
export async function isOnline(device, { timeout = 3_000 } = {}) {
  try {
    await device.connect({ timeout });
    return true;
  } catch {
    return false;
  } finally {
    await device.disconnect().catch(() => {});
  }
}

// Send Wake-on-LAN and wait for the display to answer MDC.
export async function wakeDisplay(device, { timeout = 60_000, interval = 5_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (device.mac) await device.wakeup().catch(() => {});
    if (await isOnline(device)) return true;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return false;
}
