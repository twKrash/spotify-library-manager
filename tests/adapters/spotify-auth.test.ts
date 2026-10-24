import assert from "node:assert/strict";
import test from "node:test";
import { SpotifyAuthError, SpotifyAuthService } from "../../src/adapters/spotify-auth.ts";
import type { AppConfig } from "../../src/config.ts";
import type { TokenStore } from "../../src/ports/token-store.ts";

const config: AppConfig = {
  clientId: "test-client-id",
  clientSecret: "sensitive-client-secret",
  redirectUri: "http://127.0.0.1:8765/callback",
  port: 8765,
  resultsDir: "results",
};

function memoryTokens(initial: string | null = null): TokenStore & { value: string | null } {
  return {
    value: initial,
    async load() { return this.value; },
    async save(refreshToken) { this.value = refreshToken; },
    async clear() { this.value = null; },
  };
}

function tokenResponse(accessToken: string, refreshToken?: string): Response {
  return new Response(JSON.stringify({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("connection status reflects whether a refresh token is saved", async () => {
  assert.equal(await new SpotifyAuthService(config, memoryTokens()).isConnected(), false);
  assert.equal(await new SpotifyAuthService(config, memoryTokens("saved-refresh")).isConnected(), true);
});

test("authorization URL uses the configured local callback and never exposes the client secret", () => {
  const auth = new SpotifyAuthService(config, memoryTokens());
  const url = new URL(auth.beginAuthorization());

  assert.equal(url.origin, "https://accounts.spotify.com");
  assert.equal(url.pathname, "/authorize");
  assert.equal(url.searchParams.get("client_id"), config.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state")?.length, 43);
  assert.deepEqual(new Set(url.searchParams.get("scope")?.split(" ")), new Set([
    "user-library-read", "user-library-modify", "user-top-read", "user-read-recently-played",
  ]));
  assert.doesNotMatch(url.href, /sensitive-client-secret/);
});

test("authorization state generation failures are sanitized", () => {
  const auth = new SpotifyAuthService(config, memoryTokens(), undefined, undefined, () => {
    throw new Error("provider details");
  });

  assert.throws(() => auth.beginAuthorization(), (error: unknown) => {
    assert.ok(error instanceof SpotifyAuthError);
    assert.equal(error.message, "Unable to start Spotify authorization.");
    assert.doesNotMatch(error.message, /provider details/);
    return true;
  });
});

test("callback rejects mismatched and reused state values", async () => {
  let requests = 0;
  const auth = new SpotifyAuthService(config, memoryTokens(), async () => {
    requests++;
    return tokenResponse("access", "refresh");
  });
  const url = new URL(auth.beginAuthorization());

  const state = url.searchParams.get("state")!;
  await assert.rejects(auth.completeAuthorization(new URLSearchParams({ code: "code", state: "wrong" })), SpotifyAuthError);
  assert.equal(requests, 0);

  await auth.completeAuthorization(new URLSearchParams({ code: "code", state }));
  await assert.rejects(auth.completeAuthorization(new URLSearchParams({ code: "code", state })), SpotifyAuthError);
  assert.equal(requests, 1);
});

test("authorization denial is handled without exchanging the code or revealing credentials", async () => {
  let requests = 0;
  const auth = new SpotifyAuthService(config, memoryTokens(), async () => {
    requests++;
    return tokenResponse("access", "refresh");
  });
  const state = new URL(auth.beginAuthorization()).searchParams.get("state")!;

  await assert.rejects(auth.completeAuthorization(new URLSearchParams({ error: "access_denied", state })), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /authorization failed/i);
    assert.doesNotMatch(error.message, /sensitive-client-secret|access_denied/);
    return true;
  });
  assert.equal(requests, 0);
});

test("callback stores the refresh token and refreshes expired access tokens", async () => {
  const tokens = memoryTokens();
  const bodies: URLSearchParams[] = [];
  let now = 1_000;
  let exchangeCount = 0;
  const auth = new SpotifyAuthService(config, tokens, async (_url, init) => {
    const body = init?.body;
    assert.ok(body instanceof URLSearchParams);
    bodies.push(body);
    exchangeCount++;
    return exchangeCount === 1
      ? tokenResponse("first-access", "first-refresh")
      : tokenResponse("second-access", "rotated-refresh");
  }, () => now);
  const state = new URL(auth.beginAuthorization()).searchParams.get("state")!;

  await auth.completeAuthorization(new URLSearchParams({ code: "temporary-code", state }));
  assert.equal(tokens.value, "first-refresh");
  assert.equal(await auth.getAccessToken(), "first-access");
  now += 3_600_000;
  assert.equal(await auth.getAccessToken(), "second-access");
  assert.equal(tokens.value, "rotated-refresh");
  assert.equal(exchangeCount, 2);
  assert.equal(bodies[0]?.get("grant_type"), "authorization_code");
  assert.equal(bodies[0]?.get("code"), "temporary-code");
  assert.equal(bodies[1]?.get("grant_type"), "refresh_token");
  assert.equal(bodies[1]?.get("refresh_token"), "first-refresh");
});

test("refresh failures return a safe error and do not expose the client secret", async () => {
  const auth = new SpotifyAuthService(config, memoryTokens("saved-refresh"), async () => new Response(
    JSON.stringify({ error: "invalid_client", error_description: "sensitive-client-secret" }),
    { status: 401, headers: { "content-type": "application/json" } },
  ));

  await assert.rejects(auth.getAccessToken(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /refresh failed/i);
    assert.doesNotMatch(error.message, /sensitive-client-secret|invalid_client/);
    return true;
  });
});
