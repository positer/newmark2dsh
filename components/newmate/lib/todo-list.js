// Persisted reminders. ISO timestamps must explicitly identify their time zone.
//
// A reminder may now REPEAT: every N minutes/hours/days, optionally restricted to weekdays and to a
// clock time. The rule is normalised once, at creation, into {every, unit, weekdays, minuteOfDay}
// so delivery only ever computes "the next activation" from plain numbers - a string rule is parsed
// here and never re-parsed at delivery time.
const UNITS = { m: 'min', min: 'min', mins: 'min', minute: 'min', minutes: 'min', 分: 'min', 分钟: 'min', h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h', 时: 'h', 小时: 'h', d: 'd', day: 'd', days: 'd', 天: 'd', 日: 'd' };
const DAY_NAMES = { mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7 };
const STEP = { min: 60000, h: 3600000, d: 86400000 };
const DAY = 86400000;

function parseDays(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  const days = new Set();
  for (const token of raw.split(/[,，\s]+/).filter(Boolean)) {
    const range = /^(\d|mon|tue|wed|thu|fri|sat|sun)\s*[-~到至]\s*(\d|mon|tue|wed|thu|fri|sat|sun)$/i.exec(token);
    if (range) {
      const from = DAY_NAMES[range[1].toLowerCase()], to = DAY_NAMES[range[2].toLowerCase()];
      if (!from || !to) throw Error('重复规则的星期无效');
      for (let day = from; ; day = day === 7 ? 1 : day + 1) { days.add(day); if (day === to) break; }
      continue;
    }
    const day = DAY_NAMES[token.toLowerCase()];
    if (!day) throw Error('重复规则的星期无效：' + token);
    days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) throw Error('重复规则的时间须为 HH:MM');
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw Error('重复规则的时间无效');
  return hour * 60 + minute;
}

/** "every 2 h", "every 1 d on 1-5 at 09:00", "weekdays mon,wed,fri at 08:30". */
function parseRule(rule) {
  const text = String(rule).trim().toLowerCase();
  const every = /every\s+(\d+)\s*([a-z分时天日]+)/.exec(text);
  const days = /(?:on|weekdays?)\s+([0-9a-z,，\s~\-至到]+?)(?=\s+at\s|$)/.exec(text);
  const clock = /at\s+(\d{1,2}:\d{2})/.exec(text);
  return {
    every: every ? Number(every[1]) : undefined,
    unit: every ? UNITS[every[2]] : undefined,
    weekdays: days ? parseDays(days[1]) : undefined,
    at: clock ? clock[1] : undefined,
  };
}

/**
 * Normalise a repeat request. Accepts a structured object, a rule string, or both; the anchor time
 * supplies the clock when a weekday rule names no explicit time.
 */
export function repeatInput(input, anchor) {
  if (input === undefined || input === null || input === false) return null;
  const source = typeof input === 'string' ? { rule: input } : input;
  if (typeof source !== 'object' || Array.isArray(source)) throw Error('重复规则须为对象或规则字符串');
  const parsed = source.rule ? { ...parseRule(source.rule), ...Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== null && v !== 'rule')) } : source;
  const every = Number(parsed.every ?? 1);
  const unit = UNITS[String(parsed.unit ?? 'd').toLowerCase()];
  if (!Number.isInteger(every) || every < 1 || every > 10000) throw Error('重复间隔须为 1–10000 的正整数');
  if (!unit) throw Error('重复单位须为 min、h 或 d');
  const weekdays = parsed.weekdays === undefined || parsed.weekdays === null || parsed.weekdays === '' ? null : parseDays(parsed.weekdays);
  if (weekdays && !weekdays.length) throw Error('重复规则至少要选择一个星期');
  if (weekdays && unit !== 'd') throw Error('按星期重复只支持以天为单位的间隔');
  const minuteOfDay = parsed.at === undefined || parsed.at === null || parsed.at === '' ? undefined : parseClock(parsed.at);
  const anchorClock = new Date(anchor);
  return { every, unit, weekdays, minuteOfDay: minuteOfDay ?? (weekdays ? anchorClock.getHours() * 60 + anchorClock.getMinutes() : undefined) };
}

/** The activation AFTER the one that just fired, or null when the rule can never match again. */
export function nextActivation(repeat, from) {
  if (!repeat) return null;
  let next = from + repeat.every * STEP[repeat.unit];
  if (repeat.minuteOfDay !== undefined) {
    const at = new Date(next);
    at.setHours(Math.floor(repeat.minuteOfDay / 60), repeat.minuteOfDay % 60, 0, 0);
    next = at.getTime();
    if (next <= from) next += DAY;
  }
  if (repeat.weekdays?.length) {
    for (let index = 0; index < 21; index += 1) {
      const weekday = ((new Date(next).getDay() + 6) % 7) + 1;
      if (repeat.weekdays.includes(weekday)) return next;
      next += DAY;
    }
    return null;
  }
  return next;
}

/** A short human description, stored with the reminder so the panel and the model can read it back. */
export function repeatLabel(repeat) {
  if (!repeat) return '';
  const unitText = repeat.unit === 'min' ? '分钟' : repeat.unit === 'h' ? '小时' : '天';
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  const days = repeat.weekdays?.length ? ' · 周' + repeat.weekdays.map((day) => names[day - 1]).join('、') : '';
  const clock = repeat.minuteOfDay !== undefined ? ' · ' + String(Math.floor(repeat.minuteOfDay / 60)).padStart(2, '0') + ':' + String(repeat.minuteOfDay % 60).padStart(2, '0') : '';
  return `每 ${repeat.every} ${unitText}${days}${clock}`;
}

export function todoInput(input, now) {
  if (!input || typeof input.content !== 'string' || !input.content.trim() || input.content.length > 16000) throw Error('待办内容须为 1–16000 字符');
  const parts = typeof input.activateAt === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(input.activateAt);
  if (!parts) throw Error('激活时间须为带时区的 ISO 时间');
  const [, year, month, day, hour, minute, second = '0'] = parts.map((v, i) => (i === 0 ? v : Number(v)));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) throw Error('激活时间的日期或时分秒无效');
  const activateAt = Date.parse(input.activateAt); if (!Number.isFinite(activateAt) || activateAt <= now) throw Error('激活时间须晚于现在');
  const mode = input.mode ?? 'conversation'; if (!['reminder', 'conversation'].includes(mode)) throw Error('待办方式无效');
  const repeat = repeatInput(input.repeat, activateAt);
  return { content: input.content.trim(), activateAt, mode, ...repeat ? { repeat, repeatText: repeatLabel(repeat) } : {} };
}
export const todoMessageId = id => `todo:${id}`;
