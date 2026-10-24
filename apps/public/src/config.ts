import { githubProvider, type SsoProvider } from "@katrix/server";

/** Configuration of the public server, read from the environment. */
export interface PublicConfig {
  serverName: string;
  publicBaseUrl: string;
  port: number;
  /** Postgres; without it, SQLite in `dataDir` (for trying the app without a database). */
  databaseUrl: string | null;
  /** Connections to Postgres. Default 10 (managed databases limit them per plan). */
  dbPool: number;
  dataDir: string;
  /** The only way to sign in: GitHub in production, the development identity provider locally. */
  provider: SsoProvider;
  termsUrl?: string;
  policyUrl?: string;
  /** User IDs that are server admins (set when the account is created, and at every start). */
  admins: string[];
  /**
   * The MatrixRTC authorization service (lk-jwt-service) for Element Call and Element X, reached
   * by the server at this URL and by clients through `{publicBaseUrl}/livekit/jwt/`.
   */
  livekitJwtUrl: string | null;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function loginProvider(env: NodeJS.ProcessEnv): SsoProvider {
  const kind = env.LOGIN_PROVIDER ?? (env.GITHUB_CLIENT_ID ? "github" : env.DEV_IDP_ISSUER ? "dev" : "");
  if (kind === "github")
    return githubProvider({ clientId: required(env, "GITHUB_CLIENT_ID"), clientSecret: required(env, "GITHUB_CLIENT_SECRET") });
  if (kind === "dev")
    return {
      id: "dev",
      name: "Dev login",
      issuer: required(env, "DEV_IDP_ISSUER"),
      clientId: required(env, "DEV_IDP_CLIENT_ID"),
      clientSecret: required(env, "DEV_IDP_CLIENT_SECRET"),
      // The dev users' emails are alice@dev.localhost and so on.
      mapUser: (claims) => ({ localpart: String(claims.email).split("@")[0].toLowerCase(), displayname: claims.name }),
    };
  throw new Error("Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (production) or DEV_IDP_ISSUER (local development)");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PublicConfig {
  const serverName = required(env, "SERVER_NAME");
  return {
    serverName,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `https://${serverName}`).replace(/\/$/, ""),
    port: Number(env.PORT ?? 8008),
    databaseUrl: env.DATABASE_URL || null,
    dbPool: Number(env.DB_POOL ?? 10),
    dataDir: env.DATA_DIR ?? "./data",
    provider: loginProvider(env),
    termsUrl: env.TERMS_URL || undefined,
    policyUrl: env.POLICY_URL || undefined,
    livekitJwtUrl: (env.LIVEKIT_JWT_URL || "").replace(/\/$/, "") || null,
    admins: (env.ADMINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
