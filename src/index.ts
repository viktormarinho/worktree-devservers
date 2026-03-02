import type { Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorktreeOptions {
  /** Caddy admin API base URL (default: "http://localhost:2019") */
  caddyAdmin?: string;
  /** Caddy server block ID (default: "worktree-devservers") */
  serverId?: string;
  /** Port Caddy listens on (default: 80) */
  listenPort?: number;
}

export interface WorktreeContext {
  slug: string;
  findFreePort(start: number): Promise<number>;
}

export interface WorktreeHandle {
  port: number;
  process: Subprocess;
}

export type StartFn = (ctx: WorktreeContext) => Promise<WorktreeHandle>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  caddyAdmin: string;
  serverId: string;
  listenPort: number;
}

function resolveConfig(opts: WorktreeOptions = {}): Config {
  return {
    caddyAdmin: opts.caddyAdmin ?? "http://localhost:2019",
    serverId: opts.serverId ?? "worktree-devservers",
    listenPort: opts.listenPort ?? 80,
  };
}

// ---------------------------------------------------------------------------
// Port detection (IPv4 + IPv6)
// ---------------------------------------------------------------------------

function probePort(hostname: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    Bun.connect({
      hostname,
      port,
      socket: {
        open(socket) {
          socket.end();
          resolve(false); // something is listening → port in use
        },
        data() {},
        error() {
          resolve(true);
        },
        connectError() {
          resolve(true);
        },
      },
    }).catch(() => resolve(true));
  });
}

async function isPortFree(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([
    probePort("127.0.0.1", port),
    probePort("::1", port),
  ]);
  return v4 && v6;
}

// ---------------------------------------------------------------------------
// Caddy admin API helpers
// ---------------------------------------------------------------------------

async function assertCaddyRunning(cfg: Config): Promise<void> {
  try {
    const res = await fetch(`${cfg.caddyAdmin}/config/`);
    if (!res.ok) throw new Error();
  } catch {
    console.error(`
❌ Caddy is not running. One-time setup required:

  brew install caddy
  caddy start

Then re-run your dev:worktree command.
`);
    process.exit(1);
  }
}

async function ensureCaddyServer(cfg: Config): Promise<void> {
  const res = await fetch(
    `${cfg.caddyAdmin}/config/apps/http/servers/${cfg.serverId}`,
  );
  if (res.ok) {
    // Server exists — ensure routes array exists too
    const routesRes = await fetch(
      `${cfg.caddyAdmin}/config/apps/http/servers/${cfg.serverId}/routes`,
    );
    if (!routesRes.ok) {
      await fetch(
        `${cfg.caddyAdmin}/config/apps/http/servers/${cfg.serverId}/routes`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([]),
        },
      );
    }
    return;
  }

  const currentRes = await fetch(`${cfg.caddyAdmin}/config/`);
  const current: any = (currentRes.ok ? await currentRes.json() : null) ?? {};

  const merged = {
    ...current,
    apps: {
      ...(current.apps ?? {}),
      http: {
        ...(current.apps?.http ?? {}),
        servers: {
          ...(current.apps?.http?.servers ?? {}),
          [cfg.serverId]: { listen: [`:${cfg.listenPort}`], routes: [] },
        },
      },
    },
  };

  const loadRes = await fetch(`${cfg.caddyAdmin}/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(merged),
  });

  if (!loadRes.ok) {
    const text = await loadRes.text();
    throw new Error(`Failed to bootstrap Caddy server: ${text}`);
  }

  console.log(
    `✓ Bootstrapped Caddy server '${cfg.serverId}' on :${cfg.listenPort}`,
  );
}

interface CaddyRoute {
  "@id"?: string;
  handle?: Array<{
    handler: string;
    upstreams?: Array<{ dial: string }>;
  }>;
}

async function getRoutes(cfg: Config): Promise<CaddyRoute[]> {
  const res = await fetch(
    `${cfg.caddyAdmin}/config/apps/http/servers/${cfg.serverId}/routes`,
  );
  if (!res.ok) return [];
  return (await res.json()) as CaddyRoute[];
}

function parseRoutePort(route: CaddyRoute): number | null {
  const dial = route.handle?.[0]?.upstreams?.[0]?.dial;
  if (!dial) return null;
  const match = dial.match(/:(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

function parseRouteSlug(route: CaddyRoute): string | null {
  const id = route["@id"];
  if (!id?.startsWith("worktree-")) return null;
  return id.slice("worktree-".length);
}

async function registerRoute(
  cfg: Config,
  slug: string,
  port: number,
): Promise<void> {
  await removeRoute(cfg, slug);

  const route = {
    "@id": `worktree-${slug}`,
    match: [{ host: [`${slug}.localhost`] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: `localhost:${port}` }],
      },
    ],
  };

  const res = await fetch(
    `${cfg.caddyAdmin}/config/apps/http/servers/${cfg.serverId}/routes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(route),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to register Caddy route: ${text}`);
  }
}

async function removeRoute(cfg: Config, slug: string): Promise<void> {
  await fetch(`${cfg.caddyAdmin}/id/worktree-${slug}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function startWorktree(
  slug: string,
  start: StartFn,
  options?: WorktreeOptions,
): Promise<void> {
  const cfg = resolveConfig(options);

  // 1. Ensure Caddy is ready
  await assertCaddyRunning(cfg);
  await ensureCaddyServer(cfg);

  // 2. Read existing routes from Caddy, clean stale ones, collect used ports
  const routes = await getRoutes(cfg);
  const usedPorts = new Set<number>();

  for (const route of routes) {
    const routeSlug = parseRouteSlug(route);
    const routePort = parseRoutePort(route);
    if (!routeSlug || !routePort) continue;

    if (await isPortFree(routePort)) {
      console.log(`🧹 Cleaned stale route for '${routeSlug}' (port ${routePort} not listening)`);
      await removeRoute(cfg, routeSlug);
    } else {
      usedPorts.add(routePort);
    }
  }

  // 3. Build context and call the start callback
  const ctx: WorktreeContext = {
    slug,
    async findFreePort(start: number): Promise<number> {
      for (let p = start; p < start + 1000; p++) {
        if (usedPorts.has(p)) continue;
        if (await isPortFree(p)) {
          usedPorts.add(p);
          return p;
        }
      }
      throw new Error(`No free port found starting from ${start}`);
    },
  };

  const handle = await start(ctx);

  // 4. Register Caddy route
  await registerRoute(cfg, slug, handle.port);

  console.log(`✅ http://${slug}.localhost is live`);

  // 5. Lifecycle — cleanup on exit
  async function cleanup(): Promise<void> {
    console.log(`\n🧹 Cleaning up ${slug}...`);
    try {
      await removeRoute(cfg, slug);
    } catch (e) {
      console.warn("Warning: failed to remove Caddy route:", e);
    }
    handle.process.kill();
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await handle.process.exited;
  await cleanup();
}
