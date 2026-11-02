// The ESP32 PhotoFrame rotation schedule: a list of simplified 3-field cron
// expressions "minute hour day-of-week" (with *, a, a-b, */n, a-b/n and comma
// lists; day-of-week 0/7 = Sunday), plus optional quiet hours. Mirrors the
// firmware engine and esp32-photoframe-server's webapp/src/utils/cron.ts.
// Evaluated in this process's local time zone (TZ).

const FIELD_RANGES = [[0, 59], [0, 23], [0, 7]];

function parseField(field, lo, hi, isDow) {
  if (field === '' || field.length > 31) return null;
  const out = new Set();
  for (const term of field.split(',')) {
    // A range may only follow a number, never '*'
    const m = term.match(/^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return null;
    let start;
    let end;
    let step = 1;
    if (m[1] === undefined) {
      start = lo;
      end = hi;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] !== undefined ? parseInt(m[2], 10) : start;
      if (m[2] === undefined && m[3] !== undefined) end = hi;
    }
    if (m[3] !== undefined) {
      step = parseInt(m[3], 10);
      if (step <= 0) return null;
    }
    if (start < lo || end > hi || start > end) return null;
    for (let v = start; v <= end; v += step) out.add(v);
  }
  if (isDow && out.has(7)) {
    out.delete(7);
    out.add(0);
  }
  return out;
}

export function parseCron(expr) {
  if (typeof expr !== 'string' || expr.length >= 64) return null;
  const fields = expr.trim().split(/[ \t]+/);
  if (fields.length !== 3) return null;
  const sets = [];
  for (let i = 0; i < 3; i++) {
    const s = parseField(fields[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1], i === 2);
    if (!s) return null;
    sets.push(s);
  }
  return { minute: sets[0], hour: sets[1], dow: sets[2] };
}

function matches(rule, d) {
  return rule.minute.has(d.getMinutes()) && rule.hour.has(d.getHours()) && rule.dow.has(d.getDay());
}

// quiet: { start, end } in minutes since midnight; may wrap past midnight
function inQuietHours(d, quiet) {
  if (!quiet) return false;
  const cur = d.getHours() * 60 + d.getMinutes();
  if (quiet.start > quiet.end) return cur >= quiet.start || cur < quiet.end;
  return cur >= quiet.start && cur < quiet.end;
}

const HORIZON_MIN = 8 * 24 * 60;

// The first scheduled minute strictly after `from`, or null when the
// expressions are invalid or match nothing in the next 8 days.
export function nextRun(exprs, { from = new Date(), quiet = null } = {}) {
  const rules = (Array.isArray(exprs) ? exprs : [exprs]).map(parseCron).filter(Boolean);
  if (!rules.length) return null;
  const startMs = Math.ceil((from.getTime() + 1) / 60_000) * 60_000;
  for (let i = 0; i < HORIZON_MIN; i++) {
    const d = new Date(startMs + i * 60_000);
    if (!rules.some(r => matches(r, d))) continue;
    if (inQuietHours(d, quiet)) continue;
    return d;
  }
  return null;
}

// Quiet hours from a frame config, as the firmware stores them
export function quietHoursFromConfig(config) {
  if (!config.sleep_schedule_enabled) return null;
  return {
    start: Number.isFinite(config.sleep_schedule_start) ? config.sleep_schedule_start : 1380,
    end: Number.isFinite(config.sleep_schedule_end) ? config.sleep_schedule_end : 420,
  };
}
