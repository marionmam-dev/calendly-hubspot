import dotenv from "dotenv";
dotenv.config();

import express from "express";
import calendlyHandler from "./calendlyHandler.mjs";

const app = express();
const PORT = process.env.PORT || 3000;

// raw body obligatoire pour signature Calendly
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// webhook Calendly
app.post("/calendly", calendlyHandler);

// health check Render
app.get("/", (req, res) => {
  res.send("OK - Calendly HubSpot service running");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});