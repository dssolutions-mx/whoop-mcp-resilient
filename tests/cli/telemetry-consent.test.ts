import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { parseSetupArgs, runSetup, type RunSetupDeps } from "../../src/cli/setup.js";

// A user-operated collector. This fork ships without a default endpoint.
const endpoint = "https://telemetry.example.com/events";

function fixture(interactive = true): {
  files: Map<string, string>;
  deps: RunSetupDeps & {
    io: { input: PassThrough & { isTTY: boolean }; output: PassThrough };
    confirmTelemetry: Mock;
  };
  chunks: string[];
} {
  const files = new Map<string, string>();
  const input = Object.assign(new PassThrough(), { isTTY: interactive });
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const confirmTelemetry = vi.fn().mockResolvedValue(true);
  const fs = {
    readFile: async (path: string): Promise<string> => {
      if (!files.has(path)) throw Object.assign(new Error("Missing"), { code: "ENOENT" });
      return files.get(path)!;
    },
    writeFile: async (path: string, value: string): Promise<void> => {
      files.set(path, value);
    },
    rename: async (from: string, to: string): Promise<void> => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    mkdir: async (): Promise<void> => {},
  };
  return { files, deps: { io: { input, output }, fs, confirmTelemetry }, chunks };
}

describe("setup telemetry without a configured endpoint", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never prompts and leaves telemetry off", async () => {
    vi.stubEnv("WHOOP_MCP_TELEMETRY_ENDPOINT", "");
    const test = fixture();
    test.files.set(
      "/config",
      JSON.stringify({
        mcpServers: {
          whoop: { command: "node", env: { WHOOP_CLIENT_ID: "id", WHOOP_CLIENT_SECRET: "s" } },
        },
      })
    );
    const result = await runSetup({ client: "claude-desktop", configPath: "/config" }, test.deps);

    expect(result.WHOOP_MCP_TELEMETRY).toBe("0");
    expect(test.deps.confirmTelemetry).not.toHaveBeenCalled();
    expect(test.files.get("/config")).not.toContain("WHOOP_MCP_TELEMETRY_ENDPOINT");
  });
});

describe("setup telemetry consent", () => {
  beforeEach(() => vi.stubEnv("WHOOP_MCP_TELEMETRY_ENDPOINT", endpoint));
  afterEach(() => vi.unstubAllEnvs());

  it.each(["DO_NOT_TRACK", "WHOOP_MCP_PRIVACY_MODE", "WHOOP_MCP_TELEMETRY"])(
    "persists %s denial over saved Desktop opt-in",
    async (name) => {
      vi.stubEnv(
        name,
        name === "DO_NOT_TRACK" ? "1" : name === "WHOOP_MCP_PRIVACY_MODE" ? "aggregate" : "0"
      );
      const test = fixture(false);
      const entry = {
        command: "custom-node",
        args: ["custom.js"],
        env: {
          WHOOP_CLIENT_ID: "id",
          WHOOP_CLIENT_SECRET: "secret",
          OTHER: "preserve",
          WHOOP_MCP_TELEMETRY: "1",
          WHOOP_MCP_TELEMETRY_ENDPOINT: "https://custom.example/events",
        },
      };
      const original = {
        preferences: { theme: "dark" },
        mcpServers: { whoop: entry, other: { command: "other" } },
      };
      test.files.set("/config", JSON.stringify(original));
      const result = await runSetup({ client: "claude-desktop", configPath: "/config" }, test.deps);
      expect(result.WHOOP_MCP_TELEMETRY).toBe("0");
      expect(JSON.parse(test.files.get("/config")!)).toEqual({
        ...original,
        mcpServers: {
          ...original.mcpServers,
          whoop: { ...entry, env: { ...entry.env, WHOOP_MCP_TELEMETRY: "0" } },
        },
      });
      expect(test.deps.confirmTelemetry).not.toHaveBeenCalled();
    }
  );

  it("parses explicit consent and rejects ambiguous values", () => {
    expect(parseSetupArgs(["--telemetry=on"]).telemetry).toBe("on");
    expect(parseSetupArgs(["--telemetry", "off"]).telemetry).toBe("off");
    expect(() => parseSetupArgs(["--telemetry=maybe"])).toThrow(/telemetry/);
  });

  it.each([true, false])("persists an explicit interactive answer %s", async (answer) => {
    const test = fixture();
    test.deps.confirmTelemetry.mockResolvedValue(answer);
    await runSetup(
      { client: "claude-desktop", clientId: "id", clientSecret: "secret", configPath: "/config" },
      test.deps
    );
    const config = JSON.parse(test.files.get("/config")!);
    expect(config.mcpServers.whoop.env.WHOOP_MCP_TELEMETRY).toBe(answer ? "1" : "0");
    expect(config.mcpServers.whoop.env.WHOOP_MCP_TELEMETRY_ENDPOINT).toBe(
      answer ? endpoint : undefined
    );
    expect(test.deps.confirmTelemetry).toHaveBeenCalledOnce();
    expect(test.chunks.join("")).toContain("No health data");
    test.deps.confirmTelemetry.mockClear();
    await runSetup({ client: "claude-desktop", configPath: "/config" }, test.deps);
    expect(test.deps.confirmTelemetry).not.toHaveBeenCalled();
  });

  it("keeps unattended setup off and never asks", async () => {
    const test = fixture(false);
    await runSetup(
      { client: "claude-desktop", clientId: "id", clientSecret: "secret", configPath: "/config" },
      test.deps
    );
    expect(JSON.parse(test.files.get("/config")!).mcpServers.whoop.env.WHOOP_MCP_TELEMETRY).toBe(
      "0"
    );
    expect(test.deps.confirmTelemetry).not.toHaveBeenCalled();
  });

  it.each(["yes", "", "no"])("uses the real safe-default prompt for answer %j", async (answer) => {
    const test = fixture();
    const deps = { io: test.deps.io, fs: test.deps.fs };
    deps.io.output.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Share this usage metadata?")) {
        queueMicrotask(() => deps.io.input.write(`${answer}\n`));
      }
    });
    await runSetup(
      { client: "claude-desktop", clientId: "id", clientSecret: "secret", configPath: "/config" },
      deps
    );
    expect(JSON.parse(test.files.get("/config")!).mcpServers.whoop.env.WHOOP_MCP_TELEMETRY).toBe(
      answer === "yes" ? "1" : "0"
    );
  });

  it("adds consent to an existing custom Desktop entry without replacing it", async () => {
    const test = fixture();
    const entry = {
      command: "custom-node",
      args: ["custom.js"],
      env: { WHOOP_CLIENT_ID: "id", WHOOP_CLIENT_SECRET: "secret", OTHER: "keep" },
    };
    const config = {
      preferences: { theme: "dark" },
      mcpServers: { whoop: entry, other: { command: "other" } },
    };
    test.files.set("/config", JSON.stringify(config));
    await runSetup({ client: "claude-desktop", configPath: "/config" }, test.deps);
    expect(JSON.parse(test.files.get("/config")!)).toEqual({
      ...config,
      mcpServers: {
        ...config.mcpServers,
        whoop: {
          ...entry,
          env: { ...entry.env, WHOOP_MCP_TELEMETRY: "1", WHOOP_MCP_TELEMETRY_ENDPOINT: endpoint },
        },
      },
    });
  });

  it.each(["0", "1"])("preserves saved consent %s when credentials change", async (consent) => {
    const test = fixture();
    test.files.set(
      "/config",
      JSON.stringify({
        mcpServers: {
          whoop: {
            command: "npx",
            args: ["-y", "github:dssolutions-mx/whoop-mcp-resilient"],
            env: {
              WHOOP_CLIENT_ID: "old",
              WHOOP_CLIENT_SECRET: "old",
              WHOOP_MCP_TELEMETRY: consent,
              WHOOP_MCP_TELEMETRY_ENDPOINT: "https://custom.example/events",
            },
          },
        },
      })
    );
    await runSetup(
      { client: "claude-desktop", clientId: "new", clientSecret: "new", configPath: "/config" },
      test.deps
    );
    const env = JSON.parse(test.files.get("/config")!).mcpServers.whoop.env;
    expect(env.WHOOP_MCP_TELEMETRY).toBe(consent);
    expect(env.WHOOP_MCP_TELEMETRY_ENDPOINT).toBe("https://custom.example/events");
    expect(test.deps.confirmTelemetry).not.toHaveBeenCalled();
  });

  it("keeps unattended telemetry off despite an invalid unused endpoint", async () => {
    vi.stubEnv("WHOOP_MCP_TELEMETRY_ENDPOINT", "invalid");
    const test = fixture(false);
    await runSetup(
      { client: "claude-desktop", clientId: "id", clientSecret: "secret", configPath: "/config" },
      test.deps
    );
    expect(JSON.parse(test.files.get("/config")!).mcpServers.whoop.env.WHOOP_MCP_TELEMETRY).toBe(
      "0"
    );
  });

  it("does not block interactive setup on an invalid optional endpoint", async () => {
    vi.stubEnv("WHOOP_MCP_TELEMETRY_ENDPOINT", "not-a-url");
    const test = fixture();
    await runSetup(
      { client: "claude-desktop", clientId: "id", clientSecret: "secret", configPath: "/config" },
      test.deps
    );
    expect(JSON.parse(test.files.get("/config")!).mcpServers.whoop.env.WHOOP_MCP_TELEMETRY).toBe(
      "0"
    );
    expect(test.deps.confirmTelemetry).not.toHaveBeenCalled();
  });

  it("persists existing aggregate privacy when explicit credential flags rewrite config", async () => {
    const test = fixture();
    test.files.set(
      "/config",
      JSON.stringify({
        mcpServers: {
          whoop: {
            command: "npx",
            args: [],
            env: {
              WHOOP_CLIENT_ID: "old",
              WHOOP_CLIENT_SECRET: "old",
              WHOOP_MCP_PRIVACY_MODE: "aggregate",
              DO_NOT_TRACK: "1",
            },
          },
        },
      })
    );
    await runSetup(
      {
        client: "claude-desktop",
        clientId: "new",
        clientSecret: "new",
        telemetry: "on",
        configPath: "/config",
      },
      test.deps
    );
    expect(JSON.parse(test.files.get("/config")!).mcpServers.whoop.env).toMatchObject({
      WHOOP_MCP_TELEMETRY: "0",
      WHOOP_MCP_PRIVACY_MODE: "aggregate",
      DO_NOT_TRACK: "1",
    });
    expect(test.deps.confirmTelemetry).not.toHaveBeenCalled();
  });

  it.each(["DO_NOT_TRACK", "WHOOP_MCP_PRIVACY_MODE", "WHOOP_MCP_TELEMETRY"])(
    "respects %s over consent",
    async (name) => {
      vi.stubEnv(
        name,
        name === "DO_NOT_TRACK" ? "1" : name === "WHOOP_MCP_PRIVACY_MODE" ? "aggregate" : "0"
      );
      const test = fixture();
      await runSetup(
        {
          client: "claude-desktop",
          clientId: "id",
          clientSecret: "secret",
          telemetry: "on",
          configPath: "/config",
        },
        test.deps
      );
      expect(JSON.parse(test.files.get("/config")!).mcpServers.whoop.env.WHOOP_MCP_TELEMETRY).toBe(
        "0"
      );
      expect(test.deps.confirmTelemetry).not.toHaveBeenCalled();
    }
  );

  it.each(["claude-code", "codex", "copilot"] as const)(
    "emits consent configuration for %s",
    async (client) => {
      const test = fixture(false);
      await runSetup(
        { client, clientId: "id", clientSecret: "secret", telemetry: "on" },
        test.deps
      );
      const command = test.chunks.join("");
      expect(command).toContain("WHOOP_MCP_TELEMETRY");
      expect(command).toContain(endpoint);
      if (client === "claude-code")
        expect(command.indexOf("-e WHOOP_MCP_TELEMETRY=")).toBeLessThan(command.indexOf("-- npx"));
      expect(test.deps.confirmTelemetry).not.toHaveBeenCalled();
    }
  );
});
