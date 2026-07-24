import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The guard() wrapper reads getToken() and fetchCaps(); flip the token per-test
// via the hoisted holder. getApiUrl is consumed by the real api-client.
const h = vi.hoisted(() => ({ token: "tok" as string | null }));
vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => h.token,
}));
vi.mock("../../src/lib/caps", () => ({
  fetchCaps: async () => ({ selfHosted: true }),
  requireSelfHost: () => {},
}));

import { mailCommand } from "../../src/commands/mail";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

const DEPLOY = "/api/mail/webmail/deploy-project";
const TARGETS = "/api/mail/webmail/targets";

let fetchStub: FetchStub;
beforeEach(() => {
  h.token = "tok";
});
afterEach(() => {
  fetchStub?.restore();
  setJsonMode(false);
});

/** `mail install <id> -d <host> --no-watch [extra]` — the deploy path minus the SSE tail. */
function install(...extra: string[]) {
  return runCommand(mailCommand, ["install", "srv1", "-d", "mail.example.com", "--no-watch", ...extra]);
}

// ─── --list-targets (read-only discovery, --domain not required) ──────────────

describe("mail install --list-targets", () => {
  const OPTIONS = [
    { kind: "mail", serverId: "srv1", label: "This mail server" },
    { kind: "server", serverId: "srv9", label: "web-01" },
    { kind: "opshcloud", serverId: "cloud", label: "Opshcloud", disabled: true, disabledReason: "no plan" },
  ];

  it("GETs /mail/webmail/targets?serverId and tabulates the options", async () => {
    fetchStub = stubFetch(() => ({ json: { options: OPTIONS } }));
    const { out, code } = await runCommand(mailCommand, ["install", "srv1", "--list-targets"]);
    expect(code).toBe(0);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].method).toBe("GET");
    expect(fetchStub.calls[0].url).toBe(`http://api.test${TARGETS}?serverId=srv1`);
    expect(out).toContain("web-01");
    expect(out).toContain("no (no plan)"); // disabled row renders its reason
  });

  it("does not require --domain and never hits the deploy endpoint", async () => {
    fetchStub = stubFetch(() => ({ json: { options: OPTIONS } }));
    const { code } = await runCommand(mailCommand, ["install", "srv1", "--list-targets"]);
    expect(code).toBe(0);
    expect(fetchStub.calls.every((c) => !c.url.includes("deploy-project"))).toBe(true);
  });

  it("emits raw JSON rows in json mode", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ json: { options: OPTIONS } }));
    const { out } = await runCommand(mailCommand, ["install", "srv1", "--list-targets"]);
    expect(JSON.parse(out)).toEqual(OPTIONS);
  });

  it("reports an empty target list", async () => {
    fetchStub = stubFetch(() => ({ json: { options: [] } }));
    const { err, code } = await runCommand(mailCommand, ["install", "srv1", "--list-targets"]);
    expect(code).toBe(0);
    expect(err).toContain("No deploy targets");
  });
});

// ─── target resolution → deploy body ─────────────────────────────────────────

describe("mail install target resolution", () => {
  it("defaults an omitted --target to the mail server itself (kind self)", async () => {
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep1" } }));
    const { code } = await install();
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe(`http://api.test${DEPLOY}`);
    expect(fetchStub.calls[0].body).toEqual({
      mailServerId: "srv1",
      hostname: "mail.example.com",
      target: { kind: "self", serverId: "srv1" },
    });
  });

  it("treats -t mail the same as the default", async () => {
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep1" } }));
    await install("-t", "mail");
    expect((fetchStub.calls[0].body as { target: unknown }).target).toEqual({ kind: "self", serverId: "srv1" });
  });

  it("maps -t cloud and -t opshcloud to the cloud target", async () => {
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep1" } }));
    await install("-t", "cloud");
    await install("-t", "opshcloud");
    expect((fetchStub.calls[0].body as { target: unknown }).target).toEqual({ kind: "cloud" });
    expect((fetchStub.calls[1].body as { target: unknown }).target).toEqual({ kind: "cloud" });
  });

  it("routes any other -t token to that openship server id", async () => {
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep1" } }));
    await install("-t", "srv42");
    expect((fetchStub.calls[0].body as { target: unknown }).target).toEqual({ kind: "self", serverId: "srv42" });
  });
});

// ─── --domain requirement ────────────────────────────────────────────────────

describe("mail install --domain requirement", () => {
  it("exits 1 without --domain and makes no request", async () => {
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep1" } }));
    const { err, code } = await runCommand(mailCommand, ["install", "srv1", "--no-watch"]);
    expect(code).toBe(1);
    expect(err).toContain("--domain is required");
    expect(fetchStub.calls).toHaveLength(0);
  });
});

// ─── --internal-port validation ──────────────────────────────────────────────

describe("mail install --internal-port validation", () => {
  it("forwards a valid port on the deploy body", async () => {
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep1" } }));
    await install("--internal-port", "8080");
    expect(fetchStub.calls[0].body).toMatchObject({ internalPort: 8080 });
  });

  it.each(["abc", "0", "70000", "-1"])("rejects %s with exit 1 and no request", async (port) => {
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep1" } }));
    const { err, code } = await install("--internal-port", port);
    expect(code).toBe(1);
    expect(err).toContain("--internal-port must be an integer");
    expect(fetchStub.calls).toHaveLength(0);
  });
});

// ─── --no-watch surfacing ────────────────────────────────────────────────────

describe("mail install --no-watch", () => {
  it("prints the follow-up logs hint when a deployment id comes back", async () => {
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep7", projectId: "prj7" } }));
    const { err, code } = await install();
    expect(code).toBe(0);
    expect(err).toContain("openship logs dep7 --follow");
  });

  it("notes when the API returns no deployment id", async () => {
    fetchStub = stubFetch(() => ({ json: { projectId: "prj7" } }));
    const { err, code } = await install();
    expect(code).toBe(0);
    expect(err).toContain("No deployment id returned");
  });

  it("emits raw JSON of the response in json mode", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep7", projectId: "prj7" } }));
    const { out } = await install();
    expect(JSON.parse(out)).toEqual({ deploymentId: "dep7", projectId: "prj7" });
  });
});

// ─── guard paths ─────────────────────────────────────────────────────────────

describe("mail install guard", () => {
  it("exits 1 with a login hint and makes no request when logged out", async () => {
    h.token = null;
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep1" } }));
    const { err, code } = await install();
    expect(code).toBe(1);
    expect(err).toContain("Not logged in");
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("surfaces an API error from the deploy call and exits 1", async () => {
    fetchStub = stubFetch(() => ({ status: 400, json: { error: "hostname already in use" } }));
    const { err, code } = await install();
    expect(code).toBe(1);
    expect(err).toContain("hostname already in use");
  });
});
