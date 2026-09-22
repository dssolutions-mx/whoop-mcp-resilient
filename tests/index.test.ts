/**
 * Tests for the entry point (src/index.ts).
 *
 * All dependencies are mocked — no real OAuth, no real fetch, no real filesystem.
 * Verifies env var validation, authentication wiring, client creation with
 * token refresh, MCP server creation, and stdio transport connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockAuthenticate = vi.fn<() => Promise<string>>();
const mockRefreshAccessToken = vi.fn();
const mockToOAuthTokens = vi.fn();

vi.mock("../src/auth/oauth.js", () => ({
  authenticate: (...args: unknown[]) =>
    mockAuthenticate(...(args as Parameters<typeof mockAuthenticate>)),
  refreshAccessToken: (...args: unknown[]) => mockRefreshAccessToken(...args),
  toOAuthTokens: (...args: unknown[]) => mockToOAuthTokens(...args),
}));

const mockLoadTokens = vi.fn();
const mockSaveTokens = vi.fn();

vi.mock("../src/auth/token-store.js", () => ({
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
  saveTokens: (...args: unknown[]) => mockSaveTokens(...args),
  isTokenExpired: (tokens: { expires_at: number }) => tokens.expires_at <= Date.now(),
}));

const mockCreateWhoopClient = vi.fn();

vi.mock("../src/api/client.js", () => ({
  createWhoopClient: (...args: unknown[]) => mockCreateWhoopClient(...args),
}));

const mockConnect = vi.fn<() => Promise<void>>();
const mockCreateWhoopServer = vi.fn();

vi.mock("../src/server.js", () => ({
  createWhoopServer: (...args: unknown[]) => mockCreateWhoopServer(...args),
}));

const mockStdioTransportInstance = { _mock: true };
const MockStdioServerTransport = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: MockStdioServerTransport,
}));

const mockCreateHttpServer = vi.fn();
const mockHttpClose = vi.fn(() => Promise.resolve());
const mockRunSetup = vi.fn();
const mockRunDoctor = vi.fn();

vi.mock("../src/cli/setup.js", () => ({
  parseSetupArgs: () => ({}),
  runSetup: (...args: unknown[]) => mockRunSetup(...args),
}));
vi.mock("../src/cli/doctor.js", () => ({
  runDoctor: (...args: unknown[]) => mockRunDoctor(...args),
}));

vi.mock("../src/transport/http.js", () => ({
  createHttpServer: (...args: unknown[]) => mockCreateHttpServer(...args),
}));

// ---------------------------------------------------------------------------
// Import the module under test — must be after mocks
// ---------------------------------------------------------------------------

// We dynamically import so vi.mock() hoists above the import.
// Note: ESM import() caches — every call returns the same module.
// This works because main() reads process.env at call time, not import time.
async function importMain(): Promise<{ main: () => Promise<void> }> {
  const mod = await import("../src/index.js");
  return mod;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up mocks for the happy path */
function setupHappyPath(): void {
  mockAuthenticate.mockResolvedValue("test-access-token");
  const mockClient = { get: vi.fn() };
  mockCreateWhoopClient.mockReturnValue(mockClient);
  const mockServer = { connect: mockConnect };
  mockCreateWhoopServer.mockReturnValue({ server: mockServer });
  mockConnect.mockResolvedValue(undefined);
  MockStdioServerTransport.mockImplementation(
    class {
      _mock = true;
    }
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("main() entry point", () => {
  const originalEnv = { ...process.env };
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    // Suppress console.error output during tests
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Set required env vars by default
    process.env.WHOOP_CLIENT_ID = "test-client-id";
    process.env.WHOOP_CLIENT_SECRET = "test-client-secret";
    // Silence logger output during tests (existing tests still validate console.error)
    process.env.LOG_LEVEL = "error";
    // Reset transport-related env vars so tests start from a clean slate
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_PORT;
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.MCP_HOST;
    delete process.env.MCP_ALLOWED_ORIGINS;
    delete process.env.LOG_FORMAT;
    delete process.env.WHOOP_MCP_PRIVACY_MODE;
    delete process.env.WHOOP_MCP_TELEMETRY;
    delete process.env.WHOOP_MCP_TELEMETRY_ENDPOINT;
    delete process.env.DO_NOT_TRACK;
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("CLI telemetry", () => {
    function enableTelemetry(): ReturnType<typeof vi.fn> {
      process.env.WHOOP_MCP_TELEMETRY = "1";
      process.env.WHOOP_MCP_TELEMETRY_ENDPOINT = "https://collector.example/events";
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it.each(["serve", "setup"])("records %s success without arguments", async (name) => {
      setupHappyPath();
      mockRunSetup.mockResolvedValue({
        WHOOP_MCP_TELEMETRY: "1",
        WHOOP_MCP_TELEMETRY_ENDPOINT: "https://collector.example/events",
      });
      const fetchMock = enableTelemetry();
      const { runCli } = await import("../src/index.js");
      expect(await runCli(name === "serve" ? [] : ["setup", "--client-secret", "secret"])).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const options = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(JSON.parse(options.body as string)).toEqual({
        schema_version: 1,
        package_version: expect.any(String),
        kind: "command",
        name,
        outcome: "success",
      });
      if (name === "serve")
        expect(mockCreateWhoopServer).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            telemetry: expect.objectContaining({ record: expect.any(Function) }),
          })
        );
    });

    it.each(["serve", "setup"])("preserves %s failure despite collector failure", async (name) => {
      setupHappyPath();
      mockAuthenticate.mockRejectedValue(new Error("authentication secret"));
      mockRunSetup.mockRejectedValue(new Error("setup secret"));
      const fetchMock = enableTelemetry().mockRejectedValue(new Error("collector secret"));
      const { runCli } = await import("../src/index.js");
      expect(await runCli(name === "serve" ? [] : ["setup"])).toBe(1);
      if (name === "setup") {
        expect(fetchMock).not.toHaveBeenCalled();
        return;
      }
      const options = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(JSON.parse(options.body as string)).toMatchObject({
        kind: "command",
        name,
        outcome: "error",
      });
      expect(options.body).not.toContain("secret");
    });

    it("keeps doctor and telemetry status local even when opted in", async () => {
      const fetchMock = enableTelemetry();
      const log = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      mockRunDoctor.mockResolvedValue(2);
      const { runCli } = await import("../src/index.js");
      expect(await runCli(["doctor", "--json"])).toBe(2);
      expect(mockRunDoctor).toHaveBeenCalledWith(["--json"]);
      expect(await runCli(["telemetry", "status"])).toBe(0);
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
        enabled: true,
        reason: "enabled",
      });
      expect(await runCli(["telemetry", "enable"])).toBe(1);
      expect(mockAuthenticate).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([undefined, "1"])(
      "does not send on default/opt-out configuration: %s",
      async (optOut) => {
        setupHappyPath();
        const fetchMock = enableTelemetry();
        if (optOut) process.env.DO_NOT_TRACK = optOut;
        else delete process.env.WHOOP_MCP_TELEMETRY;
        const { runCli } = await import("../src/index.js");
        expect(await runCli([])).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );
  });

  // -------------------------------------------------------------------------
  // Env var validation
  // -------------------------------------------------------------------------

  describe("environment variable validation", () => {
    it("validates privacy before authentication", async () => {
      process.env.WHOOP_MCP_PRIVACY_MODE = "raw";
      setupHappyPath();
      const { main } = await importMain();
      await expect(main()).rejects.toThrow();
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it("passes aggregate privacy to the server", async () => {
      process.env.WHOOP_MCP_PRIVACY_MODE = "aggregate";
      setupHappyPath();
      const { main } = await importMain();
      await main();
      expect(mockCreateWhoopServer).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ privacyMode: "aggregate" })
      );
    });

    it("throws when WHOOP_CLIENT_ID is missing", async () => {
      delete process.env.WHOOP_CLIENT_ID;
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_ID");
    });

    it("throws when WHOOP_CLIENT_ID is empty string", async () => {
      process.env.WHOOP_CLIENT_ID = "";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_ID");
    });

    it("throws when WHOOP_CLIENT_SECRET is missing", async () => {
      delete process.env.WHOOP_CLIENT_SECRET;
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_SECRET");
    });

    it("throws when WHOOP_CLIENT_SECRET is empty string", async () => {
      process.env.WHOOP_CLIENT_SECRET = "";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_SECRET");
    });
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe("authentication", () => {
    it("calls authenticate with client ID and secret from env", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      expect(mockAuthenticate).toHaveBeenCalledOnce();
      expect(mockAuthenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        })
      );
    });

    it("propagates authentication errors", async () => {
      setupHappyPath();
      mockAuthenticate.mockRejectedValue(new Error("OAuth flow failed"));

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("OAuth flow failed");
    });
  });

  // -------------------------------------------------------------------------
  // Client creation
  // -------------------------------------------------------------------------

  describe("WHOOP client creation", () => {
    it("creates a WHOOP client with the access token from authenticate", async () => {
      setupHappyPath();
      mockAuthenticate.mockResolvedValue("my-access-token-123");

      const { main } = await importMain();
      await main();

      expect(mockCreateWhoopClient).toHaveBeenCalledOnce();
      expect(mockCreateWhoopClient).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "my-access-token-123",
        })
      );
    });

    it("provides an onTokenRefresh callback to the client", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh?: () => Promise<string>;
      };
      expect(clientOptions.onTokenRefresh).toBeTypeOf("function");
    });
  });

  // -------------------------------------------------------------------------
  // Token refresh callback
  // -------------------------------------------------------------------------

  describe("onTokenRefresh callback", () => {
    it("loads tokens, refreshes, saves, and returns new access token", async () => {
      setupHappyPath();

      const storedTokens = {
        access_token: "old-access",
        refresh_token: "stored-refresh-token",
        expires_at: Date.now() - 1000,
        token_type: "Bearer",
      };
      mockLoadTokens.mockResolvedValue(storedTokens);

      const refreshResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read:recovery",
      };
      mockRefreshAccessToken.mockResolvedValue(refreshResponse);

      const newTokens = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_at: Date.now() + 3_600_000,
        token_type: "Bearer",
      };
      mockToOAuthTokens.mockReturnValue(newTokens);
      mockSaveTokens.mockResolvedValue(undefined);

      const { main } = await importMain();
      await main();

      // Extract the onTokenRefresh callback
      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
      };
      const newAccessToken = await clientOptions.onTokenRefresh();

      expect(mockLoadTokens).toHaveBeenCalled();
      expect(mockRefreshAccessToken).toHaveBeenCalledWith(
        "stored-refresh-token",
        expect.objectContaining({
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        })
      );
      expect(mockToOAuthTokens).toHaveBeenCalledWith(refreshResponse, "stored-refresh-token");
      expect(mockSaveTokens).toHaveBeenCalledWith(newTokens);
      expect(newAccessToken).toBe("new-access-token");
    });

    it("runs a single refresh for concurrent 401s (single-flight)", async () => {
      setupHappyPath();
      mockLoadTokens.mockResolvedValue({
        access_token: "test-access-token",
        refresh_token: "stored-refresh-token",
        expires_at: Date.now() - 1000,
        token_type: "Bearer",
      });
      let release!: (value: unknown) => void;
      mockRefreshAccessToken.mockReturnValue(new Promise((resolve) => (release = resolve)));
      mockToOAuthTokens.mockReturnValue({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_at: Date.now() + 3_600_000,
        token_type: "Bearer",
      });
      mockSaveTokens.mockResolvedValue(undefined);

      const { main } = await importMain();
      await main();
      const { onTokenRefresh } = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
      };

      const first = onTokenRefresh();
      const second = onTokenRefresh();
      release({ access_token: "new-access-token", expires_in: 3600, token_type: "Bearer" });

      await expect(Promise.all([first, second])).resolves.toEqual([
        "new-access-token",
        "new-access-token",
      ]);
      expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
    });

    it("adopts a newer token another process already saved instead of refreshing", async () => {
      setupHappyPath();
      mockLoadTokens.mockResolvedValue({
        access_token: "token-from-other-process",
        refresh_token: "rotated-refresh-token",
        expires_at: Date.now() + 3_600_000,
        token_type: "Bearer",
      });

      const { main } = await importMain();
      await main();
      const { onTokenRefresh } = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
      };

      await expect(onTokenRefresh()).resolves.toBe("token-from-other-process");
      expect(mockRefreshAccessToken).not.toHaveBeenCalled();
    });

    it("recovers when another process rotated the refresh token mid-refresh", async () => {
      setupHappyPath();
      mockLoadTokens
        .mockResolvedValueOnce({
          access_token: "test-access-token",
          refresh_token: "stale-refresh-token",
          expires_at: Date.now() - 1000,
          token_type: "Bearer",
        })
        .mockResolvedValueOnce({
          access_token: "winner-access-token",
          refresh_token: "winner-refresh-token",
          expires_at: Date.now() + 3_600_000,
          token_type: "Bearer",
        });
      mockRefreshAccessToken.mockRejectedValue(new Error("invalid_grant"));

      const { main } = await importMain();
      await main();
      const { onTokenRefresh } = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
      };

      await expect(onTokenRefresh()).resolves.toBe("winner-access-token");
    });

    it("rethrows a refresh failure when no other process has rotated the tokens", async () => {
      setupHappyPath();
      const stored = {
        access_token: "test-access-token",
        refresh_token: "dead-refresh-token",
        expires_at: Date.now() - 1000,
        token_type: "Bearer",
      };
      mockLoadTokens.mockResolvedValue(stored);
      mockRefreshAccessToken.mockRejectedValue(new Error("invalid_grant"));

      const { main } = await importMain();
      await main();
      const { onTokenRefresh } = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
      };

      await expect(onTokenRefresh()).rejects.toThrow("invalid_grant");
    });

    it("throws when no stored tokens are found", async () => {
      setupHappyPath();
      mockLoadTokens.mockResolvedValue(null);

      const { main } = await importMain();
      await main();

      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
      };
      await expect(clientOptions.onTokenRefresh()).rejects.toThrow(/no stored tokens/i);
    });

    it("clears the shared cache on token refresh", async () => {
      setupHappyPath();

      const storedTokens = {
        access_token: "old-access",
        refresh_token: "stored-refresh-token",
        expires_at: Date.now() - 1000,
        token_type: "Bearer",
      };
      mockLoadTokens.mockResolvedValue(storedTokens);

      const refreshResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read:recovery",
      };
      mockRefreshAccessToken.mockResolvedValue(refreshResponse);
      mockToOAuthTokens.mockReturnValue({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_at: Date.now() + 3_600_000,
        token_type: "Bearer",
      });
      mockSaveTokens.mockResolvedValue(undefined);

      const { main } = await importMain();
      await main();

      // The shared cache is constructed inside main() and passed to the client.
      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
        cache: { clear: () => void };
      };
      const clearSpy = vi.spyOn(clientOptions.cache, "clear");

      await clientOptions.onTokenRefresh();

      expect(clearSpy).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // MCP server creation and transport
  // -------------------------------------------------------------------------

  describe("MCP server and stdio transport", () => {
    it("creates the MCP server with the WHOOP client", async () => {
      setupHappyPath();
      const mockClient = { get: vi.fn() };
      mockCreateWhoopClient.mockReturnValue(mockClient);

      const { main } = await importMain();
      await main();

      expect(mockCreateWhoopServer).toHaveBeenCalledOnce();
      expect(mockCreateWhoopServer).toHaveBeenCalledWith(mockClient, {
        disableResources: false,
        privacyMode: "standard",
      });
    });

    it("creates a StdioServerTransport", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      expect(MockStdioServerTransport).toHaveBeenCalledOnce();
    });

    it("connects the server to the stdio transport", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      expect(mockConnect).toHaveBeenCalledOnce();
      expect(mockConnect).toHaveBeenCalledWith(mockStdioTransportInstance);
    });
  });

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  describe("stderr logging", () => {
    it("logs startup message to stderr", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      // At least one call to console.error with startup info
      const allMessages = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(allMessages).toMatch(/whoop.*mcp.*start/i);
    });
  });

  // -------------------------------------------------------------------------
  // Transport selection (MCP_TRANSPORT)
  // -------------------------------------------------------------------------

  describe("transport selection", () => {
    function setupHttpHappyPath(): void {
      const mockTransport = { _http: true };
      mockCreateHttpServer.mockResolvedValue({
        server: {},
        transport: mockTransport,
        close: mockHttpClose,
      });
    }

    it("defaults to stdio transport when MCP_TRANSPORT is unset", async () => {
      setupHappyPath();
      const { main } = await importMain();
      await main();

      expect(MockStdioServerTransport).toHaveBeenCalledOnce();
      expect(mockCreateHttpServer).not.toHaveBeenCalled();
    });

    it("explicit MCP_TRANSPORT=stdio behaves identically to default", async () => {
      process.env.MCP_TRANSPORT = "stdio";
      setupHappyPath();
      const { main } = await importMain();
      await main();

      expect(MockStdioServerTransport).toHaveBeenCalledOnce();
      expect(mockCreateHttpServer).not.toHaveBeenCalled();
    });

    it("MCP_TRANSPORT=http starts only the HTTP server (no stdio)", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "test-bearer-token-32chars-aaaa";
      process.env.MCP_PORT = "4001";
      setupHappyPath();
      setupHttpHappyPath();

      const { main } = await importMain();
      await main();

      expect(MockStdioServerTransport).not.toHaveBeenCalled();
      expect(mockCreateHttpServer).toHaveBeenCalledOnce();
      expect(mockCreateHttpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          authToken: "test-bearer-token-32chars-aaaa",
          port: 4001,
        })
      );
      // server.connect was called with the http transport
      expect(mockConnect).toHaveBeenCalledWith({ _http: true });
    });

    it("MCP_TRANSPORT=both starts both stdio AND HTTP", async () => {
      process.env.MCP_TRANSPORT = "both";
      process.env.MCP_AUTH_TOKEN = "test-bearer-token-32chars-aaaa";
      setupHappyPath();
      setupHttpHappyPath();

      const { main } = await importMain();
      await main();

      expect(MockStdioServerTransport).toHaveBeenCalledOnce();
      expect(mockCreateHttpServer).toHaveBeenCalledOnce();
      // server.connect called for both transports
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it("uses default port 3000 when MCP_PORT is unset", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "tok";
      setupHappyPath();
      setupHttpHappyPath();

      const { main } = await importMain();
      await main();

      expect(mockCreateHttpServer).toHaveBeenCalledWith(expect.objectContaining({ port: 3000 }));
    });

    it("forwards MCP_HOST and MCP_ALLOWED_ORIGINS to the HTTP server", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "tok";
      process.env.MCP_HOST = "127.0.0.1";
      process.env.MCP_ALLOWED_ORIGINS = "https://claude.ai, https://app.example.com";
      setupHappyPath();
      setupHttpHappyPath();

      const { main } = await importMain();
      await main();

      expect(mockCreateHttpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "127.0.0.1",
          allowedOrigins: ["https://claude.ai", "https://app.example.com"],
        })
      );
    });

    it("MCP_TRUST_PROXY=1 enables trustProxy on the HTTP server", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "tok";
      process.env.MCP_TRUST_PROXY = "1";
      setupHappyPath();
      setupHttpHappyPath();

      const { main } = await importMain();
      await main();
      delete process.env.MCP_TRUST_PROXY;

      expect(mockCreateHttpServer).toHaveBeenCalledWith(
        expect.objectContaining({ trustProxy: true })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Configuration validation errors
  // -------------------------------------------------------------------------

  describe("configuration validation", () => {
    it("throws on invalid MCP_TRANSPORT value", async () => {
      process.env.MCP_TRANSPORT = "websocket";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/MCP_TRANSPORT/);
    });

    it("throws when MCP_TRANSPORT=http but MCP_AUTH_TOKEN is missing", async () => {
      process.env.MCP_TRANSPORT = "http";
      delete process.env.MCP_AUTH_TOKEN;
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/MCP_AUTH_TOKEN/);
    });

    it("throws on non-numeric MCP_PORT", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "tok";
      process.env.MCP_PORT = "abc";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/MCP_PORT/);
    });

    it("throws on out-of-range MCP_PORT", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "tok";
      process.env.MCP_PORT = "99999";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/MCP_PORT/);
    });

    it("throws on invalid LOG_LEVEL", async () => {
      process.env.LOG_LEVEL = "verbose";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/LOG_LEVEL/);
    });

    it("throws on invalid LOG_FORMAT", async () => {
      process.env.LOG_FORMAT = "yaml";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/LOG_FORMAT/);
    });

    it("accepts LOG_LEVEL=debug", async () => {
      process.env.LOG_LEVEL = "debug";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).resolves.toBeUndefined();
    });
  });
});
