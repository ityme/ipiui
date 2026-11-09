import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export type TabStatus = "idle" | "running" | "done" | "error" | "aborted";
interface PaneRecord {
	version: 1;
	id: string;
	started: number;
	updated: number;
	label: string;
	status: TabStatus;
}
const TAB_STATUSES: Set<string> = new Set<TabStatus>(["idle", "running", "done", "error", "aborted"]);
const BRAILLE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function cleanTitleLabel(text: string): string {
	// Reject escape/control sequences and delimiters that could forge other members.
	return [...text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f\[\]|┃⣿⠿]/g, " ").replace(/\s+/g, " ").trim()].slice(0, 20).join("") || "cmd";
}

export function tabGroupDirectory(group: string, root?: string): string {
	const user = createHash("sha256").update(userInfo().username).digest("hex").slice(0, 16);
	return join(root ?? join(tmpdir(), `ipiui-tabs-${user}`), createHash("sha256").update(group).digest("hex"));
}

function prepareRecords(records: PaneRecord[]): PaneRecord[] {
	return [...records].sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))
		.map(record => ({ ...record, label: cleanTitleLabel(record.label) }));
}

function formatPreparedTitle(records: PaneRecord[], now: number): string {
	const spinner = BRAILLE_SPINNER[Math.floor(now / 100) % BRAILLE_SPINNER.length];
	return records.map(record => `${record.status === "running" ? spinner : ""}${record.label}`).join(" ┃ ");
}

export function formatTabTitle(records: PaneRecord[], now: number = Date.now()): string {
	return formatPreparedTitle(prepareRecords(records), now);
}

interface TitleGroupOptions {
	root?: string;
	intervalMs?: number;
	staleMs?: number;
	now?: () => number;
	onTitle: (title: string, hasRunning: boolean) => void;
	onError: (error: unknown) => void;
}

/** Each member only writes its own record; peers read complete atomic snapshots. */
export class TabTitleGroup {
	private readonly id = randomUUID();
	private started = 0;
	private readonly now: () => number;
	private readonly staleMs: number;
	private directory?: string;
	private file?: string;
	private label = "cmd";
	private status: TabStatus = "idle";
	private timer?: ReturnType<typeof setInterval>;
	private animationTimer?: ReturnType<typeof setInterval>;
	private records: PaneRecord[] = [];
	private lastTitle?: string;
	private lastHasRunning?: boolean;
	private refreshing = false;
	private refreshRequested = false;
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private reportedError = false;
	private failures = 0;
	private retryAt = 0;

	private readonly options: TitleGroupOptions;

	constructor(options: TitleGroupOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.staleMs = options.staleMs ?? 15_000;
	}

	async start(group: string, label: string, status: TabStatus): Promise<void> {
		if (!group.trim() || group.length > 64 || /[\x00-\x1f\x7f]/.test(group)) {
			throw new Error("Group must be 1–64 characters with no control characters");
		}
		if (this.file || this.closed) throw new Error("Create a new title group member when joining another group");
		this.started = this.now();
		this.directory = tabGroupDirectory(group, this.options.root);
		this.file = join(this.directory, `${this.id}.json`);
		this.label = cleanTitleLabel(label);
		this.status = status;
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await this.refresh();
		if (this.closed) return;
		if (this.failures > 0) throw new Error("Title group storage is unavailable");
		this.timer = setInterval(() => { void this.refresh(); }, this.options.intervalMs ?? 1000);
		this.timer.unref();
	}

	update(status: TabStatus, label = this.label): Promise<void> {
		this.status = status;
		this.label = cleanTitleLabel(label);
		return this.refresh();
	}

	refresh(): Promise<void> {
		if (this.closed || this.now() < this.retryAt) return Promise.resolve();
		this.refreshRequested = true;
		if (this.refreshing) return this.queue;
		this.refreshing = true;
		let operation = "write";
		this.queue = Promise.resolve().then(async () => {
			while (this.refreshRequested && !this.closed && this.file && this.directory) {
				this.refreshRequested = false;
				const now = this.now();
				const record: PaneRecord = {
					version: 1, id: this.id, started: this.started, updated: now, label: this.label, status: this.status,
				};
				const temporary = this.file + ".tmp";
				operation = "write";
				try {
					await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					operation = "recreate directory";
					await mkdir(this.directory, { recursive: true, mode: 0o700 });
					operation = "write";
					await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
				}
				operation = "replace record";
				await rename(temporary, this.file);
				operation = "read group";
				const names = (await readdir(this.directory)).filter(name => /^[a-f0-9-]+\.json$/.test(name));
				const records = await Promise.all(names.map(async name => {
					try {
						const content = await readFile(join(this.directory!, name), "utf8");
						if (content.length > 4096) return;
						const value: unknown = JSON.parse(content);
						if (!this.isLiveRecord(value, now) || name !== `${value.id}.json`) return;
						return value;
					} catch { return; } // A peer can leave while the directory is being read.
				}));
				this.records = prepareRecords(records.filter((value): value is PaneRecord => !!value));
				operation = "publish title";
				if (!this.closed) this.publishTitle();
				this.failures = 0;
				this.retryAt = 0;
				this.reportedError = false;
			}
		}).catch(error => {
			if (this.closed) return;
			this.refreshRequested = false;
			this.failures++;
			this.retryAt = this.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5));
			if (this.failures >= 3 && !this.reportedError) {
				this.reportedError = true;
				const rawCode = (error as NodeJS.ErrnoException | null)?.code;
				const code = typeof rawCode === "string" && /^[A-Z0-9_]+$/.test(rawCode) ? rawCode : "UNKNOWN";
				// Do not include filesystem paths or provider error text in user-facing diagnostics.
				this.options.onError(new Error(`${operation}: ${code}; retrying automatically`));
			}
		}).finally(() => { this.refreshing = false; });
		return this.queue;
	}

	private publishTitle(): void {
		if (this.closed) return;
		const now = this.now();
		const liveRecords = this.records.filter(record => this.isLiveRecord(record, now));
		const hasRunning = liveRecords.some(record => record.status === "running");
		if (hasRunning && !this.animationTimer) {
			// Animate cached peer snapshots; disk synchronization stays at heartbeat frequency.
			this.animationTimer = setInterval(() => this.publishTitle(), 100);
			this.animationTimer.unref();
		} else if (!hasRunning && this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
		const title = formatPreparedTitle(liveRecords, now);
		if (title !== this.lastTitle || hasRunning !== this.lastHasRunning) {
			this.lastTitle = title;
			this.lastHasRunning = hasRunning;
			this.options.onTitle(title, hasRunning);
		}
	}

	async stop(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.animationTimer) clearInterval(this.animationTimer);
		this.animationTimer = undefined;
		this.records = [];
		await this.queue;
		if (this.file) {
			// Only delete this member's two files, never peer records or the shared directory.
			await Promise.all([this.file, this.file + ".tmp"].map(file => rm(file, { force: true })));
		}
	}

	private isLiveRecord(value: unknown, now: number): value is PaneRecord {
		if (!value || typeof value !== "object") return false;
		const record = value as Partial<PaneRecord>;
		return record.version === 1 && typeof record.id === "string" && /^[a-f0-9-]{36}$/.test(record.id)
			&& typeof record.started === "number" && Number.isFinite(record.started)
			&& typeof record.updated === "number" && record.updated <= now + this.staleMs
			&& now - record.updated <= this.staleMs && typeof record.label === "string" && record.label.length <= 80
			&& typeof record.status === "string" && TAB_STATUSES.has(record.status);
	}
}
