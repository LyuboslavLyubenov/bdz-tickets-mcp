import { describe, expect, test } from "bun:test";
import {
  buildStdioEntry,
  extractTomlServer,
  upsertJsonAtPath,
  upsertTomlServer,
} from "../scripts/lib/configs.ts";

const entry = { command: "/usr/local/bin/bun", args: ["/opt/bdz-tickets/src/index.ts"] };

describe("upsertJsonAtPath", () => {
  test("creates nested containers in an empty config", () => {
    const { config, changed } = upsertJsonAtPath({}, ["mcp", "servers"], "bdz-tickets", entry);
    expect(changed).toBe(true);
    expect((config as any).mcp.servers["bdz-tickets"]).toEqual(entry);
  });

  test("preserves sibling keys and their order", () => {
    const original = { $schema: "x", model: "gpt", mcp: { Keep: { type: "local" } } };
    const { config, changed } = upsertJsonAtPath(original, ["mcp"], "bdz-tickets", entry);
    expect(changed).toBe(true);
    expect(Object.keys((config as any).mcp)).toEqual(["Keep", "bdz-tickets"]);
    expect((config as any).$schema).toBe("x");
    expect((config as any).mcp.Keep).toEqual({ type: "local" });
  });

  reportsNoChangeWhenIdentical();
  function reportsNoChangeWhenIdentical() {
    const original = { mcp: { servers: { "bdz-tickets": entry } }, other: 1 };
    const { config, changed } = upsertJsonAtPath(original, ["mcp", "servers"], "bdz-tickets", entry);
    expect(changed).toBe(false);
    expect(config).toEqual(original);
  }

  test("replaces a differing entry", () => {
    const original = { mcp: { servers: { "bdz-tickets": { command: "old", args: [] } } } };
    const { config, changed } = upsertJsonAtPath(original, ["mcp", "servers"], "bdz-tickets", entry);
    expect(changed).toBe(true);
    expect((config as any).mcp.servers["bdz-tickets"]).toEqual(entry);
  });
});

describe("upsertTomlServer", () => {
  test("appends a block to an existing config", () => {
    const original = `model = "gpt-5.6-terra"\n\n[projects."/Users/x"]\nkey = "v"\n`;
    const { text, status } = upsertTomlServer(original, "bdz-tickets", entry);
    expect(status).toBe("added");
    expect(text).toContain("[mcp_servers.bdz-tickets]");
    expect(text).toContain(`command = "/usr/local/bin/bun"`);
    expect(text.startsWith(original)).toBe(true);
  });

  test("replaces only its own block, keeping neighbors intact", () => {
    const original = [
      "model = \"gpt\"",
      "",
      "[mcp_servers.other]",
      "command = \"x\"",
      "",
      "[mcp_servers.bdz-tickets]",
      "command = \"old\"",
      "args = []",
      "",
      "[mcp_servers.node_repl.env]",
      "KEY = \"val\"",
    ].join("\n") + "\n";
    const { text, status } = upsertTomlServer(original, "bdz-tickets", { command: "/bin/bun", args: ["/a/index.ts"] });
    expect(status).toBe("updated");
    expect(text).toContain(`command = "/bin/bun"`);
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain('[mcp_servers.node_repl.env]');
    expect(text).toContain('KEY = "val"');
    expect(text).not.toContain('"old"');
    const parsed = extractTomlServer(text, "bdz-tickets");
    expect(parsed).toEqual({ command: "/bin/bun", args: ["/a/index.ts"] });
  });

  test("is idempotent", () => {
    const once = upsertTomlServer("", "bdz-tickets", entry);
    const twice = upsertTomlServer(once.text, "bdz-tickets", entry);
    expect(twice.status).toBe("same");
    expect(twice.text).toBe(once.text);
    expect(once.text.match(/mcp_servers/g)?.length).toBe(1);
  });

  test("extractTomlServer reads back command and args", () => {
    const { text } = upsertTomlServer("", "bdz-tickets", entry);
    expect(extractTomlServer(text, "bdz-tickets")).toEqual(entry);
    expect(extractTomlServer(text, "other")).toBeNull();
  });

  test("does not confuse prefixes when matching the header", () => {
    const tricky = "[mcp_servers.bdz-tickets-extra]\ncommand = \"x\"\n";
    const { status, text } = upsertTomlServer(tricky, "bdz-tickets", entry);
    expect(status).toBe("added");
    expect(text).toContain("[mcp_servers.bdz-tickets-extra]");
    expect(text).toContain("[mcp_servers.bdz-tickets]");
    expect(text).toContain('command = "x"');
  });
});

test("buildStdioEntry", () => {
  expect(buildStdioEntry("/bin/bun", "/srv/index.ts")).toEqual({
    command: "/bin/bun",
    args: ["/srv/index.ts"],
  });
});
