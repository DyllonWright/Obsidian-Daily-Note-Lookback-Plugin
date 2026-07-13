import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_CONFIG, LookbackConfig, parseInterval, parseISO } from "./engine";
import type DailyNoteLookbackPlugin from "./main";

export interface LookbackSettings {
	/** Global defaults; any block key overrides these per note. */
	defaults: LookbackConfig;
	/** Show a section-preview popover when hovering a collapsed row. */
	hoverPreview: boolean;
	/** Persist which rows the user expanded, per host note. */
	rememberExpansion: boolean;
	/** Require the exact written heading (emphasis marks and case included). */
	strictHeadingMatch: boolean;
}

export const DEFAULT_SETTINGS: LookbackSettings = {
	defaults: { ...DEFAULT_CONFIG },
	hoverPreview: false,
	rememberExpansion: true,
	strictHeadingMatch: false,
};

export class LookbackSettingTab extends PluginSettingTab {
	plugin: DailyNoteLookbackPlugin;

	constructor(app: App, plugin: DailyNoteLookbackPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const d = this.plugin.settings.defaults;
		const save = () => this.plugin.saveSettings();

		new Setting(containerEl).setName("Block defaults").setHeading();
		containerEl.createEl("p", {
			text: "Every value below acts as the default for a lookback block; any key inside a block overrides it for that note.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Sections")
			.setDesc("Comma-separated heading names to extract, e.g. Daily Meditation, Dream Log. Leave empty to show the whole note on expand.")
			.addText((t) =>
				t.setPlaceholder("Daily Meditation").setValue(d.sections.join(", ")).onChange(async (v) => {
					d.sections = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Recurring interval")
			.setDesc("How far each step reaches back: 1y, 3m, 2w, 11d. Leave empty to disable the recurring series.")
			.addText((t) =>
				t.setPlaceholder("1y").setValue(d.every ?? "").onChange(async (v) => {
					const s = v.trim();
					d.every = s && parseInterval(s) ? s : null;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Since")
			.setDesc("Optional hard stop (YYYY-MM-DD). When empty, the series stops at your earliest daily note automatically.")
			.addText((t) =>
				t.setPlaceholder("2023-09-03").setValue(d.since ?? "").onChange(async (v) => {
					const s = v.trim();
					d.since = s && parseISO(s) ? s : null;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Extra offsets")
			.setDesc("Comma-separated one-off distances shown alongside the series, e.g. 1w, 1m, 3m.")
			.addText((t) =>
				t.setPlaceholder("1w, 1m").setValue(d.offsets.join(", ")).onChange(async (v) => {
					d.offsets = v.split(",").map((s) => s.trim()).filter((s) => parseInterval(s) !== null);
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Heading weight")
			.setDesc("The heading level rendered for each row label (1-6).")
			.addDropdown((dd) => {
				for (let i = 1; i <= 6; i++) dd.addOption(String(i), `h${i}`);
				dd.setValue(String(d.heading)).onChange(async (v) => {
					d.heading = Number(v);
					await save();
				});
			});

		new Setting(containerEl)
			.setName("Start expanded")
			.setDesc("Render rows already expanded instead of collapsed.")
			.addToggle((t) =>
				t.setValue(d.expanded).onChange(async (v) => {
					d.expanded = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Show missing dates")
			.setDesc("Keep a muted placeholder row for dates without a note; switch off to hide them.")
			.addToggle((t) =>
				t.setValue(d.missing === "show").onChange(async (v) => {
					d.missing = v ? "show" : "hide";
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Daily notes folder override")
			.setDesc("Leave empty to read the Daily Notes / Periodic Notes configuration automatically.")
			.addText((t) =>
				t.setPlaceholder("(auto)").setValue(d.folder ?? "").onChange(async (v) => {
					const s = v.trim().replace(/^\/+|\/+$/g, "");
					d.folder = s || null;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Date format override")
			.setDesc("Moment format for daily note names, e.g. YYYY-MM-DD-dddd. Leave empty for automatic discovery.")
			.addText((t) =>
				t.setPlaceholder("(auto)").setValue(d.format ?? "").onChange(async (v) => {
					d.format = v.trim() || null;
					await save();
				})
			);

		new Setting(containerEl).setName("Behavior").setHeading();

		new Setting(containerEl)
			.setName("Hover preview")
			.setDesc("Hovering a collapsed row pops up the extracted section without expanding it. Reads the file only on hover.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.hoverPreview).onChange(async (v) => {
					this.plugin.settings.hoverPreview = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Remember expansion state")
			.setDesc("Rows you expand stay expanded the next time the note opens (per note, most recent 200 notes).")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.rememberExpansion).onChange(async (v) => {
					this.plugin.settings.rememberExpansion = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Strict heading match")
			.setDesc("Require the exact written heading. When off, _Daily Meditation_ matches Daily Meditation regardless of emphasis marks or case.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.strictHeadingMatch).onChange(async (v) => {
					this.plugin.settings.strictHeadingMatch = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Forget expansion state")
			.setDesc("Clear every remembered expand/collapse choice.")
			.addButton((b) =>
				b.setButtonText("Clear").onClick(async () => {
					this.plugin.expansionState = {};
					await this.plugin.saveSettings();
				})
			);
	}
}
