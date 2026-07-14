import {
	MarkdownPostProcessorContext,
	MarkdownView,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
	Vault,
	moment,
	normalizePath,
	parseYaml,
} from "obsidian";
import {
	DEFAULT_CONFIG,
	LookbackConfig,
	buildTargets,
	coerceConfig,
	compareISO,
	parseInterval,
} from "./engine";
import { LookbackController, ResolvedRow } from "./render";
import { DEFAULT_SETTINGS, LookbackSettingTab, LookbackSettings } from "./settings";

const FENCE_ALIASES = ["lookback", "lb", "daily-note-lookback", "chrono"];

// The obsidian typings expose `moment` as a namespace without call
// signatures; the runtime value stays the callable moment function.
interface MomentLike {
	isValid(): boolean;
	format(fmt: string): string;
}
const momentParse = moment as unknown as (input: string, format: string, strict: boolean) => MomentLike;

interface DailyNoteDiscovery {
	folder: string;
	format: string;
}

interface ExpansionEntry {
	t: number;
	rows: Record<string, boolean>;
}

interface PersistedData {
	settings?: Partial<LookbackSettings>;
	expansion?: Record<string, ExpansionEntry>;
}

const MAX_REMEMBERED_NOTES = 200;

export default class DailyNoteLookbackPlugin extends Plugin {
	settings: LookbackSettings = DEFAULT_SETTINGS;
	expansionState: Record<string, ExpansionEntry> = {};
	controllers = new Set<LookbackController>();

	private earliestCache = new Map<string, string | null>();
	private saveTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadPersisted();

		for (const alias of FENCE_ALIASES) {
			this.registerMarkdownCodeBlockProcessor(alias, (source, el, ctx) =>
				this.processBlock(source, el, ctx)
			);
		}

		this.addSettingTab(new LookbackSettingTab(this.app, this));

		this.addCommand({
			id: "insert-block",
			name: "Insert lookback block",
			editorCallback: (editor) => {
				editor.replaceSelection("```lookback\n```\n");
			},
		});

		this.addCommand({
			id: "refresh-active",
			name: "Refresh lookback blocks in active note",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				if (!checking) {
					this.earliestCache.clear();
					const leaf = view.leaf as unknown as { rebuildView?: () => void };
					if (leaf.rebuildView) leaf.rebuildView();
					else view.previewMode?.rerender(true);
				}
				return true;
			},
		});

		this.addCommand({
			id: "expand-all",
			name: "Expand all lookback rows in active note",
			checkCallback: (checking) => this.forEachActiveController(checking, (c) => c.expandAll()),
		});

		this.addCommand({
			id: "collapse-all",
			name: "Collapse all lookback rows in active note",
			checkCallback: (checking) => this.forEachActiveController(checking, (c) => c.collapseAll()),
		});

		// The smart cutoff caches the earliest daily note per folder/format;
		// any change inside the folder invalidates it.
		this.registerEvent(this.app.vault.on("create", (f) => this.invalidateFor(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => this.invalidateFor(f)));
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				this.invalidateFor(f);
				this.invalidateForPath(oldPath);
			})
		);
	}

	// -------------------------------------------------------------------------
	// Block processing
	// -------------------------------------------------------------------------

	private processBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		// Nested guard: a lookback block inside an expanded lookback section
		// renders as a stub instead of recursing.
		if (el.closest(".dnl-content") || el.closest(".dnl-popover")) {
			el.createDiv({ cls: "dnl-missing-text", text: "(nested lookback block skipped)" });
			return;
		}

		let raw: unknown = null;
		if (source.trim().length > 0) {
			try {
				raw = parseYaml(source);
			} catch (e) {
				el.createDiv({ cls: "dnl-error", text: `Daily Note Lookback: could not parse block config — ${String(e)}` });
				return;
			}
		}

		const { config, warnings } = coerceConfig(raw, this.settings.defaults);
		for (const w of warnings) console.warn(`[daily-note-lookback] ${ctx.sourcePath}: ${w}`);

		const discovered = this.discoverDailyNotes();
		const folder = config.folder ?? discovered.folder;
		const format = config.format ?? discovered.format;

		const anchorISO = this.resolveAnchor(config, ctx.sourcePath, folder, format);
		if (!anchorISO) {
			el.createDiv({
				cls: "dnl-error",
				text: `Daily Note Lookback: this note's name does not match the daily format (${format}). Add a "date: YYYY-MM-DD" line to the block.`,
			});
			return;
		}

		const every = config.every ? parseInterval(config.every) : null;
		const offsets = config.offsets
			.map((s) => parseInterval(s))
			.filter((iv): iv is NonNullable<typeof iv> => iv !== null);

		const needCutoff = every !== null && config.since === null;
		const earliest = needCutoff ? this.earliestDailyNote(folder, format) : null;

		const targets = buildTargets({
			anchorISO,
			every,
			sinceISO: config.since,
			earliestISO: earliest,
			offsets,
		});

		// Rows resolve by constructed path first, then by Obsidian's own link
		// resolution — the same search a [[wikilink]] performs — so notes
		// archived into nested folders keep appearing. Metadata lookups only,
		// never a read.
		const rows: ResolvedRow[] = targets
			.filter((t) => compareISO(t.iso, anchorISO) < 0)
			.map((t) => {
				const name = momentParse(t.iso, "YYYY-MM-DD", true).format(format);
				const path = normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
				const af = this.app.vault.getAbstractFileByPath(path);
				let file = af instanceof TFile ? af : null;
				if (!file) file = this.app.metadataCache.getFirstLinkpathDest(name, ctx.sourcePath);
				return { target: t, file, displayName: name };
			});

		ctx.addChild(new LookbackController(this, el, config, ctx.sourcePath, rows));
	}

	/** Anchor date: the block's `date:` key, else the host note's own name. */
	private resolveAnchor(
		config: LookbackConfig,
		sourcePath: string,
		folder: string,
		format: string
	): string | null {
		if (config.date) return config.date;
		let rel = sourcePath.endsWith(".md") ? sourcePath.slice(0, -3) : sourcePath;
		if (folder && rel.startsWith(folder + "/")) rel = rel.slice(folder.length + 1);
		else rel = rel.split("/").pop() ?? rel;
		const m = momentParse(rel, format, true);
		return m.isValid() ? m.format("YYYY-MM-DD") : null;
	}

	// -------------------------------------------------------------------------
	// Daily-note discovery + smart cutoff
	// -------------------------------------------------------------------------

	/** Daily Notes core plugin first, Periodic Notes second, plain defaults last. */
	private discoverDailyNotes(): DailyNoteDiscovery {
		const d = this.settings.defaults;
		let folder: string | null = d.folder;
		let format: string | null = d.format;

		type DailyOpts = { folder?: string; format?: string };
		const appAny = this.app as unknown as {
			internalPlugins?: { getPluginById?: (id: string) => { instance?: { options?: DailyOpts } } | null };
			plugins?: { getPlugin?: (id: string) => { settings?: { daily?: DailyOpts } } | null };
		};

		const core = appAny.internalPlugins?.getPluginById?.("daily-notes")?.instance?.options;
		const periodic = appAny.plugins?.getPlugin?.("periodic-notes")?.settings?.daily;

		if (folder === null) folder = core?.folder?.trim() || periodic?.folder?.trim() || "";
		if (format === null) format = core?.format?.trim() || periodic?.format?.trim() || "YYYY-MM-DD";
		return { folder: folder.replace(/^\/+|\/+$/g, ""), format };
	}

	/**
	 * Earliest parseable daily note in the folder — filename inspection only,
	 * zero file reads, scoped to the daily-notes folder rather than the whole
	 * vault. Cached until something changes inside the folder.
	 */
	private earliestDailyNote(folder: string, format: string): string | null {
		const key = `${folder}|${format}`;
		const cached = this.earliestCache.get(key);
		if (cached !== undefined) return cached;

		const rootAf = folder ? this.app.vault.getAbstractFileByPath(folder) : this.app.vault.getRoot();
		if (!(rootAf instanceof TFolder)) {
			this.earliestCache.set(key, null);
			return null;
		}

		let min: string | null = null;
		const prefix = folder ? folder + "/" : "";
		const flatFormat = !format.includes("/");
		Vault.recurseChildren(rootAf, (af) => {
			if (!(af instanceof TFile) || af.extension !== "md") return;
			const rel = af.path.startsWith(prefix) ? af.path.slice(prefix.length, -3) : af.path.slice(0, -3);
			let m = momentParse(rel, format, true);
			// Archived notes nest in subfolders the format never mentions;
			// for flat formats, the basename alone still identifies them.
			if (!m.isValid() && flatFormat) m = momentParse(af.basename, format, true);
			if (!m.isValid()) return;
			const iso = m.format("YYYY-MM-DD");
			if (min === null || compareISO(iso, min) < 0) min = iso;
		});
		this.earliestCache.set(key, min);
		return min;
	}

	private invalidateFor(f: TAbstractFile): void {
		this.invalidateForPath(f.path);
	}

	private invalidateForPath(path: string): void {
		for (const key of Array.from(this.earliestCache.keys())) {
			const folder = key.split("|")[0];
			if (!folder || path.startsWith(folder + "/")) this.earliestCache.delete(key);
		}
	}

	// -------------------------------------------------------------------------
	// Expansion memory
	// -------------------------------------------------------------------------

	getRememberedExpansion(hostPath: string, iso: string): boolean | null {
		if (!this.settings.rememberExpansion) return null;
		const entry = this.expansionState[hostPath];
		if (!entry || !(iso in entry.rows)) return null;
		return entry.rows[iso];
	}

	rememberExpansion(hostPath: string, iso: string, expanded: boolean): void {
		if (!this.settings.rememberExpansion) return;
		const entry = this.expansionState[hostPath] ?? { t: 0, rows: {} };
		entry.t = Date.now();
		entry.rows[iso] = expanded;
		this.expansionState[hostPath] = entry;
		this.pruneExpansionState();
		this.scheduleSave();
	}

	private pruneExpansionState(): void {
		const keys = Object.keys(this.expansionState);
		if (keys.length <= MAX_REMEMBERED_NOTES) return;
		keys.sort((a, b) => this.expansionState[a].t - this.expansionState[b].t);
		for (const k of keys.slice(0, keys.length - MAX_REMEMBERED_NOTES)) {
			delete this.expansionState[k];
		}
	}

	// -------------------------------------------------------------------------
	// Persistence + helpers
	// -------------------------------------------------------------------------

	private async loadPersisted(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as PersistedData;
		this.settings = {
			...DEFAULT_SETTINGS,
			...data.settings,
			defaults: { ...DEFAULT_CONFIG, ...data.settings?.defaults },
		};
		this.expansionState = data.expansion ?? {};
	}

	async saveSettings(): Promise<void> {
		const data: PersistedData = { settings: this.settings, expansion: this.expansionState };
		await this.saveData(data);
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveSettings();
		}, 1000);
	}

	private forEachActiveController(checking: boolean, fn: (c: LookbackController) => void): boolean {
		const file = this.app.workspace.getActiveFile();
		if (!file) return false;
		const matching = Array.from(this.controllers).filter((c) => c.host === file.path);
		if (matching.length === 0) return false;
		if (!checking) matching.forEach(fn);
		return true;
	}
}
