
import "dotenv/config";
import mongoose from "mongoose";
import { app } from "./app.js";

const PORT = Number(process.env.PORT ?? 3000);

async function startServer() {
    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
        throw new Error("MONGODB_URI is missing from your .env file.");
    }

    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB successfully.");

    app.listen(PORT, () => {
        console.log(`Phase 3 server running at http://localhost:${PORT}`);
    });
}

startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
