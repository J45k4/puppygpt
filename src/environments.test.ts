import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { EnvironmentStore } from "./environments"
import type { DockerControl, ExecutionPolicy } from "./agent/execution-targets"
const policy: ExecutionPolicy = { defaultTarget: "docker", targets: [{ id: "docker", kind: "docker", image: "test:local", workspaceRoot: "/tmp" }, { id: "host", kind: "host" }] }
test("independent environment records survive manager recreation and explicit stop/start reuses container", async () => {
 const db=new Database(":memory:"); let running=false, creates=0; let envId=""; const actions:string[]=[]
 const control:DockerControl=async (_s,args)=>{ actions.push(args[0]!); if(args[0]==="create"){creates++; envId=args[args.indexOf("--label")+1]!.split("=")[1]!;return "container-1"} if(args[0]==="start")running=true;if(args[0]==="stop")running=false;if(args[0]==="inspect")return JSON.stringify({Config:{Labels:{"puppygpt.environment":envId}},State:{Running:running}});return "" }
 let store=new EnvironmentStore(db,policy,control)
 const e=store.create("Shared", "docker")
 expect(e.status).toBe("stopped")
 await store.action(e.id,"start")
 const handle=store.get(e.id)!.handle
 store=new EnvironmentStore(db,policy,control)
 expect((await store.reconcile(e.id)).status).toBe("ready")
 expect(store.get(e.id)!.handle).toEqual(handle)
 await store.action(e.id,"stop"); expect(store.get(e.id)!.status).toBe("stopped")
 await store.action(e.id,"start");expect(creates).toBe(1)
 await store.action(e.id,"delete");expect(store.get(e.id)).toBeUndefined();expect(actions.at(-1)).toBe("rm")
 db.close()
})
test("missing or foreign containers are not silently recreated or controlled", async ()=>{
 const db=new Database(":memory:");let foreign=false;let mutations=0
 const control:DockerControl=async(_s,args)=>{if(args[0]==="inspect"){if(foreign)return JSON.stringify({Config:{Labels:{}},State:{Running:true}});throw new Error("No such container")}mutations++;return "id"}
 const store=new EnvironmentStore(db,policy,control);const e=store.create("Missing","docker")
 db.query("UPDATE execution_environments SET data=? WHERE id=?").run(JSON.stringify({...e,handle:{containerId:"gone"}}),e.id)
 expect((await store.reconcile(e.id)).status).toBe("missing")
 await expect(store.action(e.id,"start")).rejects.toThrow("missing")
 expect(mutations).toBe(0)
 foreign=true
 expect((await store.reconcile(e.id)).status).toBe("unavailable")
 await expect(store.action(e.id,"delete")).rejects.toThrow("verify")
 expect(mutations).toBe(0);db.close()
})

test("startup loads saved execution templates unchanged and honors an explicit override", async () => {
 const { loadExecutionPolicy, defaultDockerPolicy } = await import("./agent/execution-targets")
 const { mkdtemp, rm } = await import("node:fs/promises")
 const directory = await mkdtemp("/tmp/puppygpt-policy-")
 try {
  expect(await loadExecutionPolicy(directory, directory)).toEqual(defaultDockerPolicy(directory))
  const saved: ExecutionPolicy = { defaultTarget: "host", targets: [{ id: "host", kind: "host", maxTimeoutMs: 120000 }] }
  await Bun.write(`${directory}/execution.json`, JSON.stringify(saved))
  expect(await loadExecutionPolicy(directory, directory)).toEqual(saved)
  await Bun.write(`${directory}/override.json`, JSON.stringify(policy))
  expect(await loadExecutionPolicy(directory, directory, `${directory}/override.json`)).toEqual(policy)
  await Bun.write(`${directory}/execution.json`, "broken")
  await expect(loadExecutionPolicy(directory, directory)).rejects.toThrow()
 } finally { await rm(directory, { recursive: true, force: true }) }
})

test("chat names use the first free index, including stopped and differently cased names", () => {
 const db = new Database(":memory:")
 let store = new EnvironmentStore(db, policy)
 store.create("CHAT-1", "docker")
 store.create("chat-3", "docker")
 const second = store.createForChat("docker", "owner-2")
 expect(second.name).toBe("chat-2")
 expect(second.ownerChatId).toBe("owner-2")
 store = new EnvironmentStore(db, policy)
 expect(store.createForChat("docker", "owner-4").name).toBe("chat-4")
 expect(store.get(second.id)?.name).toBe("chat-2")
 db.close()
})

async function cleanupFixture() {
 const db = new Database(":memory:"); const operations: string[][] = []; let running = false; let label = ""; let creates = 0
 const control: DockerControl = async (_socket,args) => {
  operations.push(args)
  if(args[0] === "create") { label=args[args.indexOf("--label")+1]!.split("=")[1]!; return `container-${++creates}` }
  if(args[0] === "start") running=true
  if(args[0] === "stop") running=false
  if(args[0] === "inspect") return JSON.stringify({Config:{Labels:{"puppygpt.environment":label}},State:{Running:running}})
  return ""
 }
 const store = new EnvironmentStore(db,policy,control), e=store.create("Cleanup test","docker","chat-owner"), now=Date.now()
 await store.action(e.id,"start",{now})
 return {db,store,e,now,operations,control,setRunning:(value:boolean)=>{running=value}}
}

test("idle cleanup stops, warns, expires and recreates without losing environment identity",async()=>{
 const {ENV_IDLE_MS,ENV_AUTO_DESTROY_MS}=await import("./environments")
 const f=await cleanupFixture();const notices:string[]=[];const notify=(_e:unknown,text:string)=>{notices.push(text)}
 try {
  await f.store.reap(f.now+ENV_IDLE_MS-1,notify);expect(f.store.get(f.e.id)!.status).toBe("ready")
  await f.store.reap(f.now+ENV_IDLE_MS,notify);expect(f.store.get(f.e.id)!.stopReason).toBe("auto")
  const stopped=Date.parse(f.store.get(f.e.id)!.stoppedAt!)
  await f.store.reap(stopped+ENV_AUTO_DESTROY_MS-3600000,notify)
  await f.store.reap(stopped+ENV_AUTO_DESTROY_MS-1800000,notify)
  expect(notices).toHaveLength(2)
  await f.store.reap(stopped+ENV_AUTO_DESTROY_MS,notify)
  expect(f.store.get(f.e.id)!.handle).toBeUndefined();expect(f.store.get(f.e.id)!.destroyedAt).toBeTruthy()
  expect(f.operations.find(args=>args[0]==="rm")).toEqual(["rm","--volumes","container-1"])
  await f.store.action(f.e.id,"start")
  expect(f.store.get(f.e.id)!.handle!.containerId).toBe("container-2")
  expect(f.store.get(f.e.id)!.ownerChatId).toBe("chat-owner")
  expect(f.store.get(f.e.id)!.destroyedAt).toBeUndefined()
 } finally {f.db.close()}
})

test("manual stop gets seven days; pinning and active chats prevent cleanup",async()=>{
 const {ENV_IDLE_MS,ENV_MANUAL_DESTROY_MS}=await import("./environments")
 const f=await cleanupFixture()
 try {
  f.store.setUsageGuard(()=>true);await f.store.reap(f.now+ENV_IDLE_MS);expect(f.store.get(f.e.id)!.status).toBe("ready")
  f.store.setUsageGuard(()=>false);f.store.setCleanup(f.e.id,false)
  await f.store.reap(f.now+ENV_IDLE_MS);expect(f.store.get(f.e.id)!.status).toBe("ready")
  f.store.setCleanup(f.e.id,true,f.now)
  await f.store.action(f.e.id,"stop",{now:f.now})
  await f.store.reap(f.now+ENV_MANUAL_DESTROY_MS-1);expect(f.store.get(f.e.id)!.handle).toBeTruthy()
  await f.store.reap(f.now+ENV_MANUAL_DESTROY_MS);expect(f.store.get(f.e.id)!.handle).toBeUndefined()
 } finally {f.db.close()}
})

test("legacy grace is applied once and external restarts cancel expiry",async()=>{
 const f=await cleanupFixture()
 try {
  const old={...f.store.get(f.e.id)!};delete old.cleanupEnabled;old.lastUsedAt="2000-01-01T00:00:00Z"
  f.db.query("UPDATE execution_environments SET data=? WHERE id=?").run(JSON.stringify(old),old.id)
  f.store.initializeCleanup(f.now);expect(f.store.get(old.id)!.lastUsedAt).toBe(new Date(f.now).toISOString())
  f.store.initializeCleanup(f.now+1000);expect(f.store.get(old.id)!.lastUsedAt).toBe(new Date(f.now).toISOString())
  await f.store.action(old.id,"stop",{now:f.now})
  f.setRunning(true)
  await expect(f.store.action(old.id,"expire",{automatic:true})).rejects.toThrow("verified stopped")
  expect(f.operations.some(args=>args[0]==="rm")).toBeFalse()
 } finally {f.db.close()}
})

test("table cleanup deadlines reflect running, stopped, pinned and active states",async()=>{
 const {ENV_IDLE_MS,ENV_AUTO_DESTROY_MS,ENV_MANUAL_DESTROY_MS}=await import("./environments")
 const f=await cleanupFixture()
 try {
  expect(f.store.cleanupTiming(f.store.get(f.e.id)!).autoStopAt).toBe(new Date(f.now+ENV_IDLE_MS).toISOString())
  f.store.setUsageGuard(()=>true)
  expect(f.store.cleanupTiming(f.store.get(f.e.id)!).cleanupPaused).toBeTrue()
  f.store.setUsageGuard(()=>false)
  await f.store.action(f.e.id,"stop",{now:f.now,automatic:true})
  expect(f.store.cleanupTiming(f.store.get(f.e.id)!).destroyAt).toBe(new Date(f.now+ENV_AUTO_DESTROY_MS).toISOString())
  await f.store.action(f.e.id,"stop",{now:f.now})
  expect(f.store.cleanupTiming(f.store.get(f.e.id)!).destroyAt).toBe(new Date(f.now+ENV_MANUAL_DESTROY_MS).toISOString())
  f.store.setCleanup(f.e.id,false)
  expect(f.store.cleanupTiming(f.store.get(f.e.id)!).destroyAt).toBeUndefined()
 } finally {f.db.close()}
})

test("auto-stop switch persists, resets idle grace, and does not disable stopped-container expiry",async()=>{
 const {ENV_IDLE_MS,ENV_MANUAL_DESTROY_MS}=await import("./environments")
 const f=await cleanupFixture()
 try {
  f.store.setAutoStop(f.e.id,false)
  const restored=new EnvironmentStore(f.db,policy,f.control)
  expect(restored.get(f.e.id)!.autoStopEnabled).toBeFalse()
  await restored.reap(f.now+ENV_IDLE_MS+1)
  expect(restored.get(f.e.id)!.status).toBe("ready")
  expect(restored.cleanupTiming(restored.get(f.e.id)!).autoStopAt).toBeUndefined()
  restored.setAutoStop(f.e.id,true,f.now+ENV_IDLE_MS)
  await restored.reap(f.now+ENV_IDLE_MS+1)
  expect(restored.get(f.e.id)!.status).toBe("ready")
  restored.setAutoStop(f.e.id,false)
  await restored.action(f.e.id,"stop",{now:f.now})
  await restored.reap(f.now+ENV_MANUAL_DESTROY_MS)
  expect(restored.get(f.e.id)!.handle).toBeUndefined()
 }finally{f.db.close()}
})
