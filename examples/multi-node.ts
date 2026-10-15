// One homeserver spread over several machines that share a single Postgres database.
//
// Run this same file on every machine and put a load balancer in front of them. Any instance
// can serve any request (client or federation API, including long-polling /sync): they
// coordinate through the shared cluster adapter, so no sticky sessions are needed.
//
//   npm install pg            # and `ioredis` to coordinate through Redis instead of Postgres
//   DATABASE_URL=postgres://matrix:secret@db.internal/matrix \
//   SERVER_NAME=example.com PUBLIC_BASE_URL=https://matrix.example.com \
//   node examples/multi-node.ts
//
// Everything an instance keeps has to be shared too:
// - rooms, accounts, keys: the database (the signing key is created there by the first instance);
// - wakeups, locks, stream positions, caches: the cluster adapter (Postgres LISTEN/NOTIFY, or Redis);
// - uploaded files: the media adapter. Local disks would differ per machine, so files go to an S3
//   bucket when S3_BUCKET is set (S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and
//   S3_ENDPOINT for MinIO/R2/...), and to Postgres otherwise.
import { createServer } from "node:http";
import {
  createHomeserver,
  getNodeHandler,
  s3Media,
  postgresAdapter,
  postgresCluster,
  redisCluster,
  type ClusterAdapter,
  type MediaAdapter,
} from "../src/index.ts";

// Database drivers are optional dependencies of the library: load them by name.
const pgModule: string = "pg";
const { default: pg } = await import(pgModule);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

let cluster: ClusterAdapter;
if (process.env.REDIS_URL) {
  const redisModule: string = "ioredis";
  const { default: Redis } = await import(redisModule);
  // Pub/sub needs a connection of its own.
  cluster = redisCluster({ client: new Redis(process.env.REDIS_URL), subscriber: new Redis(process.env.REDIS_URL) });
} else {
  cluster = postgresCluster(pool);
}

/** Media files in Postgres, so that every machine sees every upload. */
function postgresMedia(pool: any): MediaAdapter {
  const ready = pool.query("CREATE TABLE IF NOT EXISTS media_blobs (media_id TEXT PRIMARY KEY, data BYTEA NOT NULL)");
  return {
    async put(mediaId, data) {
      await ready;
      await pool.query(
        "INSERT INTO media_blobs (media_id, data) VALUES ($1, $2) ON CONFLICT (media_id) DO UPDATE SET data = EXCLUDED.data",
        [mediaId, Buffer.from(data)],
      );
    },
    async get(mediaId) {
      await ready;
      const { rows } = await pool.query("SELECT data FROM media_blobs WHERE media_id = $1", [mediaId]);
      return rows[0] ? new Uint8Array(rows[0].data) : null;
    },
    async delete(mediaId) {
      await ready;
      await pool.query("DELETE FROM media_blobs WHERE media_id = $1", [mediaId]);
    },
  };
}

const homeserver = createHomeserver({
  homeserver: process.env.SERVER_NAME ?? "localhost",
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  databaseAdapter: postgresAdapter(pool),
  cluster,
  mediaAdapter: process.env.S3_BUCKET
    ? s3Media({
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION ?? "us-east-1",
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
      endpoint: process.env.S3_ENDPOINT,
    })
    : postgresMedia(pool),
  // Same behaviour as examples/node-http.ts: the first account becomes the admin.
  userAuthAdapter: { registrationEnabled: false },
  adminRoom: { firstUserIsAdmin: true },
  audit: { enabled: true },
  // Rate limits are counted per instance by default; plug in a shared limiter
  // (`rateLimits: { limiter, rules }`) to enforce them across all machines.
});

const server = createServer(getNodeHandler(homeserver));
server.listen(Number(process.env.PORT ?? 8008), () => console.log("Matrix homeserver instance listening on", server.address()));

process.on("SIGTERM", async () => {
  // Release long-polling /sync requests and stop background work, then drain connections.
  await homeserver.close();
  server.close(() => void pool.end().finally(() => process.exit(0)));
});
