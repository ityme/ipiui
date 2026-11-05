import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { TabTitleGroup, cleanTitleLabel, tabGroupDirectory } from "../src/tab-title.ts";

const options = (root, onTitle, now) => ({ root, onTitle, now, intervalMs: 60_000,
	onError: error => { throw error; } });

test("title labels remove controls and grouping delimiters", () => {
	assert.equal(cleanTitleLabel("api\x1b[31m|┃[web]\x07"), "api web");
	assert.equal(cleanTitleLabel("\x1b]0;forged\x07cmd"), "cmd");
	assert.equal(cleanTitleLabel(" "), "cmd");
	assert.equal([...cleanTitleLabel("😀".repeat(30))].length, 20);
});

test("two members aggregate, update, isolate groups, expire crashed peers, clean up", async () => {
	const root = await mkdtemp(join(tmpdir(), "ipiui-title-test-"));
	let now = 1000;
	let firstTitle, secondTitle, isolatedTitle;
	const errors = [];
	const opts = onTitle => ({ ...options(root, onTitle, () => now), onError: error => errors.push(error) });
	const first = new TabTitleGroup(opts(title => { firstTitle = title; }));
	const second = new TabTitleGroup(opts(title => { secondTitle = title; }));
	const isolated = new TabTitleGroup(opts(title => { isolatedTitle = title; }));
	try {
		await first.start("work", "cmd", "running");
		now++;
		await second.start("work", "cmd", "done");
		await first.refresh();
		assert.match(firstTitle, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]cmd ┃ cmd$/);
		assert.equal(secondTitle, firstTitle);
		await isolated.start("another-tab", "other", "idle");
		assert.equal(isolatedTitle, "other");
		await Promise.all([first.update("error", "api"), second.update("aborted", "web")]);
		await Promise.all([first.refresh(), second.refresh()]);
		assert.equal(firstTitle, "api ┃ web");
		assert.equal(secondTitle, firstTitle);
		const directory = tabGroupDirectory("work", root);
		await writeFile(join(directory, "aaaa.json"), "not-json");
		await first.refresh(); assert.equal(firstTitle, "api ┃ web");
		now += 16_000;
		await first.refresh(); assert.equal(firstTitle, "api");
		await second.refresh(); await first.refresh();
		assert.equal(firstTitle, "api ┃ web");
		await second.stop(); await first.refresh(); assert.equal(firstTitle, "api");
		await first.stop(); await first.stop();
		assert.equal((await readdir(directory)).filter(name => name.endsWith(".tmp")).length, 0);
		assert.deepEqual(errors, []);
	} finally {
		await Promise.all([first.stop(), second.stop(), isolated.stop()]);
		await rm(root, { recursive: true, force: true });
	}
});

test("group names cannot escape the registry and validation errors do not start a timer", async () => {
	const root = await mkdtemp(join(tmpdir(), "ipiui-title-test-"));
	const member = new TabTitleGroup(options(root, () => {}));
	try {
		const safe = tabGroupDirectory("../../outside", root);
		assert.ok(safe.startsWith(root));
		await assert.rejects(member.start("x\n", "cmd", "idle"));
		await assert.rejects(member.start("x".repeat(65), "cmd", "idle"));
	} finally { await member.stop(); await rm(root, { recursive: true, force: true }); }
});


test("concurrent refreshes coalesce and keep the latest status", async () => {
	const root = await mkdtemp(join(tmpdir(), "ipiui-refresh-test-"));
	let publications = 0, title;
	const member = new TabTitleGroup(options(root, value => { title = value; publications++; }));
	try {
		await member.start("work", "api", "idle");
		publications = 0;
		await Promise.all(Array.from({ length: 100 }, () => member.refresh()));
		assert.equal(publications, 1, "A burst of ticks should perform one disk refresh");
		await Promise.all([member.update("running"), member.update("done", "latest")]);
		assert.equal(title, "latest");
	} finally {
		await member.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("stale files cannot hide live peers beyond the first 100 filenames", async () => {
	const root = await mkdtemp(join(tmpdir(), "ipiui-stale-test-"));
	let title;
	const member = new TabTitleGroup(options(root, value => { title = value; }));
	try {
		await member.start("work", "api", "idle");
		const directory = tabGroupDirectory("work", root);
		await Promise.all(Array.from({ length: 101 }, (_, i) => writeFile(join(directory, `${String(i).padStart(8, "0")}.json`), "{}")));
		const peer = { version: 1, id: "ffffffff-ffff-ffff-ffff-ffffffffffff", started: Date.now(), updated: Date.now(), label: "peer", status: "idle" };
		await writeFile(join(directory, `${peer.id}.json`), JSON.stringify(peer));
		await member.refresh();
		assert.ok(title.includes("peer"), "Live peers must not be excluded by stale filenames");
	} finally {
		await member.stop();
		await rm(root, { recursive: true, force: true });
	}
});

test("independent Node processes exchange live title records", async () => {
 const root = await mkdtemp(join(tmpdir(), "ipiui-title-process-test-"));
 const moduleUrl = new URL("../src/tab-title.ts", import.meta.url).href;
 const script = `import { TabTitleGroup } from ${JSON.stringify(moduleUrl)};
 const member = new TabTitleGroup({root:process.env.IPIUI_TEST_ROOT, intervalMs:50,
 onTitle:title=>process.send({title}), onError:error=>process.send({error:String(error)})});
 process.on("message", async message=>{if(message==="stop"){await member.stop(); process.exit(0);}});
 await member.start("work", process.env.IPIUI_TEST_LABEL, process.env.IPIUI_TEST_STATUS);
 `;
 const children = [];
 const start = (label, status) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
   env:{...process.env, IPIUI_TEST_ROOT:root, IPIUI_TEST_LABEL:label, IPIUI_TEST_STATUS:status},
   stdio:["ignore","ignore","pipe","ipc"]
  });
  const messages=[]; child.on("message", message=>messages.push(message));
  children.push(child); return {child,messages};
 };
 const until = async predicate => {
  const limit=Date.now()+5000;
  while(!predicate()){if(Date.now()>limit) throw new Error("Timed out waiting for cross-process title");
   await new Promise(resolve=>setTimeout(resolve,20));}
 };
 try {
  const a=start("cmd","running"); await until(()=>a.messages.some(m=>/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]cmd$/.test(m.title)));
  const b=start("cmd","done");
  await until(()=>[a,b].every(p=>p.messages.some(m=>/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]cmd ┃ cmd$/.test(m.title))));
  const bExit=new Promise(resolve=>b.child.once("exit",resolve)); b.child.send("stop"); await bExit;
  const count=a.messages.length;
  await until(()=>a.messages.slice(count).some(m=>/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]cmd$/.test(m.title)));
  assert.ok([a,b].every(p=>!p.messages.some(m=>m.error)));
 } finally {
  await Promise.all(children.map(child=>new Promise(resolve=>{
   if(child.exitCode!==null){resolve();return;} child.once("exit",resolve); child.kill();
  })));
  await rm(root,{recursive:true,force:true});
 }
});
