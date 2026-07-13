/*
 * Pure lookback logic — no imports from "obsidian".
 * The test suite (test/run.mjs) exercises everything here directly in Node.
 *
 * Date handling works on "civil dates" ({ y, m, d }, month 1-12) and ISO
 * strings (YYYY-MM-DD). Formatting/parsing of vault-specific date formats
 * (moment tokens like YYYY-MM-DD-dddd) stays in the Obsidian shell, which
 * passes already-parsed ISO dates in and receives ISO dates back.
 */

// ---------------------------------------------------------------------------
// Civil-date arithmetic
// ---------------------------------------------------------------------------

export interface CivilDate {
	y: number;
	m: number; // 1-12
	d: number; // 1-31
}

export type IntervalUnit = "d" | "w" | "m" | "y";

export interface Interval {
	n: number;
	unit: IntervalUnit;
}

export function parseISO(s: string): CivilDate | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
	if (!m) return null;
	const cd = { y: +m[1], m: +m[2], d: +m[3] };
	if (cd.m < 1 || cd.m > 12) return null;
	if (cd.d < 1 || cd.d > daysInMonth(cd.y, cd.m)) return null;
	return cd;
}

export function isoOf(cd: CivilDate): string {
	const yy = String(cd.y).padStart(4, "0");
	const mm = String(cd.m).padStart(2, "0");
	const dd = String(cd.d).padStart(2, "0");
	return `${yy}-${mm}-${dd}`;
}

export function daysInMonth(y: number, m: number): number {
	if (m === 2) return isLeap(y) ? 29 : 28;
	return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function isLeap(y: number): boolean {
	return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Days since 1970-01-01 (Howard Hinnant's civil-days algorithm). */
export function daysFromCivil(cd: CivilDate): number {
	let { y } = cd;
	const { m, d } = cd;
	y -= m <= 2 ? 1 : 0;
	const era = Math.floor((y >= 0 ? y : y - 399) / 400);
	const yoe = y - era * 400;
	const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): CivilDate {
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

/**
 * Subtract n units from a date. Month/year arithmetic clamps the day to the
 * target month's length: 2024-02-29 minus 1y -> 2023-02-28;
 * 2026-03-31 minus 1m -> 2026-02-28.
 */
export function subtractInterval(cd: CivilDate, n: number, unit: IntervalUnit): CivilDate {
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

export function compareISO(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Interval grammar
// ---------------------------------------------------------------------------

/** Parse "1y", "3m", "11d", "2w" (whitespace-tolerant). Null on failure. */
export function parseInterval(s: string): Interval | null {
	const m = /^\s*(\d+)\s*([dwmy])\s*$/i.exec(s);
	if (!m) return null;
	const n = +m[1];
	if (n < 1) return null;
	return { n, unit: m[2].toLowerCase() as IntervalUnit };
}

// ---------------------------------------------------------------------------
// Target generation
// ---------------------------------------------------------------------------

export interface LookbackTarget {
	iso: string;
	/** Total distance from the anchor, e.g. { n: 3, unit: "y" } for the third yearly step. */
	distance: Interval;
	fromRecurring: boolean;
}

export interface TargetOptions {
	anchorISO: string;
	every: Interval | null;
	/** Hard stop for the recurring series (inclusive). */
	sinceISO: string | null;
	/** Smart cutoff: earliest known daily note; used when sinceISO stays null. */
	earliestISO: string | null;
	offsets: Interval[];
	maxSteps?: number;
}

/**
 * Expand the recurring series and merge explicit offsets.
 * - Recurring steps stop at `since` (inclusive), else at `earliest` (inclusive),
 *   else generate nothing (no bound -> no runaway series).
 * - Explicit offsets always appear, even past the cutoff (the user asked).
 * - Duplicates (same resulting date) collapse to one row, keeping the first
 *   after a nearest-first sort.
 */
export function buildTargets(opts: TargetOptions): LookbackTarget[] {
	const anchor = parseISO(opts.anchorISO);
	if (!anchor) return [];
	const maxSteps = opts.maxSteps ?? 500;
	const out: LookbackTarget[] = [];

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

	// Nearest-first (descending date), then dedupe by date.
	out.sort((a, b) => compareISO(b.iso, a.iso));
	const seen = new Set<string>();
	return out.filter((t) => (seen.has(t.iso) ? false : (seen.add(t.iso), true)));
}

const UNIT_NAMES: Record<IntervalUnit, string> = { d: "day", w: "week", m: "month", y: "year" };

export function humanizeDistance(iv: Interval): string {
	const name = UNIT_NAMES[iv.unit];
	return `${iv.n} ${name}${iv.n === 1 ? "" : "s"} ago`;
}

/**
 * Row label. Yearly distances label as the bare target year (matching the
 * classic `#### 2024` output); everything else labels as the ISO date with a
 * humanized caption.
 */
export function labelFor(target: LookbackTarget): { primary: string; caption: string } {
	const cd = parseISO(target.iso);
	if (target.distance.unit === "y" && cd) {
		return { primary: String(cd.y), caption: humanizeDistance(target.distance) };
	}
	return { primary: target.iso, caption: humanizeDistance(target.distance) };
}

/** Earliest ISO date in a list (null for an empty list). */
export function earliestISO(dates: string[]): string | null {
	let min: string | null = null;
	for (const d of dates) {
		if (min === null || compareISO(d, min) < 0) min = d;
	}
	return min;
}

// ---------------------------------------------------------------------------
// Block config coercion
// ---------------------------------------------------------------------------

export type LookbackStyle = "default" | "minimal" | "elegant" | "ornate";

export const STYLE_NAMES: LookbackStyle[] = ["default", "minimal", "elegant", "ornate"];

export interface LookbackConfig {
	sections: string[];
	every: string | null;
	since: string | null;
	offsets: string[];
	date: string | null;
	heading: number;
	expanded: boolean;
	folder: string | null;
	format: string | null;
	missing: "show" | "hide";
	style: LookbackStyle;
	/** CSS color overriding the theme accent; null inherits the vault theme. */
	accent: string | null;
}

export const DEFAULT_CONFIG: LookbackConfig = {
	sections: [],
	every: "1y",
	since: null,
	offsets: [],
	date: null,
	heading: 4,
	expanded: false,
	folder: null,
	format: null,
	missing: "show",
	style: "default",
	accent: null,
};

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

function asStringList(v: unknown): string[] | null {
	if (typeof v === "string") {
		return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
	}
	if (Array.isArray(v)) {
		return v.filter((x): x is string | number => typeof x === "string" || typeof x === "number")
			.map((x) => String(x).trim())
			.filter((s) => s.length > 0);
	}
	return null;
}

/**
 * Coerce a parsed-YAML object (or anything else) into a valid config.
 * Wrong types fall back to the provided defaults; every problem lands in
 * `warnings` instead of throwing.
 */
export function coerceConfig(raw: unknown, defaults: LookbackConfig): { config: LookbackConfig; warnings: string[] } {
	const warnings: string[] = [];
	const cfg: LookbackConfig = { ...defaults, sections: [...defaults.sections], offsets: [...defaults.offsets] };
	if (raw === null || raw === undefined) return { config: cfg, warnings };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("block config must form a YAML mapping; using defaults");
		return { config: cfg, warnings };
	}
	const obj = raw as Record<string, unknown>;
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
	if ("style" in obj) {
		const v = typeof obj.style === "string" ? obj.style.trim().toLowerCase() : "";
		if ((STYLE_NAMES as string[]).includes(v)) cfg.style = v as LookbackStyle;
		else warnings.push(`"style" needs one of: ${STYLE_NAMES.join(", ")}`);
	}
	if ("accent" in obj) {
		const v = obj.accent;
		if (v === null || v === false) cfg.accent = null;
		else if (typeof v === "string" && v.trim() && v.trim().length <= 64) cfg.accent = v.trim();
		else warnings.push(`"accent" needs a CSS color like #7c3aed or rebeccapurple`);
	}
	return { config: cfg, warnings };
}

// ---------------------------------------------------------------------------
// Heading matching + section slicing
// ---------------------------------------------------------------------------

export interface HeadingInfo {
	text: string;
	level: number;
	/** Char offset where the heading line starts. */
	startOffset: number;
	/** Char offset just past the heading line. */
	endOffset: number;
}

/** Strip surrounding emphasis/formatting marks: _x_, *x*, **x**, `x`, ~~x~~. */
export function normalizeHeading(text: string): string {
	let t = text.trim();
	let prev = "";
	while (prev !== t) {
		prev = t;
		t = t.replace(/^([*_`~]+)(.*?)\1$/s, "$2").trim();
	}
	return t;
}

export function matchesHeading(headingText: string, target: string, strict: boolean): boolean {
	if (strict) return headingText.trim() === target.trim();
	return normalizeHeading(headingText).toLowerCase() === normalizeHeading(target).toLowerCase();
}

/**
 * Slice one section out of note content using pre-extracted heading info
 * (the shell feeds these from Obsidian's metadata cache — no parsing here).
 * Semantics match native `![[note#heading]]` embeds: from the end of the
 * matched heading line to the next heading of equal-or-higher rank.
 */
export function sliceSection(
	content: string,
	headings: HeadingInfo[],
	section: string,
	strict: boolean
): string | null {
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
