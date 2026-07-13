import {
	Keymap,
	MarkdownRenderChild,
	MarkdownRenderer,
	TFile,
	setIcon,
	setTooltip,
} from "obsidian";
import { HeadingInfo, LookbackConfig, LookbackTarget, labelFor, sliceSection } from "./engine";
import type DailyNoteLookbackPlugin from "./main";

export interface ResolvedRow {
	target: LookbackTarget;
	file: TFile | null;
	/** Display name for the note link (vault-formatted date). */
	displayName: string;
}

/**
 * One rendered lookback block. Collapsed rows cost zero file reads; a row's
 * content loads on first expansion (or hover preview) via cachedRead.
 */
export class LookbackController extends MarkdownRenderChild {
	private plugin: DailyNoteLookbackPlugin;
	private cfg: LookbackConfig;
	private hostPath: string;
	private rows: ResolvedRow[];
	private rowEls = new Map<string, { contentEl: HTMLDivElement; chevronEl: HTMLSpanElement; loaded: boolean; expanded: boolean }>();
	private popoverEl: HTMLDivElement | null = null;
	private hoverTimer: number | null = null;

	constructor(
		plugin: DailyNoteLookbackPlugin,
		containerEl: HTMLElement,
		cfg: LookbackConfig,
		hostPath: string,
		rows: ResolvedRow[]
	) {
		super(containerEl);
		this.plugin = plugin;
		this.cfg = cfg;
		this.hostPath = hostPath;
		this.rows = rows;
	}

	onload(): void {
		this.plugin.controllers.add(this);
		this.render();
	}

	onunload(): void {
		this.plugin.controllers.delete(this);
		this.hidePopover();
	}

	get host(): string {
		return this.hostPath;
	}

	private render(): void {
		const root = this.containerEl.createDiv({ cls: "dnl-container" });

		const visible = this.rows.filter((r) => r.file !== null || this.cfg.missing === "show");
		const found = this.rows.filter((r) => r.file !== null).length;

		// Toolbar: count badge + expand/collapse-all.
		const bar = root.createDiv({ cls: "dnl-toolbar" });
		bar.createSpan({
			cls: "dnl-count",
			text: this.rows.length ? `${found} of ${this.rows.length}` : "",
		});
		const controls = bar.createDiv({ cls: "dnl-controls" });
		const expandBtn = controls.createSpan({ cls: "dnl-icon-btn" });
		setIcon(expandBtn, "chevrons-up-down");
		setTooltip(expandBtn, "Expand all");
		expandBtn.addEventListener("click", () => this.expandAll());
		const collapseBtn = controls.createSpan({ cls: "dnl-icon-btn" });
		setIcon(collapseBtn, "chevrons-down-up");
		setTooltip(collapseBtn, "Collapse all");
		collapseBtn.addEventListener("click", () => this.collapseAll());

		if (visible.length === 0) {
			root.createDiv({
				cls: "dnl-empty",
				text: this.rows.length === 0
					? "No lookback dates resolved — add every/since or offsets, or create earlier daily notes."
					: "No earlier notes exist for these dates yet.",
			});
			return;
		}

		for (const row of visible) {
			if (row.file) this.renderLiveRow(root, row, row.file);
			else this.renderMissingRow(root, row);
		}

		// Restore remembered expansion, or honor the expanded default.
		for (const row of visible) {
			if (!row.file) continue;
			const remembered = this.plugin.getRememberedExpansion(this.hostPath, row.target.iso);
			const shouldExpand = remembered ?? this.cfg.expanded;
			if (shouldExpand) void this.expandRow(row.target.iso);
		}
	}

	private renderLiveRow(root: HTMLDivElement, row: ResolvedRow, file: TFile): void {
		const label = labelFor(row.target);
		const rowEl = root.createDiv({ cls: "dnl-row" });

		const head = rowEl.createDiv({ cls: "dnl-row-head" });
		const chevron = head.createSpan({ cls: "dnl-chevron" });
		setIcon(chevron, "chevron-right");

		const headingEl = head.createEl(`h${this.cfg.heading}` as keyof HTMLElementTagNameMap, {
			cls: "dnl-heading",
			text: label.primary,
		}) as HTMLElement;

		head.createSpan({ cls: "dnl-caption", text: label.caption });
		head.createSpan({ cls: "dnl-dot dnl-dot-exists" });

		const link = head.createEl("a", { cls: "internal-link dnl-link", text: row.displayName });
		link.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			void this.plugin.app.workspace.openLinkText(file.path, this.hostPath, Keymap.isModEvent(evt));
		});
		link.addEventListener("mouseover", (evt) => {
			this.plugin.app.workspace.trigger("hover-link", {
				event: evt,
				source: "daily-note-lookback",
				hoverParent: this,
				targetEl: link,
				linktext: file.path,
				sourcePath: this.hostPath,
			});
		});

		const contentEl = rowEl.createDiv({ cls: "dnl-content" });
		contentEl.hide();

		this.rowEls.set(row.target.iso, { contentEl, chevronEl: chevron, loaded: false, expanded: false });

		const toggle = () => void this.toggleRow(row.target.iso);
		chevron.addEventListener("click", toggle);
		headingEl.addEventListener("click", toggle);

		// Optional hover preview on the collapsed row head.
		if (this.plugin.settings.hoverPreview) {
			head.addEventListener("mouseenter", (evt) => this.scheduleHoverPreview(evt, row, file));
			head.addEventListener("mouseleave", () => this.cancelHoverPreview());
		}
	}

	private renderMissingRow(root: HTMLDivElement, row: ResolvedRow): void {
		const label = labelFor(row.target);
		const rowEl = root.createDiv({ cls: "dnl-row dnl-row-missing" });
		const head = rowEl.createDiv({ cls: "dnl-row-head" });
		head.createSpan({ cls: "dnl-chevron dnl-chevron-hidden" });
		head.createEl(`h${this.cfg.heading}` as keyof HTMLElementTagNameMap, {
			cls: "dnl-heading dnl-heading-missing",
			text: label.primary,
		});
		head.createSpan({ cls: "dnl-caption", text: label.caption });
		head.createSpan({ cls: "dnl-dot" });
		head.createSpan({ cls: "dnl-missing-text", text: `${row.displayName} — no note` });
	}

	private async toggleRow(iso: string): Promise<void> {
		const entry = this.rowEls.get(iso);
		if (!entry) return;
		if (entry.expanded) this.collapseRow(iso);
		else await this.expandRow(iso);
	}

	async expandRow(iso: string): Promise<void> {
		const entry = this.rowEls.get(iso);
		const row = this.rows.find((r) => r.target.iso === iso);
		if (!entry || !row || !row.file) return;
		if (!entry.loaded) {
			await this.loadContent(entry.contentEl, row, row.file);
			entry.loaded = true;
		}
		entry.contentEl.show();
		entry.expanded = true;
		entry.chevronEl.addClass("dnl-chevron-open");
		this.plugin.rememberExpansion(this.hostPath, iso, true);
	}

	collapseRow(iso: string): void {
		const entry = this.rowEls.get(iso);
		if (!entry) return;
		entry.contentEl.hide();
		entry.expanded = false;
		entry.chevronEl.removeClass("dnl-chevron-open");
		this.plugin.rememberExpansion(this.hostPath, iso, false);
	}

	expandAll(): void {
		for (const iso of this.rowEls.keys()) void this.expandRow(iso);
	}

	collapseAll(): void {
		for (const iso of this.rowEls.keys()) this.collapseRow(iso);
	}

	/** Extract the configured sections (or the whole note) and render them. */
	private async loadContent(contentEl: HTMLDivElement, row: ResolvedRow, file: TFile): Promise<void> {
		contentEl.empty();

		// Corner control matching the native embed affordance: open the source note.
		const open = contentEl.createSpan({ cls: "dnl-open" });
		setIcon(open, "maximize-2");
		setTooltip(open, "Open note");
		open.addEventListener("click", (evt) => {
			void this.plugin.app.workspace.openLinkText(file.path, this.hostPath, Keymap.isModEvent(evt));
		});

		const body = contentEl.createDiv({ cls: "dnl-body" });
		const markdown = await this.extractMarkdown(row, file);
		if (markdown === null) {
			body.createDiv({ cls: "dnl-missing-text", text: this.missingSectionText() });
			return;
		}
		await MarkdownRenderer.render(this.plugin.app, markdown, body, file.path, this);
	}

	private missingSectionText(): string {
		const names = this.cfg.sections.map((s) => `"${s}"`).join(", ");
		return `No ${names} section in this note.`;
	}

	/** Build the markdown for a row: requested sections, or whole note minus frontmatter. */
	private async extractMarkdown(row: ResolvedRow, file: TFile): Promise<string | null> {
		const app = this.plugin.app;
		const content = await app.vault.cachedRead(file);
		const cache = app.metadataCache.getFileCache(file);

		if (this.cfg.sections.length === 0) {
			const fmEnd = cache?.frontmatterPosition?.end?.offset ?? 0;
			return content.slice(fmEnd).trim();
		}

		const headings: HeadingInfo[] = (cache?.headings ?? []).map((h) => ({
			text: h.heading,
			level: h.level,
			startOffset: h.position.start.offset,
			endOffset: h.position.end.offset,
		}));

		const parts: string[] = [];
		let anyFound = false;
		for (const section of this.cfg.sections) {
			const slice = sliceSection(content, headings, section, this.plugin.settings.strictHeadingMatch);
			if (slice !== null) {
				anyFound = true;
				parts.push(this.cfg.sections.length > 1 ? `**${section}**\n\n${slice}` : slice);
			} else if (this.cfg.sections.length > 1) {
				parts.push(`**${section}**\n\n_(no such section)_`);
			}
		}
		return anyFound ? parts.join("\n\n") : null;
	}

	// --- hover preview -------------------------------------------------------

	private scheduleHoverPreview(evt: MouseEvent, row: ResolvedRow, file: TFile): void {
		this.cancelHoverPreview();
		this.hoverTimer = window.setTimeout(() => void this.showPopover(evt, row, file), 350);
	}

	private cancelHoverPreview(): void {
		if (this.hoverTimer !== null) {
			window.clearTimeout(this.hoverTimer);
			this.hoverTimer = null;
		}
		this.hidePopover();
	}

	private async showPopover(evt: MouseEvent, row: ResolvedRow, file: TFile): Promise<void> {
		this.hidePopover();
		const entry = this.rowEls.get(row.target.iso);
		if (entry?.expanded) return; // already visible in full
		const markdown = await this.extractMarkdown(row, file);
		if (markdown === null) return;

		const pop = document.body.createDiv({ cls: "dnl-popover" });
		pop.style.left = `${Math.min(evt.clientX + 12, window.innerWidth - 420)}px`;
		pop.style.top = `${Math.min(evt.clientY + 12, window.innerHeight - 220)}px`;
		await MarkdownRenderer.render(this.plugin.app, markdown, pop, file.path, this);
		this.popoverEl = pop;
	}

	private hidePopover(): void {
		if (this.popoverEl) {
			this.popoverEl.remove();
			this.popoverEl = null;
		}
	}
}
