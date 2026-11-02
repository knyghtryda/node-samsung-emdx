import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCron, nextRun, quietHoursFromConfig } from './cron.mjs';

// Local-time dates, matching how the schedule is evaluated
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);

test('parses the firmware cron syntax', () => {
  assert.ok(parseCron('0 */12 *'));
  assert.ok(parseCron('30 8-20/2 1-5'));
  assert.ok(parseCron('0,30 7 0,6'));
  assert.equal(parseCron('0 */12'), null, 'needs exactly 3 fields');
  assert.equal(parseCron('*-5 * *'), null, 'no range after *');
  assert.equal(parseCron('60 * *'), null, 'minute out of range');
  assert.deepEqual([...parseCron('0 0 5-7').dow].sort(), [0, 5, 6], '7 is Sunday');
});

test('nextRun finds the next matching minute', () => {
  // Monday 2026-11-02 10:15
  const from = at(2026, 11, 2, 10, 15);
  assert.deepEqual(nextRun(['0 */12 *'], { from }), at(2026, 11, 2, 12, 0));
  assert.deepEqual(nextRun(['*/30 * *'], { from }), at(2026, 11, 2, 10, 30));
  // Strictly after `from`
  assert.deepEqual(nextRun(['15 10 *'], { from }), at(2026, 11, 3, 10, 15));
  // Weekends only: next Saturday
  assert.deepEqual(nextRun(['0 9 0,6'], { from }), at(2026, 11, 7, 9, 0));
  // Several expressions: the earliest wins
  assert.deepEqual(nextRun(['0 18 *', '0 11 *'], { from }), at(2026, 11, 2, 11, 0));
});

test('nextRun skips quiet hours, including across midnight', () => {
  const from = at(2026, 11, 2, 22, 10);
  const quiet = { start: 23 * 60, end: 7 * 60 };
  // 23:00 falls in the quiet window; 07:00 is its (exclusive) end
  assert.deepEqual(nextRun(['0 * *'], { from, quiet }), at(2026, 11, 3, 7, 0));
});

test('nextRun returns null for invalid or never-matching schedules', () => {
  assert.equal(nextRun(['nope'], { from: at(2026, 11, 2, 0, 0) }), null);
  assert.equal(nextRun([], { from: at(2026, 11, 2, 0, 0) }), null);
});

test('quiet hours come from the frame config only when enabled', () => {
  assert.equal(quietHoursFromConfig({ sleep_schedule_enabled: false }), null);
  assert.deepEqual(
    quietHoursFromConfig({ sleep_schedule_enabled: true, sleep_schedule_start: 1320, sleep_schedule_end: 360 }),
    { start: 1320, end: 360 },
  );
});
