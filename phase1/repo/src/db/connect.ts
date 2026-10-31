import mongoose from "mongoose";
import { Redis } from "ioredis";

export async function connectMongo(uri: string): Promise<typeof mongoose> {
  mongoose.set("strictQuery", true);
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
}

export function createRedis(url: string): Redis {
  // BullMQ requires maxRetriesPerRequest: null for its blocking connections.
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
}

/** Mongoose readyState 1 === connected. */
export function mongoIsReady(): boolean {
  return mongoose.connection.readyState === 1;
}
