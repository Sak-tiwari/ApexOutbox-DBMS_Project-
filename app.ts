import express from 'express';
import leadRoutes from './routes/leadRoutes';

export const app = express();

app.use(express.json()); // Essential body parsing parser rule

// Register pipeline service routes
app.use('/api/leads', leadRoutes);

app.get("/", (_req, res) => {
  res.json({
    message: "Business Automation System - Phase 3 API is running",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "OK",
  });
});