import crypto from "crypto";
import axios from "axios";

const VERIFY_SIGNATURE = process.env.CALENDLY_WEBHOOK_VERIFY === "true";

function verifyCalendlySignature(req) {
  const key = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;

  if (!key) return true;

  const header = req.headers["calendly-webhook-signature"];
  if (!header) return false;

  const match = header.match(/t=(\d+),v1=(.+)/);
  if (!match) return false;

  const [, timestamp, signatureReceived] = match;

  const hmac = crypto.createHmac("sha256", key);
  hmac.update(`${timestamp}.${req.rawBody}`);

  return hmac.digest("hex") === signatureReceived;
}

// 🔥 WEBHOOK ULTRA LIGHT
export default async function calendlyHandler(req, res) {
  console.log("📩 Webhook Calendly reçu");

  const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
  if (!HUBSPOT_TOKEN) {
    return res.status(500).send("Missing config");
  }

  if (VERIFY_SIGNATURE && !verifyCalendlySignature(req)) {
    return res.status(401).send("Invalid signature");
  }

  let payload;
  try {
    payload = JSON.parse(req.rawBody);
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  const invitee = payload.payload;

  if (!invitee?.email) {
    return res.status(200).send("skip");
  }

  // 🚀 ENQUEUE WORKER
  try {
    await axios.post(`${process.env.BASE_URL}/worker`, {
      invitee
    });
  } catch (err) {
    console.error("❌ Worker dispatch error:", err.message);
  }

  // IMPORTANT: réponse immédiate
  res.status(200).send("ok");
}