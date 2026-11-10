import { cleanTitleLabel, formatTabTitle, type PaneRecord } from "./tab-title.ts";

interface TitleIndicatorOptions {
	onTitle: (title: string) => void;
	now?: () => number;
}

/** Owns terminal title presentation; never accesses the filesystem. */
export class TitleIndicator {
	private enabled = true;
	private shared = false;
	private records: PaneRecord[] = [];
	private animationTimer?: ReturnType<typeof setInterval>;
	private heartbeat?: ReturnType<typeof setInterval>;
	private lastTitle?: string;
	private closed = false;

	private readonly options: TitleIndicatorOptions;
	constructor(options: TitleIndicatorOptions) { this.options = options; }

	update(records: PaneRecord[], shared: boolean, enabled: boolean): void {
		if (this.closed) return;
		this.records = records;
		this.shared = shared;
		this.enabled = enabled;
		const managed = shared || enabled;
		const animating = managed && enabled && records.some(record => record.status === "running");
		if (animating && !this.animationTimer) {
			this.animationTimer = setInterval(() => this.publish(), 100);
			this.animationTimer.unref();
		} else if (!animating && this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
		if (managed && !this.heartbeat) {
			this.heartbeat = setInterval(() => this.publish(true), 1500);
			this.heartbeat.unref();
		} else if (!managed && this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
		this.publish();
	}

	private publish(force = false): void {
		if (this.closed) return;
		const now = (this.options.now ?? Date.now)();
		const records = this.records.filter(record => !this.shared || now - record.updated <= 15_000)
			.map(record => ({ ...record, label: cleanTitleLabel(record.label) }));
		if (!records.some(record => record.status === "running") && this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
		const title = this.shared || this.enabled
			? formatTabTitle(records, now, this.enabled)
			: "pi";
		if (force || title !== this.lastTitle) {
			this.lastTitle = title;
			this.options.onTitle(title);
		}
	}

	stop(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.animationTimer) clearInterval(this.animationTimer);
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.animationTimer = this.heartbeat = undefined;
		this.records = [];
		if (this.lastTitle !== undefined && this.lastTitle !== "pi") this.options.onTitle("pi");
	}
}
