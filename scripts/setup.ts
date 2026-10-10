#!/usr/bin/env bun
/**
 * One-command installer for bdz-tickets-mcp.
 *
 * Registers the MCP server into every detected client (ZCode, Claude, Codex, opencode),
 * creates .env from the template when missing, and smoke-checks that the server starts.
 *
 *   bun scripts/setup.ts                        # all detected clients
 *   bun scripts/setup.ts --client zcode --client codex
 *   bun scripts/setup.ts --email you@example.com --password '...'
 *   bun scripts/setup.ts --no-verify            # skip the smoke check
 *
 * Idempotent: re-running updates nothing when entries already match.
 */
import { copyFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_NAME, buildStdioEntry, upsertJsonAtPath, upsertTomlServer } from "./lib/configs.ts";

type Args = { clients: Set<string>; email?: string; password?: string; noVerify: boolean };
const argv = process.argv.slice(2);
const args: Args = { clients: new Set(), noVerify: argv.includes("--no-verify") };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--client") args.clients.add(argv[++i]!.toLowerCase());
  if (argv[i] === "--email") args.email = argv[++i];
  if (argv[i] === "--password") args.password = argv[++i];
}
const wants = (c: string) => args.clients.size === 0 || args.clients.has(c);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(projectRoot, "src", "index.ts");
const home = homedir();
const bunBin = process.execPath; // absolute bun path, safe for GUI-spawned clients
const entry = buildStdioEntry(bunBin, serverEntry);

const results: { client: string; status: string }[] = [];

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function writeJson(path: string, config: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n");
}

function report(client: string, status: string) {
  results.push({ client, status });
  console.log(`  ${client.padEnd(10)} ${status}`);
}

// --- 1. dependencies -------------------------------------------------------

console.log("bdz-tickets-mcp setup");
await Bun.$`bun install`.quiet().throws(false);
console.log(`  deps       installed (${serverEntry})`);

// --- 2. .env ---------------------------------------------------------------

const envPath = join(projectRoot, ".env");
let env = await readTextIfExists(envPath);
if (env === null) {
  await copyFile(join(projectRoot, ".env.example"), envPath);
  env = await readFile(envPath, "utf8");
}
const hasCreds =
  /^BDZ_USERNAME=.+/m.test(env) &&
  /^BDZ_PASSWORD=.+/m.test(env);
if (args.email || args.password) {
  if (args.email) env = /^BDZ_USERNAME=.*/m.test(env) ? env.replace(/^BDZ_USERNAME=.*/m, `BDZ_USERNAME=${args.email}`) : env + `\nBDZ_USERNAME=${args.email}\n`;
  if (args.password) env = /^BDZ_PASSWORD=.*/m.test(env) ? env.replace(/^BDZ_PASSWORD=.*/m, `BDZ_PASSWORD=${args.password}`) : env + `\nBDZ_PASSWORD=${args.password}\n`;
  await writeFile(envPath, env);
  await chmod(envPath, 0o600);
  report("env", "credentials written to .env (chmod 600)");
} else if (hasCreds) {
  report("env", "ok (.env present with credentials)");
} else {
  report("env", "created from template — MISSING CREDENTIALS, fill BDZ_USERNAME/BDZ_PASSWORD in .env");
}

// --- 3. ZCode ---------------------------------------------------------------

if (wants("zcode")) {
  const path = join(home, ".zcode", "cli", "config.json");
  const raw = await readTextIfExists(path);
  if (raw === null && !(await Bun.file(join(home, ".zcode")).exists())) {
    report("zcode", "skipped (~/.zcode not found)");
  } else {
    const { config, changed } = upsertJsonAtPath(raw ? JSON.parse(raw) : {}, ["mcp", "servers"], SERVER_NAME, entry);
    if (changed) {
      await writeJson(path, config);
      report("zcode", `registered in ${path} (restart ZCode to connect)`);
    } else report("zcode", "already configured");
  }
}

// --- 4. opencode -------------------------------------------------------------

if (wants("opencode")) {
  const dir = join(home, ".config", "opencode");
  let path: string | null = null;
  for (const candidate of ["opencode.json", "opencode.jsonc", "config.json"]) {
    if (await Bun.file(join(dir, candidate)).exists()) {
      path = join(dir, candidate);
      break;
    }
  }
  if (!path && !(await Bun.file(dir).exists())) {
    report("opencode", "skipped (~/.config/opencode not found)");
  } else {
    path = path ?? join(dir, "opencode.json");
    const raw = await readTextIfExists(path);
    const parsed = raw && path.endsWith(".jsonc") ? JSON.parse(raw.replace(/\/\/.*$/gm, "")) : raw ? JSON.parse(raw) : {};
    const ocEntry = { type: "local", command: [entry.command, ...entry.args], enabled: true };
    const { config, changed } = upsertJsonAtPath(parsed, ["mcp"], SERVER_NAME, ocEntry);
    if (changed) {
      await writeJson(path, config);
      report("opencode", `registered in ${path} (restart opencode to connect)`);
    } else report("opencode", "already configured");
  }
}

// --- 5. Codex ----------------------------------------------------------------

if (wants("codex")) {
  const path = join(home, ".codex", "config.toml");
  const raw = await readTextIfExists(path);
  if (raw === null && !(await Bun.file(join(home, ".codex")).exists())) {
    report("codex", "skipped (~/.codex not found)");
  } else {
    const { text, status } = upsertTomlServer(raw ?? "", SERVER_NAME, entry);
    if (status !== "same") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
      report("codex", `${status} [mcp_servers.${SERVER_NAME}] in ${path} (restart Codex to connect)`);
    } else report("codex", "already configured");
  }
}

// --- 6. Claude ---------------------------------------------------------------

if (wants("claude")) {
  const claudeBin = Bun.which("claude");
  if (claudeBin) {
    const add = Bun.$`claude mcp add --scope user ${SERVER_NAME} -- ${bunBin} ${serverEntry}`.throws(false).quiet();
    const proc = await add;
    if (proc.exitCode === 0) {
      report("claude", `registered via claude mcp add (user scope)`);
    } else {
      const err = proc.stderr.toString() + proc.stdout.toString();
      if (/already exists/i.test(err)) {
        const rm = await Bun.$`claude mcp remove --scope user ${SERVER_NAME}`.throws(false).quiet();
        const retry = await Bun.$`claude mcp add --scope user ${SERVER_NAME} -- ${bunBin} ${serverEntry}`.throws(false).quiet();
        report("claude", retry.exitCode === 0 ? "updated via claude mcp (user scope)" : `re-add failed: ${retry.stderr.toString().trim().slice(0, 120)}`);
      } else {
        report("claude", `claude mcp add failed: ${err.trim().slice(0, 120)}`);
      }
    }
  } else {
    const desktop = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    if (await Bun.file(desktop).exists()) {
      const { config, changed } = upsertJsonAtPath(JSON.parse((await readTextIfExists(desktop)) ?? "{}"), ["mcpServers"], SERVER_NAME, entry);
      if (changed) {
        await writeJson(desktop, config);
        report("claude", `registered in Claude Desktop config`);
      } else report("claude", "already configured (Desktop)");
    } else {
      report("claude", "skipped (no claude CLI and no Claude Desktop config)");
    }
  }
}

// --- 7. smoke check ------------------------------------------------------------

if (!args.noVerify) {
  const proc = await Bun.$`bun scripts/mcp-call.ts`.cwd(projectRoot).throws(false).quiet();
  const out = proc.stdout.toString();
  const toolCount = (out.match(/^TOOLS:/m) ? out.split("TOOLS:")[1]!.trim().split(", ").length : 0);
  if (proc.exitCode === 0 && toolCount > 0) {
    report("verify", `server starts and exposes ${toolCount} tools`);
  } else {
    report("verify", `FAILED: ${(proc.stderr.toString() || out).trim().slice(0, 160)}`);
  }
}

const failed = results.filter((r) => /failed|FAILED|MISSING/.test(r.status));
console.log(failed.length ? "\nSetup finished with warnings above." : "\nSetup complete.");
process.exit(failed.some((f) => f.status.includes("FAILED")) ? 1 : 0);
