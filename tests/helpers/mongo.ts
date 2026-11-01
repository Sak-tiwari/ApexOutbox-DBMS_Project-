import mongoose from "mongoose";

const BASE = process.env.TEST_MONGODB_URI ?? "mongodb://127.0.0.1:27017";

/** True when a MongoDB-compatible server answers at TEST_MONGODB_URI (default: local 27017). */
export async function mongoAvailable(): Promise<boolean> {
  const conn = mongoose.createConnection(`${BASE}/probe`, { serverSelectionTimeoutMS: 1500 });
  try { await conn.asPromise(); await conn.close(); return true; } catch { try { await conn.close(); } catch {} return false; }
}

export async function connectTestDb(name: string): Promise<string> {
  const uri = `${BASE}/${name}_${Date.now()}`;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  return uri;
}

export async function dropAndDisconnect() {
  await mongoose.connection.db?.dropDatabase();
  await mongoose.disconnect();
}

export type MongoEngine = "none" | "ferretdb" | "mongodb";

/** Which engine answers? FerretDB speaks the MongoDB protocol but does not give atomic concurrent updates. */
export async function mongoEngine(): Promise<MongoEngine> {
  const conn = mongoose.createConnection(`${BASE}/probe`, { serverSelectionTimeoutMS: 1500 });
  try {
    await conn.asPromise();
    const info = await conn.db!.admin().command({ buildInfo: 1 });
    await conn.close();
    return info.ferretdbVersion ? "ferretdb" : "mongodb";
  } catch {
    try { await conn.close(); } catch {}
    return "none";
  }
}
