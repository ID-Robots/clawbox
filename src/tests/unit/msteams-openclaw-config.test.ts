import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "fs/promises";

// setTeamsCredentials writes the pinned plugin's documented shape, with the
// client secret as an env SecretRef whose value lives in data/msteams.env.

vi.mock("child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("fs/promises", () => ({
  default: { readFile: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), mkdir: vi.fn(), chmod: vi.fn(), rm: vi.fn() },
}));
vi.mock("fs", () => ({
  default: { readFileSync: vi.fn(), existsSync: vi.fn(() => false), mkdirSync: vi.fn(), writeFileSync: vi.fn() },
}));

const mockFs = vi.mocked(fs);
const APP = "11111111-2222-3333-4444-555555555555";
const TENANT = "66666666-7777-8888-9999-000000000000";
const SECRET = ["clawbox", "test", "not", "a", "real", "secret"].join("~");

type WriteCall = [string, string, unknown];

function findWrite(fragment: string): WriteCall | undefined {
  return (mockFs.writeFile.mock.calls as unknown as WriteCall[]).find((c) => String(c[0]).includes(fragment));
}

describe("setTeamsCredentials", () => {
  let openclawConfig: typeof import("@/lib/openclaw-config");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFs.readFile.mockResolvedValue("{}");
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.chmod.mockResolvedValue(undefined);
    openclawConfig = await import("@/lib/openclaw-config");
  });

  it("writes the IDs inline, the secret as an env reference, and the webhook path", async () => {
    await openclawConfig.setTeamsCredentials(APP, SECRET, TENANT);
    const config = JSON.parse(findWrite("openclaw.json.tmp")![1]);
    expect(config.channels.msteams).toEqual({
      enabled: true,
      appId: APP,
      appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
      tenantId: TENANT,
      webhook: { path: "/api/messages" },
    });
    expect(config.secrets.providers.default).toEqual({ source: "env" });
    expect(config.plugins.entries.msteams).toMatchObject({ enabled: true });
    expect(JSON.stringify(config)).not.toContain(SECRET);
    const env = findWrite("msteams.env");
    expect(env?.[1]).toContain(`MSTEAMS_APP_PASSWORD=${SECRET}\n`);
    expect(env?.[2]).toMatchObject({ mode: 0o600 });
  });

  it("keeps the owner's webhook keys and replaces a literal secret", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify({ channels: { msteams: { appPassword: "literal", webhook: { path: "/old", port: 3978 } } } }),
    );
    await openclawConfig.setTeamsCredentials(APP, SECRET, TENANT);
    const teams = JSON.parse(findWrite("openclaw.json.tmp")![1]).channels.msteams;
    expect(teams.webhook).toEqual({ path: "/api/messages", port: 3978 });
    expect(teams.appPassword).toEqual({ source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" });
  });

  it("refuses an unsafe secret or malformed IDs before writing", async () => {
    await expect(openclawConfig.setTeamsCredentials(APP, "a\nb", TENANT)).rejects.toThrow(/unsafe/);
    await expect(openclawConfig.setTeamsCredentials("x", SECRET, TENANT)).rejects.toThrow(/invalid/);
    await expect(openclawConfig.setTeamsCredentials(APP, SECRET, "a/b")).rejects.toThrow(/invalid/);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });
});
