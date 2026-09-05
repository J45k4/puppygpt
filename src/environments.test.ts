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
