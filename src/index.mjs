import dotenv from "dotenv";
dotenv.config();
import express from "express";
import calendlyHandler from "./calendlyHandler.mjs";




const PORT = process.env.PORT || 3000;
const app = express();

// Middleware pour capturer le body brut
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));

// Webhook Calendly
app.post("/calendly", calendlyHandler);

// Endpoint OAuth Calendly
app.post("/calendly/oauth/callback", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).send("Code OAuth manquant");

  try {
    const { getCalendlyAccessToken } = await import("./calendlyHandler.mjs");
    const tokenData = await getCalendlyAccessToken(code);
    console.log("📌 Token OAuth Calendly :", tokenData);
    res.status(200).json(tokenData);
  } catch (err) {
    console.error("❌ Erreur récupération token Calendly :", err.response?.data || err);
    res.status(500).send("Erreur récupération token");
  }
});

// Endpoint test utilisateur Calendly
app.get("/calendly/me", async (req, res) => {
  const accessToken = req.headers["authorization"]?.split(" ")[1];
  if (!accessToken) return res.status(400).send("Access token manquant");

  try {
    const { getCalendlyUser } = await import("./calendlyHandler.mjs");
    const userData = await getCalendlyUser(accessToken);
    res.status(200).json(userData);
  } catch (err) {
    console.error("❌ Erreur API Calendly :", err.response?.data || err);
    res.status(500).send("Erreur API Calendly");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});
