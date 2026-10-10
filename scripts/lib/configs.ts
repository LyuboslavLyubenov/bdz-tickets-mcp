// Pure helpers for registering the bdz-tickets MCP server into client configs.
// No I/O here — the orchestrator (scripts/setup.ts) reads and writes files.

export const SERVER_NAME = "bdz-tickets";

export type StdioEntry = { command: string; args: string[] };

export function buildStdioEntry(bunBin: string, serverEntry: string): StdioEntry {
  return { command: bunBin, args: [serverEntry] };
}

type Dict = Record<string, unknown>;

/**
 * Sets config[path[0]][path[1]]...[name] = entry, creating intermediate objects.
 * Preserves all other keys and their order. Returns whether anything changed.
 */
export function upsertJsonAtPath(
  config: unknown,
  path: string[],
  name: string,
  entry: unknown,
): { config: unknown; changed: boolean } {
  const root: Dict = config && typeof config === "object" && !Array.isArray(config) ? { ...(config as Dict) } : {};
  let node: Dict = root;
  for (const key of path) {
    const child = node[key];
    node[key] = child && typeof child === "object" && !Array.isArray(child) ? { ...(child as Dict) } : {};
    node = node[key] as Dict;
  }
  const before = node[name] ? JSON.stringify(node[name]) : undefined;
  node[name] = entry;
  const changed = before !== JSON.stringify(entry);
  return { config: root, changed };
}

const tomlString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reads a [mcp_servers.<name>] block (command + args) from TOML text, if present. */
export function extractTomlServer(
  toml: string,
  name: string,
): StdioEntry | null {
  const re = new RegExp(`^\\[mcp_servers\\.${escapeRegExp(name)}\\]\\s*$`, "m");
  const match = re.exec(toml);
  if (!match) return null;
  const rest = toml.slice(match.index);
  const blockEnd = rest.slice(1).search(/^\[/m);
  const block = blockEnd === -1 ? rest : rest.slice(0, blockEnd + 1);
  const command = /^command\s*=\s*"([^"]*)"/m.exec(block)?.[1];
  const argsMatch = /^args\s*=\s*\[([^\]]*)\]/m.exec(block)?.[1];
  const args = argsMatch
    ? [...argsMatch.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!)
    : [];
  return command ? { command, args } : null;
}

/**
 * Inserts or replaces the [mcp_servers.<name>] block in TOML text.
 * Other blocks and top-level keys stay byte-identical.
 */
export function upsertTomlServer(
  toml: string,
  name: string,
  entry: StdioEntry,
): { text: string; status: "added" | "updated" | "same" } {
  const block =
    `[mcp_servers.${name}]\n` +
    `command = ${tomlString(entry.command)}\n` +
    `args = [${entry.args.map(tomlString).join(", ")}]\n`;

  const existing = extractTomlServer(toml, name);
  if (existing && existing.command === entry.command && JSON.stringify(existing.args) === JSON.stringify(entry.args)) {
    return { text: toml, status: "same" };
  }

  const start = toml.search(new RegExp(`^\\[mcp_servers\\.${escapeRegExp(name)}\\]\\s*$`, "m"));
  if (start !== -1) {
    const rest = toml.slice(start);
    const end = rest.slice(1).search(/^\[/m);
    const stop = end === -1 ? toml.length : start + 1 + end;
    return { text: toml.slice(0, start) + block + toml.slice(stop), status: "updated" };
  }

  const sep = toml.length === 0 || toml.endsWith("\n\n") ? "" : toml.endsWith("\n") ? "\n" : "\n\n";
  return { text: toml + sep + block, status: "added" };
}
