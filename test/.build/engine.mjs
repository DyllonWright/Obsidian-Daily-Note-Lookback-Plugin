// src/engine.ts
function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const cd = { y: +m[1], m: +m[2], d: +m[3] };
  if (cd.m < 1 || cd.m > 12) return null;
  if (cd.d < 1 || cd.d > daysInMonth(cd.y, cd.m)) return null;
  return cd;
}
function isoOf(cd) {
  const yy = String(cd.y).padStart(4, "0");
  const mm = String(cd.m).padStart(2, "0");
  const dd = String(cd.d).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
function isLeap(y) {
  return y % 4 === 0 && y % 100 !== 0 || y % 400 === 0;
}
function daysFromCivil(cd) {
  let { y } = cd;
  const { m, d } = cd;
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
function civilFromDays(z) {
  z += 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}
function subtractInterval(cd, n, unit) {
  if (unit === "d" || unit === "w") {
    const days = unit === "w" ? n * 7 : n;
    return civilFromDays(daysFromCivil(cd) - days);
  }
  const totalMonths = unit === "y" ? n * 12 : n;
  let months = cd.y * 12 + (cd.m - 1) - totalMonths;
  const y = Math.floor(months / 12);
  const m = (months % 12 + 12) % 12 + 1;
  const d = Math.min(cd.d, daysInMonth(y, m));
  return { y, m, d };
}
function compareISO(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function parseInterval(s) {
  const m = /^\s*(\d+)\s*([dwmy])\s*$/i.exec(s);
  if (!m) return null;
  const n = +m[1];
  if (n < 1) return null;
  return { n, unit: m[2].toLowerCase() };
}
function buildTargets(opts) {
  const anchor = parseISO(opts.anchorISO);
  if (!anchor) return [];
  const maxSteps = opts.maxSteps ?? 500;
  const out = [];
  if (opts.every) {
    const bound = opts.sinceISO ?? opts.earliestISO;
    if (bound) {
      for (let i = 1; i <= maxSteps; i++) {
        const total = opts.every.n * i;
        const target = subtractInterval(anchor, total, opts.every.unit);
        const iso = isoOf(target);
        if (compareISO(iso, bound) < 0) break;
        out.push({ iso, distance: { n: total, unit: opts.every.unit }, fromRecurring: true });
      }
    }
  }
  for (const off of opts.offsets) {
    const iso = isoOf(subtractInterval(anchor, off.n, off.unit));
    out.push({ iso, distance: off, fromRecurring: false });
  }
  out.sort((a, b) => compareISO(b.iso, a.iso));
  const seen = /* @__PURE__ */ new Set();
  return out.filter((t) => seen.has(t.iso) ? false : (seen.add(t.iso), true));
}
var UNIT_NAMES = { d: "day", w: "week", m: "month", y: "year" };
function humanizeDistance(iv) {
  const name = UNIT_NAMES[iv.unit];
  return `${iv.n} ${name}${iv.n === 1 ? "" : "s"} ago`;
}
function labelFor(target) {
  const cd = parseISO(target.iso);
  if (target.distance.unit === "y" && cd) {
    return { primary: String(cd.y), caption: humanizeDistance(target.distance) };
  }
  return { primary: target.iso, caption: humanizeDistance(target.distance) };
}
function earliestISO(dates) {
  let min = null;
  for (const d of dates) {
    if (min === null || compareISO(d, min) < 0) min = d;
  }
  return min;
}
var DEFAULT_CONFIG = {
  sections: [],
  every: "1y",
  since: null,
  offsets: [],
  date: null,
  heading: 4,
  expanded: false,
  folder: null,
  format: null,
  missing: "show"
};
var KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG));
function asStringList(v) {
  if (typeof v === "string") {
    return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (Array.isArray(v)) {
    return v.filter((x) => typeof x === "string" || typeof x === "number").map((x) => String(x).trim()).filter((s) => s.length > 0);
  }
  return null;
}
function coerceConfig(raw, defaults) {
  const warnings = [];
  const cfg = { ...defaults, sections: [...defaults.sections], offsets: [...defaults.offsets] };
  if (raw === null || raw === void 0) return { config: cfg, warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("block config must form a YAML mapping; using defaults");
    return { config: cfg, warnings };
  }
  const obj = raw;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key "${key}" ignored`);
  }
  if ("sections" in obj) {
    const list = asStringList(obj.sections);
    if (list) cfg.sections = list;
    else warnings.push(`"sections" needs a list or comma-separated string`);
  }
  if ("every" in obj) {
    const v = obj.every;
    if (v === null || v === false) cfg.every = null;
    else if ((typeof v === "string" || typeof v === "number") && parseInterval(String(v))) cfg.every = String(v).trim();
    else warnings.push(`"every" needs an interval like 1y, 3m, 2w, 11d`);
  }
  if ("since" in obj) {
    const v = obj.since;
    const s = typeof v === "string" ? v.trim() : v instanceof Date ? v.toISOString().slice(0, 10) : null;
    if (s && parseISO(s)) cfg.since = s;
    else warnings.push(`"since" needs a YYYY-MM-DD date`);
  }
  if ("offsets" in obj) {
    const list = asStringList(obj.offsets);
    if (list) {
      const bad = list.filter((s) => !parseInterval(s));
      if (bad.length) warnings.push(`invalid offsets ignored: ${bad.join(", ")}`);
      cfg.offsets = list.filter((s) => parseInterval(s));
    } else warnings.push(`"offsets" needs a list like [1w, 1m, 3m]`);
  }
  if ("date" in obj) {
    const v = obj.date;
    const s = typeof v === "string" ? v.trim() : v instanceof Date ? v.toISOString().slice(0, 10) : null;
    if (s && parseISO(s)) cfg.date = s;
    else warnings.push(`"date" needs a YYYY-MM-DD date`);
  }
  if ("heading" in obj) {
    const n = typeof obj.heading === "number" ? obj.heading : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= 6) cfg.heading = n;
    else warnings.push(`"heading" needs an integer 1-6`);
  }
  if ("expanded" in obj) {
    if (typeof obj.expanded === "boolean") cfg.expanded = obj.expanded;
    else warnings.push(`"expanded" needs true or false`);
  }
  if ("folder" in obj) {
    if (typeof obj.folder === "string") cfg.folder = obj.folder.trim().replace(/^\/+|\/+$/g, "") || null;
    else warnings.push(`"folder" needs a string`);
  }
  if ("format" in obj) {
    if (typeof obj.format === "string" && obj.format.trim()) cfg.format = obj.format.trim();
    else warnings.push(`"format" needs a moment-style format string`);
  }
  if ("missing" in obj) {
    const v = typeof obj.missing === "string" ? obj.missing.trim().toLowerCase() : "";
    if (v === "show" || v === "hide") cfg.missing = v;
    else warnings.push(`"missing" needs "show" or "hide"`);
  }
  return { config: cfg, warnings };
}
function normalizeHeading(text) {
  let t = text.trim();
  let prev = "";
  while (prev !== t) {
    prev = t;
    t = t.replace(/^([*_`~]+)(.*?)\1$/s, "$2").trim();
  }
  return t;
}
function matchesHeading(headingText, target, strict) {
  if (strict) return headingText.trim() === target.trim();
  return normalizeHeading(headingText).toLowerCase() === normalizeHeading(target).toLowerCase();
}
function sliceSection(content, headings, section, strict) {
  for (let i = 0; i < headings.length; i++) {
    if (!matchesHeading(headings[i].text, section, strict)) continue;
    let end = content.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= headings[i].level) {
        end = headings[j].startOffset;
        break;
      }
    }
    return content.slice(headings[i].endOffset, end).trim();
  }
  return null;
}
export {
  DEFAULT_CONFIG,
  buildTargets,
  civilFromDays,
  coerceConfig,
  compareISO,
  daysFromCivil,
  daysInMonth,
  earliestISO,
  humanizeDistance,
  isoOf,
  labelFor,
  matchesHeading,
  normalizeHeading,
  parseISO,
  parseInterval,
  sliceSection,
  subtractInterval
};
