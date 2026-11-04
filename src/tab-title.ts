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
const SYMBOLS: Record<TabStatus, string> = {
	idle: "○", running: "▶", done: "✓", error: "✗", aborted: "■",
};

export function cleanTitleLabel(text: string): string {
	// Reject escape/control sequences and delimiters that could forge other members.
	return [...text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f\[\]|]/g, " ").replace(/\s+/g, " ").trim()].slice(0, 20).join("") || "cmd";
}

export function tabGroupDirectory(group: string, root?: string): string {
	const user = createHash("sha256").update(userInfo().username).digest("hex").slice(0, 16);
	return join(root ?? join(tmpdir(), `ipiui-tabs-${user}`), createHash("sha256").update(group).digest("hex"));
}

export function formatTabTitle(records: PaneRecord[]): string {
	return "[" + [...records].sort((a, b) => a.started - b.started || a.id.localeCompare(b.id))
		.map((record, index) => `${index + 1}${SYMBOLS[record.status]}${cleanTitleLabel(record.label)}`).join(" ") + "]";
}

interface TitleGroupOptions {
	root?: string;
	intervalMs?: number;
	staleMs?: number;
	now?: () => number;
	onTitle: (title: string) => void;
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
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private reportedError = false;

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
		if (this.reportedError) throw new Error("Title group storage is unavailable");
		this.timer = setInterval(() => { void this.refresh(); }, this.options.intervalMs ?? 1000);
		this.timer.unref();
	}

	update(status: TabStatus, label = this.label): Promise<void> {
		this.status = status;
		this.label = cleanTitleLabel(label);
		return this.refresh();
	}

	refresh(): Promise<void> {
		this.queue = this.queue.then(async () => {
			if (this.closed || !this.file || !this.directory) return;
			const now = this.now();
			const record: PaneRecord = {
				version: 1, id: this.id, started: this.started, updated: now, label: this.label, status: this.status,
			};
			const temporary = this.file + ".tmp";
			await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
			await rename(temporary, this.file);
			const names = (await readdir(this.directory)).filter(name => /^[a-f0-9-]+\.json$/.test(name)).slice(0, 100);
			const records = await Promise.all(names.map(async name => {
				try {
					const content = await readFile(join(this.directory!, name), "utf8");
					if (content.length > 4096) return;
					const value: unknown = JSON.parse(content);
					if (!this.isLiveRecord(value, now) || name !== `${value.id}.json`) return;
					return value;
				} catch { return; } // A peer can leave while the directory is being read.
			}));
			if (!this.closed) this.options.onTitle(formatTabTitle(records.filter((value): value is PaneRecord => !!value)));
		}).catch(error => {
			if (!this.closed && !this.reportedError) {
				this.reportedError = true;
				this.options.onError(error);
			}
		});
		return this.queue;
	}

	async stop(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
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
			&& typeof record.status === "string" && Object.hasOwn(SYMBOLS, record.status);
	}
}
