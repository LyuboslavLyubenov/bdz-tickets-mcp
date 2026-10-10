import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BdzApiError } from "./errors.ts";

export const BASE_URL = "https://tickets.bdz.bg/portal/";

const TOKEN_PATH = join(homedir(), ".config", "bdz-tickets", "token.json");
/** Refresh 60s before the server-side expiry to dodge clock skew. */
const EXPIRY_MARGIN_MS = 60_000;

type CachedToken = { token: string; expiresAtMs: number };
let memory: CachedToken | null = null;

/** Load <project>/.env once so the server works regardless of the client's cwd. */
let envLoaded = false;
function loadEnv() {
  if (envLoaded || process.env.BDZ_USERNAME) return;
  envLoaded = true;
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = Bun.file(join(projectRoot, ".env"));
  raw
    .text()
    .then((text) => {
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
        if (m?.[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
    })
    .catch(() => {});
}

async function readDisk(): Promise<CachedToken | null> {
  try {
    const data = JSON.parse(await readFile(TOKEN_PATH, "utf8"));
    if (typeof data.token === "string" && typeof data.expiresAtMs === "number") return data;
  } catch {}
  return null;
}

async function writeDisk(entry: CachedToken) {
  try {
    await mkdir(dirname(TOKEN_PATH), { recursive: true });
    await writeFile(TOKEN_PATH, JSON.stringify(entry), { mode: 0o600 });
    await chmod(TOKEN_PATH, 0o600).catch(() => {});
  } catch {}
}

export async function invalidateToken() {
  memory = null;
  await unlink(TOKEN_PATH).catch(() => {});
}

export function freshToken(): string | null {
  const fresh = (e: CachedToken) => e.expiresAtMs > Date.now() + EXPIRY_MARGIN_MS;
  if (memory && fresh(memory)) return memory.token;
  return null;
}

/** Bearer token for API calls: memory → disk cache → fresh login. */
export async function getToken(): Promise<string> {
  loadEnv();
  const cached = memory ?? (memory = await readDisk());
  if (cached && cached.expiresAtMs > Date.now() + EXPIRY_MARGIN_MS) return cached.token;

  const username = process.env.BDZ_USERNAME;
  const password = process.env.BDZ_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "Missing BDZ_USERNAME / BDZ_PASSWORD. Copy .env.example to .env in the bdz-tickets project and fill in your bileti.bdz.bg credentials.",
    );
  }

  let res: Response;
  try {
    res = await fetch(BASE_URL + "Token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams({ grant_type: "password", username, password }).toString(),
    });
  } catch (e) {
    throw new Error(`Cannot reach ${BASE_URL} (network error: ${e})`);
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc = typeof body?.error_description === "string" ? body.error_description : undefined;
    throw new BdzApiError(res.status, body, desc ?? `Login failed (HTTP ${res.status})`);
  }
  if (!body?.access_token) throw new BdzApiError(res.status, body, "Login response has no access_token");

  memory = {
    token: body.access_token,
    expiresAtMs: Date.now() + Number(body.expires_in ?? 86399) * 1000,
  };
  await writeDisk(memory);
  return memory.token;
}

export function profileFromTokenResponse(body: Record<string, unknown>) {
  return {
    user_name: body.userName,
    first_name: body.firstName,
    last_name: body.lastName,
    phone: body.phone,
    expires: body[".expires"],
  };
}
