import * as oauth from "oauth4webapi";
import type { AppConfig } from "../config.js";
import type { TokenStore } from "../ports/token-store.js";

const AUTHORIZATION_ENDPOINT = "https://accounts.spotify.com/authorize";
const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const AUTHORIZATION_SERVER: oauth.AuthorizationServer = {
  issuer: "https://accounts.spotify.com",
  authorization_endpoint: AUTHORIZATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["client_secret_basic"],
};
const SCOPES = [
  "user-library-read",
  "user-library-modify",
  "user-top-read",
  "user-read-recently-played",
] as const;
const STATE_TTL_MS = 10 * 60 * 1000;

export class SpotifyAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpotifyAuthError";
  }
}

export class SpotifyAuthService {
  private readonly client: oauth.Client;
  private readonly clientAuthentication: oauth.ClientAuth;
  private readonly pendingStates = new Map<string, number>();
  private readonly customFetch: NonNullable<oauth.TokenEndpointRequestOptions[typeof oauth.customFetch]>;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly tokenStore: TokenStore,
    fetcher: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
    private readonly stateGenerator: () => string = oauth.generateRandomState,
  ) {
    this.client = { client_id: config.clientId };
    this.clientAuthentication = oauth.ClientSecretBasic(config.clientSecret);
    this.customFetch = (url, options) => fetcher(url, options);
  }

  beginAuthorization(): string {
    const now = this.now();
    for (const [state, expiresAt] of this.pendingStates) {
      if (expiresAt <= now) this.pendingStates.delete(state);
    }

    let state: string;
    try {
      state = this.stateGenerator();
    } catch {
      throw new SpotifyAuthError("Unable to start Spotify authorization.");
    }
    this.pendingStates.set(state, now + STATE_TTL_MS);
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      redirect_uri: this.config.redirectUri,
      scope: SCOPES.join(" "),
      state,
    }).toString();
    return url.toString();
  }

  async completeAuthorization(parameters: URLSearchParams): Promise<void> {
    const states = parameters.getAll("state");
    if (states.length !== 1) throw new SpotifyAuthError("OAuth state is missing or invalid.");
    const state = states[0];
    if (!state) throw new SpotifyAuthError("OAuth state is missing or invalid.");
    const expiresAt = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    if (expiresAt === undefined || expiresAt <= this.now()) {
      throw new SpotifyAuthError("OAuth state is missing or invalid.");
    }

    let callbackParameters: URLSearchParams;
    try {
      callbackParameters = oauth.validateAuthResponse(AUTHORIZATION_SERVER, this.client, parameters, state);
    } catch (error) {
      throw new SpotifyAuthError("Spotify authorization failed. Start again from the app.", { cause: error });
    }

    try {
      const response = await oauth.authorizationCodeGrantRequest(
        AUTHORIZATION_SERVER,
        this.client,
        this.clientAuthentication,
        callbackParameters,
        this.config.redirectUri,
        oauth.nopkce,
        { [oauth.customFetch]: this.customFetch },
      );
      const token = await oauth.processAuthorizationCodeResponse(AUTHORIZATION_SERVER, this.client, response);
      if (!token.refresh_token) throw new Error("Refresh token missing");
      await this.tokenStore.save(token.refresh_token);
      this.cacheAccessToken(token);
    } catch (error) {
      throw new SpotifyAuthError("Spotify authorization failed. Start again from the app.", { cause: error });
    }
  }

  async isConnected(): Promise<boolean> {
    if (this.accessToken && this.accessTokenExpiresAt > this.now()) return true;
    return Boolean(await this.tokenStore.load());
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessTokenExpiresAt > this.now()) return this.accessToken;

    const refreshToken = await this.tokenStore.load();
    if (!refreshToken) throw new SpotifyAuthError("Spotify is not connected. Use the app's Connect action.");

    try {
      const response = await oauth.refreshTokenGrantRequest(
        AUTHORIZATION_SERVER,
        this.client,
        this.clientAuthentication,
        refreshToken,
        { [oauth.customFetch]: this.customFetch },
      );
      const token = await oauth.processRefreshTokenResponse(AUTHORIZATION_SERVER, this.client, response);
      if (token.refresh_token) await this.tokenStore.save(token.refresh_token);
      this.cacheAccessToken(token);
      return token.access_token;
    } catch (error) {
      throw new SpotifyAuthError("Spotify token refresh failed. Reconnect the app if the problem continues.", { cause: error });
    }
  }

  private cacheAccessToken(token: oauth.TokenEndpointResponse): void {
    this.accessToken = token.access_token;
    this.accessTokenExpiresAt = this.now() + (token.expires_in ?? 3600) * 1000;
  }
}
