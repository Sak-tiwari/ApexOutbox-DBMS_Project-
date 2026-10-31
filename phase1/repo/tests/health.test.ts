import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/api/app.js";

describe("health endpoints", () => {
  it("/health is up even if dependencies are down", async () => {
    const app = createApp({ mongo: () => false, redis: () => false });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("/ready returns 200 when both dependencies are up", async () => {
    const app = createApp({ mongo: () => true, redis: () => true });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ mongo: "up", redis: "up" });
  });

  it("/ready returns 503 when a dependency is down or throws", async () => {
    const app = createApp({
      mongo: () => true,
      redis: () => {
        throw new Error("connection refused");
      },
    });
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ mongo: "up", redis: "down" });
  });

  it("unknown routes return a JSON 404", async () => {
    const app = createApp({ mongo: () => true, redis: () => true });
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
