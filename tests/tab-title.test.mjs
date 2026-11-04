import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { TabTitleGroup, cleanTitleLabel, tabGroupDirectory } from "../src/tab-title.ts";

const options = (root, onTitle, now) => ({ root, onTitle, now, intervalMs: 60_000,
	onError: error => { throw error; } });

test("title labels remove controls and grouping delimiters", () => {
	assert.equal(cleanTitleLabel("api\x1b[31m|[web]\x07"), "api web");
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
		assert.equal(firstTitle, "[1▶cmd 2✓cmd]");
		assert.equal(secondTitle, firstTitle);
		await isolated.start("another-tab", "other", "idle");
		assert.equal(isolatedTitle, "[1○other]");
		await Promise.all([first.update("error", "api"), second.update("aborted", "web")]);
		await Promise.all([first.refresh(), second.refresh()]);
		assert.equal(firstTitle, "[1✗api 2■web]");
		assert.equal(secondTitle, firstTitle);
		const directory = tabGroupDirectory("work", root);
		await writeFile(join(directory, "aaaa.json"), "not-json");
		await first.refresh(); assert.equal(firstTitle, "[1✗api 2■web]");
		now += 16_000;
		await first.refresh(); assert.equal(firstTitle, "[1✗api]");
		await second.refresh(); await first.refresh();
		assert.equal(firstTitle, "[1✗api 2■web]");
		await second.stop(); await first.refresh(); assert.equal(firstTitle, "[1✗api]");
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
  const a=start("cmd","running"); await until(()=>a.messages.some(m=>m.title==="[1▶cmd]"));
  const b=start("cmd","done");
  await until(()=>[a,b].every(p=>p.messages.some(m=>m.title==="[1▶cmd 2✓cmd]")));
  const bExit=new Promise(resolve=>b.child.once("exit",resolve)); b.child.send("stop"); await bExit;
  const count=a.messages.length;
  await until(()=>a.messages.slice(count).some(m=>m.title==="[1▶cmd]"));
  assert.ok([a,b].every(p=>!p.messages.some(m=>m.error)));
 } finally {
  await Promise.all(children.map(child=>new Promise(resolve=>{
   if(child.exitCode!==null){resolve();return;} child.once("exit",resolve); child.kill();
  })));
  await rm(root,{recursive:true,force:true});
 }
});
