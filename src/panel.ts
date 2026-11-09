import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export async function selectPanel(ctx: ExtensionContext, title: string, items: SelectItem[], hint: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let narrow = false;
		const columnWidth = Math.max(...items.map(item => visibleWidth(item.label))) + 3;
		const list = new SelectList(items, items.length, {
			selectedPrefix: text => theme.fg("accent", text),
			selectedText: text => theme.fg("accent", text),
			description: text => theme.fg("muted", text),
			scrollInfo: text => theme.fg("dim", text),
			noMatch: text => theme.fg("muted", text),
		}, {
			minPrimaryColumnWidth: columnWidth,
			maxPrimaryColumnWidth: columnWidth,
			truncatePrimary: ({ text, maxWidth, item }) => truncateToWidth(narrow && item.description ? `${text}  ${item.description}` : text, maxWidth, ""),
		});
		list.onSelect = item => done(item.value);
		list.onCancel = () => done(undefined);
		return {
			capturesViewportInput: list.capturesViewportInput,
			render(width: number) {
				// SelectList omits descriptions in narrow layouts; keep values visible there.
				narrow = width <= 40;
				return [truncateToWidth(theme.fg("accent", title), width), "", ...list.render(width), "", truncateToWidth(theme.fg("dim", hint), width)];
			},
			invalidate: () => list.invalidate(),
			handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
		};
	}, { blocked: { kind: "question", message: title } });
}
