import express from "express";
import cors from "cors";
import matchRoutes from "./routes/match.js";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  app.get("/", (_, res) => res.send("OK: job-match-backend running"));

  // Routes
  app.use("/", matchRoutes);

  return app;
}
