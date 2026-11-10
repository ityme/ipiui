import assert from "node:assert/strict";
import test from "node:test";
import { TitleIndicator } from "../src/title-indicator.ts";

const record = (label, status, now, id = label) => ({ version: 1, id, label, status, started: 0, updated: now });

test("title indicator is independent from grouping, animates in memory and releases timers", () => {
	const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
	const timers = new Map(), titles = [];
	globalThis.setInterval = (callback, delay) => { const handle = { unref() {} }; timers.set(handle, { callback, delay }); return handle; };
	globalThis.clearInterval = handle => timers.delete(handle);
	let now = 1000;
	const indicator = new TitleIndicator({ now: () => now, onTitle: title => titles.push(title) });
	try {
		indicator.update([record("local", "idle", now)], false, true);
		assert.equal(titles.at(-1), "local");
		assert.equal(timers.size, 1);
		indicator.update([record("local", "running", now)], false, true);
		assert.equal(titles.at(-1), "⠋local");
		const tick = [...timers.values()].find(timer => timer.delay === 100);
		now += 100; tick.callback();
		assert.equal(titles.at(-1), "⠙local");
		indicator.update([record("local", "done", now)], false, true);
		assert.equal(titles.at(-1), "local");
		assert.equal(timers.size, 1);
		indicator.update([record("local", "running", now)], false, false);
		assert.equal(titles.at(-1), "pi");
		assert.equal(timers.size, 0);
		const peers = [record("local", "idle", now), { ...record("peer", "running", now), started: 1 }];
		indicator.update(peers, true, false);
		assert.equal(titles.at(-1), "local ┃ peer");
		assert.equal(timers.size, 1);
		indicator.update(peers, true, true);
		assert.equal(titles.at(-1), "local ┃ ⠙peer");
		assert.equal(timers.size, 2);
		now += 16_000;
		[...timers.values()].find(timer => timer.delay === 100).callback();
		assert.equal(titles.at(-1), "");
		assert.equal(timers.size, 1, "Expired running peers stop high-frequency animation");
		indicator.stop();
		assert.equal(timers.size, 0);
		assert.equal(titles.at(-1), "pi");
		const count = titles.length;
		indicator.stop();
		tick.callback();
		assert.equal(titles.length, count);
	} finally {
		indicator.stop();
		globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear;
	}
});
