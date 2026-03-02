#!/usr/bin/env bun
import { startWorktree } from "./index.js";

function usage(): never {
  console.error(`Usage: dev-worktree --slug <name> [--port <start>] -- <command...>

Options:
  --slug   Subdomain name (required)
  --port   Starting port to search from (default: 3000)

The allocated port is available as $PORT in your command and as the PORT env var.

Examples:
  dev-worktree --slug myapp -- next dev
  dev-worktree --slug myapp --port 4000 -- vite --port \\$PORT`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dashDash = args.indexOf("--");
if (dashDash === -1 || dashDash === args.length - 1) usage();

const flags = args.slice(0, dashDash);
const command = args.slice(dashDash + 1);

let slug: string | undefined;
let portStart = 3000;

for (let i = 0; i < flags.length; i++) {
  if (flags[i] === "--slug" && flags[i + 1]) {
    slug = flags[++i];
  } else if (flags[i] === "--port" && flags[i + 1]) {
    portStart = parseInt(flags[++i], 10);
    if (Number.isNaN(portStart)) usage();
  } else {
    usage();
  }
}

if (!slug) usage();

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await startWorktree(slug, async (ctx) => {
  const port = await ctx.findFreePort(portStart);

  const resolvedCommand = command.map((arg) =>
    arg.replace(/\$PORT\b/g, String(port)),
  );

  const proc = Bun.spawn(resolvedCommand, {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, PORT: String(port) },
  });

  return { port, process: proc };
});
