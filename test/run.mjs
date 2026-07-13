// Bundle the engine (pure logic, no Obsidian imports) and run the suite in Node.
import { build } from "esbuild";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import assert from "assert";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, ".build", "engine.mjs");

await build({
	entryPoints: [path.join(here, "..", "src", "engine.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "es2020",
	outfile
});

const {
	parseISO, isoOf, daysInMonth, subtractInterval, parseInterval,
	buildTargets, humanizeDistance, labelFor, earliestISO,
	coerceConfig, DEFAULT_CONFIG,
	normalizeHeading, matchesHeading, sliceSection
} = await import(pathToFileURL(outfile).href);

let passed = 0;
function ok(name, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passed++;
			console.log(`  ✓ ${name}`);
		})
		.catch((err) => {
			console.error(`  ✗ ${name}`);
			console.error(err);
			process.exitCode = 1;
		});
}

// --- ISO parsing ------------------------------------------------------------
await ok("parseISO accepts valid dates and rejects garbage", () => {
	assert.deepEqual(parseISO("2026-07-13"), { y: 2026, m: 7, d: 13 });
	assert.equal(parseISO("2026-13-01"), null);
	assert.equal(parseISO("2026-02-30"), null);
	assert.equal(parseISO("2023-2-3"), null);
	assert.equal(parseISO("not-a-date"), null);
});

await ok("parseISO accepts Feb 29 only in leap years", () => {
	assert.deepEqual(parseISO("2024-02-29"), { y: 2024, m: 2, d: 29 });
	assert.equal(parseISO("2023-02-29"), null);
});

await ok("isoOf pads correctly", () => {
	assert.equal(isoOf({ y: 987, m: 3, d: 4 }), "0987-03-04");
});

// --- interval grammar ---------------------------------------------------------
await ok("parseInterval reads d/w/m/y with whitespace and case tolerance", () => {
	assert.deepEqual(parseInterval("1y"), { n: 1, unit: "y" });
	assert.deepEqual(parseInterval(" 3M "), { n: 3, unit: "m" });
	assert.deepEqual(parseInterval("11d"), { n: 11, unit: "d" });
	assert.deepEqual(parseInterval("2w"), { n: 2, unit: "w" });
});

await ok("parseInterval rejects zero, negatives, and junk", () => {
	assert.equal(parseInterval("0y"), null);
	assert.equal(parseInterval("-1m"), null);
	assert.equal(parseInterval("1 fortnight"), null);
	assert.equal(parseInterval("y"), null);
});

// --- date arithmetic -----------------------------------------------------------
await ok("subtractInterval: leap day minus 1y clamps to Feb 28", () => {
	assert.equal(isoOf(subtractInterval({ y: 2024, m: 2, d: 29 }, 1, "y")), "2023-02-28");
});

await ok("subtractInterval: leap day minus 4y lands back on Feb 29", () => {
	assert.equal(isoOf(subtractInterval({ y: 2024, m: 2, d: 29 }, 4, "y")), "2020-02-29");
});

await ok("subtractInterval: month-end clamps (Mar 31 - 1m -> Feb 28)", () => {
	assert.equal(isoOf(subtractInterval({ y: 2026, m: 3, d: 31 }, 1, "m")), "2026-02-28");
	assert.equal(isoOf(subtractInterval({ y: 2024, m: 3, d: 31 }, 1, "m")), "2024-02-29");
});

await ok("subtractInterval: days and weeks cross month/year boundaries", () => {
	assert.equal(isoOf(subtractInterval({ y: 2026, m: 1, d: 1 }, 1, "d")), "2025-12-31");
	assert.equal(isoOf(subtractInterval({ y: 2026, m: 7, d: 13 }, 2, "w")), "2026-06-29");
	assert.equal(isoOf(subtractInterval({ y: 2026, m: 3, d: 1 }, 1, "d")), "2026-02-28");
	assert.equal(isoOf(subtractInterval({ y: 2024, m: 3, d: 1 }, 1, "d")), "2024-02-29");
});

await ok("subtractInterval: months across year boundary", () => {
	assert.equal(isoOf(subtractInterval({ y: 2026, m: 1, d: 15 }, 3, "m")), "2025-10-15");
	assert.equal(isoOf(subtractInterval({ y: 2026, m: 1, d: 15 }, 13, "m")), "2024-12-15");
});

// --- target generation -----------------------------------------------------------
await ok("buildTargets: yearly since hard stop (the classic Templater case)", () => {
	const t = buildTargets({
		anchorISO: "2026-07-13",
		every: { n: 1, unit: "y" },
		sinceISO: "2023-09-03",
		earliestISO: null,
		offsets: []
	});
	assert.deepEqual(t.map((x) => x.iso), ["2025-07-13", "2024-07-13"]);
	assert.ok(t.every((x) => x.fromRecurring));
});

await ok("buildTargets: since boundary includes the equal date", () => {
	const t = buildTargets({
		anchorISO: "2026-09-03",
		every: { n: 1, unit: "y" },
		sinceISO: "2023-09-03",
		earliestISO: null,
		offsets: []
	});
	assert.deepEqual(t.map((x) => x.iso), ["2025-09-03", "2024-09-03", "2023-09-03"]);
});

await ok("buildTargets: smart cutoff via earliest note when since stays null", () => {
	const t = buildTargets({
		anchorISO: "2026-07-13",
		every: { n: 1, unit: "y" },
		sinceISO: null,
		earliestISO: "2024-01-01",
		offsets: []
	});
	assert.deepEqual(t.map((x) => x.iso), ["2025-07-13", "2024-07-13"]);
});

await ok("buildTargets: no bound at all -> no recurring targets (no runaway)", () => {
	const t = buildTargets({
		anchorISO: "2026-07-13",
		every: { n: 1, unit: "y" },
		sinceISO: null,
		earliestISO: null,
		offsets: [{ n: 1, unit: "m" }]
	});
	assert.deepEqual(t.map((x) => x.iso), ["2026-06-13"]);
});

await ok("buildTargets: explicit offsets bypass the cutoff", () => {
	const t = buildTargets({
		anchorISO: "2026-07-13",
		every: null,
		sinceISO: null,
		earliestISO: "2026-01-01",
		offsets: [{ n: 2, unit: "y" }]
	});
	assert.deepEqual(t.map((x) => x.iso), ["2024-07-13"]);
});

await ok("buildTargets: merge dedupes 12m against 1y and sorts nearest-first", () => {
	const t = buildTargets({
		anchorISO: "2026-07-13",
		every: { n: 1, unit: "y" },
		sinceISO: "2025-01-01",
		earliestISO: null,
		offsets: [{ n: 12, unit: "m" }, { n: 1, unit: "w" }]
	});
	assert.deepEqual(t.map((x) => x.iso), ["2026-07-06", "2025-07-13"]);
});

await ok("buildTargets: maxSteps caps the series", () => {
	const t = buildTargets({
		anchorISO: "2026-07-13",
		every: { n: 1, unit: "d" },
		sinceISO: "2020-01-01",
		earliestISO: null,
		offsets: [],
		maxSteps: 10
	});
	assert.equal(t.length, 10);
});

await ok("buildTargets: invalid anchor yields nothing", () => {
	assert.deepEqual(buildTargets({ anchorISO: "nope", every: { n: 1, unit: "y" }, sinceISO: "2020-01-01", earliestISO: null, offsets: [] }), []);
});

// --- labels ---------------------------------------------------------------------
await ok("labelFor: yearly rows label as the bare year", () => {
	const t = { iso: "2024-07-13", distance: { n: 2, unit: "y" }, fromRecurring: true };
	assert.deepEqual(labelFor(t), { primary: "2024", caption: "2 years ago" });
});

await ok("labelFor: non-yearly rows label as date + humanized caption", () => {
	const t = { iso: "2026-04-13", distance: { n: 3, unit: "m" }, fromRecurring: false };
	assert.deepEqual(labelFor(t), { primary: "2026-04-13", caption: "3 months ago" });
});

await ok("humanizeDistance pluralizes correctly", () => {
	assert.equal(humanizeDistance({ n: 1, unit: "w" }), "1 week ago");
	assert.equal(humanizeDistance({ n: 11, unit: "d" }), "11 days ago");
});

await ok("earliestISO finds the minimum and handles empty lists", () => {
	assert.equal(earliestISO(["2024-05-01", "2023-09-03", "2025-01-01"]), "2023-09-03");
	assert.equal(earliestISO([]), null);
});

// --- config coercion ---------------------------------------------------------------
await ok("coerceConfig: empty/null input returns pure defaults", () => {
	const { config, warnings } = coerceConfig(null, DEFAULT_CONFIG);
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.deepEqual(warnings, []);
});

await ok("coerceConfig: full valid block parses cleanly", () => {
	const { config, warnings } = coerceConfig({
		sections: ["Daily Meditation", "Dream Log"],
		every: "1y",
		since: "2023-09-03",
		offsets: ["1w", "3m"],
		date: "2026-07-13",
		heading: 3,
		expanded: true,
		folder: "/Daily Notes/",
		format: "YYYY-MM-DD-dddd",
		missing: "HIDE"
	}, DEFAULT_CONFIG);
	assert.deepEqual(warnings, []);
	assert.deepEqual(config.sections, ["Daily Meditation", "Dream Log"]);
	assert.equal(config.folder, "Daily Notes");
	assert.equal(config.missing, "hide");
	assert.equal(config.heading, 3);
});

await ok("coerceConfig: comma-string sections and offsets work", () => {
	const { config } = coerceConfig({ sections: "A, B , ", offsets: "1w, 1m" }, DEFAULT_CONFIG);
	assert.deepEqual(config.sections, ["A", "B"]);
	assert.deepEqual(config.offsets, ["1w", "1m"]);
});

await ok("coerceConfig: wrong types fall back with warnings, never throw", () => {
	const { config, warnings } = coerceConfig({
		sections: 42, every: "fortnight", since: "yesterday",
		heading: 9, expanded: "yes", missing: "maybe", bogus: 1
	}, DEFAULT_CONFIG);
	assert.deepEqual(config.sections, DEFAULT_CONFIG.sections);
	assert.equal(config.every, DEFAULT_CONFIG.every);
	assert.equal(config.heading, DEFAULT_CONFIG.heading);
	assert.equal(config.expanded, DEFAULT_CONFIG.expanded);
	assert.equal(config.missing, DEFAULT_CONFIG.missing);
	assert.equal(warnings.length, 7);
});

await ok("coerceConfig: every can switch off with null/false", () => {
	assert.equal(coerceConfig({ every: null }, DEFAULT_CONFIG).config.every, null);
	assert.equal(coerceConfig({ every: false }, DEFAULT_CONFIG).config.every, null);
});

await ok("coerceConfig: scalar YAML body warns and falls back", () => {
	const { config, warnings } = coerceConfig("just a string", DEFAULT_CONFIG);
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.equal(warnings.length, 1);
});

// --- heading matching -----------------------------------------------------------
await ok("normalizeHeading strips emphasis wrappers", () => {
	assert.equal(normalizeHeading("_Daily Meditation_"), "Daily Meditation");
	assert.equal(normalizeHeading("**_Chrono Retrospection_**"), "Chrono Retrospection");
	assert.equal(normalizeHeading("`code`"), "code");
	assert.equal(normalizeHeading("plain"), "plain");
});

await ok("matchesHeading: lenient matches across emphasis and case", () => {
	assert.ok(matchesHeading("_Daily Meditation_", "daily meditation", false));
	assert.ok(matchesHeading("Daily Meditation", "_Daily Meditation_", false));
	assert.ok(!matchesHeading("Daily Meditation Notes", "Daily Meditation", false));
});

await ok("matchesHeading: strict requires the exact written form", () => {
	assert.ok(matchesHeading("_Daily Meditation_", "_Daily Meditation_", true));
	assert.ok(!matchesHeading("_Daily Meditation_", "Daily Meditation", true));
});

// --- section slicing --------------------------------------------------------------
const NOTE = [
	"### _Breath Counting_",   // 0-22 (heading line incl newline boundary handled below)
	"##### Cardio:",
	"ran 5k",
	"",
	"### _Daily Meditation_",
	"##### Meta Notes:",
	"Start time - 6:04",
	"##### Notes:",
	"calm session",
	"",
	"### _Dream Log_",
	"flying again"
].join("\n");

function headingsOf(content) {
	// Tiny test-side heading scanner standing in for Obsidian's metadata cache.
	const out = [];
	let offset = 0;
	for (const line of content.split("\n")) {
		const m = /^(#{1,6})\s+(.*)$/.exec(line);
		if (m) out.push({ text: m[2], level: m[1].length, startOffset: offset, endOffset: offset + line.length });
		offset += line.length + 1;
	}
	return out;
}

await ok("sliceSection extracts to the next equal-or-higher heading", () => {
	const s = sliceSection(NOTE, headingsOf(NOTE), "Daily Meditation", false);
	assert.ok(s.includes("##### Meta Notes:"));
	assert.ok(s.includes("calm session"));
	assert.ok(!s.includes("Dream Log"));
	assert.ok(!s.includes("Breath Counting"));
});

await ok("sliceSection keeps nested lower-level headings inside the slice", () => {
	const s = sliceSection(NOTE, headingsOf(NOTE), "_Daily Meditation_", false);
	assert.ok(s.includes("##### Notes:"));
});

await ok("sliceSection runs to end-of-file for the last section", () => {
	const s = sliceSection(NOTE, headingsOf(NOTE), "Dream Log", false);
	assert.equal(s, "flying again");
});

await ok("sliceSection returns null for a missing section", () => {
	assert.equal(sliceSection(NOTE, headingsOf(NOTE), "Gratitude", false), null);
});

await ok("sliceSection strict mode honors exact written form only", () => {
	assert.equal(sliceSection(NOTE, headingsOf(NOTE), "Daily Meditation", true), null);
	assert.ok(sliceSection(NOTE, headingsOf(NOTE), "_Daily Meditation_", true) !== null);
});

console.log(`\n${passed} passing${process.exitCode ? " (with failures)" : ""}`);
