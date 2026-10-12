/**
 * The editor used while gercep is on: Pi's own CustomEditor, with the top
 * border repainted in a flashing bright color whenever the Working indicator
 * is embedded in it. Everything else (input, keybindings, autocomplete) is the
 * stock editor.
 */

import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { type ColorMode, detectColorMode, FLASH_INTERVAL_MS, flashPhase, paintLine } from "./flash.ts";

export class GercepEditor extends CustomEditor {
	private readonly flashTui: TUI;
	private readonly colorMode: ColorMode;
	private hasIndicator = false;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, colorMode: ColorMode = detectColorMode()) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.flashTui = tui;
		this.colorMode = colorMode;
	}

	override setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
		super.setWorkingStatusIndicator(indicator);
		this.hasIndicator = indicator !== undefined;
		if (this.hasIndicator) this.startFlashing();
		else this.stopFlashing();
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const line = super.renderTopBorder(width, hiddenLineCount);
		if (!this.hasIndicator) return line;
		return paintLine(line, flashPhase(Date.now()), this.colorMode);
	}

	/** Stop the timer; called when gercep turns off and this editor is replaced. */
	dispose(): void {
		this.stopFlashing();
	}

	private startFlashing(): void {
		if (this.timer !== undefined) return;
		// The spinner already re-renders every 80 ms, but a dedicated tick keeps the
		// flash at its own pace even with a slow or hidden spinner.
		this.timer = setInterval(() => this.flashTui.requestRender(), FLASH_INTERVAL_MS);
		(this.timer as { unref?: () => void }).unref?.();
	}

	private stopFlashing(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
		this.flashTui.requestRender();
	}
}
