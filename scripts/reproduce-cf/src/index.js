// p360-reproduce — rerun the Patient 360 E2E from a fresh GitHub clone on Cloudflare Containers.
//
// Where it runs: a Durable Object (`Reproducer`) starts one Cloudflare Container
// (durable_object scheduling policy, Cloudflare-managed image `cloudflare/debian-trixie`,
// Node 24) with Internet access. No local Docker is needed. Inside the container the job:
//   apt-get install git → git clone https://github.com/zaycruz/coach-console (fresh, depth 1)
//   → npm ci → npx playwright install --with-deps chromium
//   → node e2e/live.mjs https://patient-360.raava.dev
//
// How to run (from scripts/reproduce-cf/, never from the repo root, which deploys patient-360):
//   npm install
//   npx wrangler deploy
//   echo "<any long random string>" | npx wrangler secret put RUN_TOKEN
//   RUN_TOKEN=<same string> URL=https://p360-reproduce.<your-subdomain>.workers.dev sh run.sh
//   npx wrangler delete p360-reproduce
//   npx wrangler containers list; npx wrangler containers delete <id of p360-reproduce-reproducer>
//     (deleting the Worker can leave the container application, with a live instance, behind)
//
// HTTP API (all need header `authorization: Bearer $RUN_TOKEN`):
//   POST /run      start the container and the job (idempotent while a job is running)
//   GET  /status   {done, exit, log tail, phases, sha, colo}; when done also stdout + manifest
//   POST /destroy  stop the container

import { DurableObject } from "cloudflare:workers";

const REPO = "https://github.com/zaycruz/coach-console";
const SITE = "https://patient-360.raava.dev";

// Always reaches the tail: each phase is timed, and the exit code, SHA and DONE marker are written
// even when the E2E exits non-zero (it does when any check fails).
const JOB = `
export HOME=/root DEBIAN_FRONTEND=noninteractive CI=1
W=/work; mkdir -p $W; cd $W
ph() { echo "$1 $(date -u +%s)" >> $W/phases; echo "=== $1 $(date -u +%FT%TZ)"; }
echo "nproc=$(nproc) mem_kb=$(grep MemTotal /proc/meminfo | tr -s ' ' | cut -d' ' -f2) disk=$(df -h / | tail -1 | tr -s ' ' | cut -d' ' -f2)" > $W/machine
finish() { echo "\${E2E_EXIT:-none}" > $W/exit; ph done; touch $W/DONE; }
trap finish EXIT
ph start
node -e 'fetch("https://1.1.1.1/cdn-cgi/trace").then(r=>r.text()).then(t=>process.stdout.write(t))' > $W/trace 2>&1
ph apt
apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null || exit 1
ph clone
git clone --depth 1 ${REPO} $W/repo || exit 1
cd $W/repo; git rev-parse HEAD > $W/sha
ph npm-ci
npm ci --no-audit --no-fund || exit 1
ph playwright-install
npx playwright install --with-deps chromium || exit 1
ph e2e
node e2e/live.mjs ${SITE} 2>&1 | tee $W/e2e.out
E2E_EXIT=\${PIPESTATUS[0]}
`;

const sh = async (c, cmd) => {
  const p = await c.exec(["bash", "-c", cmd], { env: { HOME: "/root" } });
  const o = await p.output();
  const d = new TextDecoder();
  return { code: o.exitCode, out: d.decode(o.stdout), err: d.decode(o.stderr) };
};

// Cloudflare stops the container soon after the Durable Object goes idle. Attempts polled every 20 s
// died mid-job (one of them already had this timeout set), so run.sh polls every 5 s. That interval is
// what kept the completed runs alive. The timeout is kept as an extra guard. The job takes about 3 min.
const KEEP_MS = 45 * 60 * 1000;

export class Reproducer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (ctx.container?.running) ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(KEEP_MS));
  }
  async fetch(req) {
    const c = this.ctx.container;
    const path = new URL(req.url).pathname;
    if (path === "/run") {
      if (!c.running) {
        c.start({ image: "cloudflare/debian-trixie", instance: "standard-4", enableInternet: true, entrypoint: ["sleep", "infinity"] });
        await this.ctx.storage.delete("stopped");
        c.monitor().then(() => this.ctx.storage.put("stopped", `exited ${new Date().toISOString()}`),
          (e) => this.ctx.storage.put("stopped", `error ${new Date().toISOString()} ${e}`));
      }
      await c.setInactivityTimeout(KEEP_MS);
      const already = await sh(c, "test -f /work/job.sh && echo yes || echo no");
      if (already.out.trim() === "yes") return Response.json({ started: false, note: "job already started" });
      const r = await c.exec(["bash", "-c", 'mkdir -p /work && printf "%s" "$1" > /work/job.sh && (setsid nohup bash /work/job.sh > /work/log.txt 2>&1 &) ; echo started', "_", JOB], { env: { HOME: "/root" } });
      const o = await r.output();
      return Response.json({ started: true, out: new TextDecoder().decode(o.stdout) });
    }
    if (path === "/status") {
      if (!c.running) return Response.json({ running: false, stopped: await this.ctx.storage.get("stopped") });
      const done = (await sh(c, "test -f /work/DONE && echo 1 || echo 0")).out.trim() === "1";
      const read = async (f) => (await sh(c, `cat ${f} 2>/dev/null`)).out;
      const res = {
        running: true, done,
        phases: await read("/work/phases"), sha: (await read("/work/sha")).trim(),
        trace: await read("/work/trace"), machine: (await read("/work/machine")).trim(), exit: (await read("/work/exit")).trim(),
        tail: (await sh(c, "tail -n 25 /work/log.txt 2>/dev/null")).out,
      };
      if (done) {
        res.e2e = await read("/work/e2e.out");
        res.manifestPath = (await sh(c, "ls -dt /work/repo/runs/*/manifest.json 2>/dev/null | head -1")).out.trim();
        res.manifest = res.manifestPath ? await read(res.manifestPath) : "";
        res.log = (await sh(c, "tail -c 200000 /work/log.txt")).out;
      }
      return Response.json(res);
    }
    if (path === "/destroy") {
      if (c.running) await c.destroy();
      return Response.json({ destroyed: true });
    }
    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(req, env) {
    if (!env.RUN_TOKEN || req.headers.get("authorization") !== `Bearer ${env.RUN_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    return env.REPRODUCER.getByName("p360-e2e").fetch(req);
  },
};
