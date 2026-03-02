# worktree-devservers

Run multiple dev servers in git worktrees with automatic port allocation and reverse proxy routing. Each worktree gets its own `<slug>.localhost` URL on port 80.

Built for coding agents (Conductor, Claude Code, Cursor) that work in isolated worktrees, so multiple branches can run simultaneously without port conflicts.

## How it works

1. Finds free ports (checks both IPv4 and IPv6)
2. Calls your start callback — you spawn whatever dev server you need
3. Registers a Caddy reverse proxy route: `<slug>.localhost:80` → `localhost:<port>`
4. Cleans up routes and stale entries on exit

## Prerequisites

```bash
brew install caddy
sudo caddy start
```

## Install

```bash
bun add worktree-devservers
```

## Usage

```typescript
import { startWorktree } from "worktree-devservers";

const slug = process.env.WORKTREE_SLUG;
if (!slug) {
  console.error("WORKTREE_SLUG is required");
  process.exit(1);
}

startWorktree(slug, async (ctx) => {
  const port = await ctx.findFreePort(3000);

  const child = Bun.spawn(["bun", "run", "dev"], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["inherit", "inherit", "inherit"],
  });

  return { port, process: child };
});
```

Then access your dev server at `http://<slug>.localhost`.

## API

### `startWorktree(slug, startFn, options?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `slug` | `string` | Worktree identifier, used as the subdomain (`<slug>.localhost`) |
| `startFn` | `(ctx: WorktreeContext) => Promise<WorktreeHandle>` | Callback to start your dev server |
| `options` | `WorktreeOptions` | Optional configuration |

### `WorktreeContext`

| Property | Type | Description |
|----------|------|-------------|
| `slug` | `string` | The worktree slug |
| `findFreePort(start)` | `(start: number) => Promise<number>` | Find next free port from `start`. Tracks allocations internally. |

### `WorktreeHandle`

| Property | Type | Description |
|----------|------|-------------|
| `port` | `number` | Port Caddy should route to |
| `process` | `Subprocess` | Child process for lifecycle management |

### `WorktreeOptions`

| Option | Default | Description |
|--------|---------|-------------|
| `mapDir` | `~/.worktree-devservers` | Directory for state file |
| `caddyAdmin` | `http://localhost:2019` | Caddy admin API URL |
| `serverId` | `worktree-devservers` | Caddy server block ID |
| `listenPort` | `80` | Port Caddy listens on |

## License

MIT
