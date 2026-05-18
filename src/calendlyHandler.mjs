import crypto from "crypto";
import axios from "axios";

const VERIFY_SIGNATURE = process.env.CALENDLY_WEBHOOK_VERIFY === "true";

// 🔐 Signature Calendly
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

// 🔹 Mapping questions Calendly → HubSpot
const questionMap = {
  "Que souhaitez-vous faire chez Sym Optic ?": "calendly_answer_1",
  "Numéro de téléphone": "calendly_answer_2",
  "Date de naissance": "calendly_answer_3",
  "Diabète": "calendly_answer_4",
  "Glaucome / Cataracte / DMLA": "calendly_answer_5",
  "Dernières lunettes": "calendly_answer_6",
  "Nom de la mutuelle": "calendly_answer_8",
  "Comment nous avez-vous connus ?": "calendly_answer_9",
  "Adresse postale": "address"
};

// 🔁 retry HubSpot (15s, 5s, 10s)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findContactWithRetry(email, token) {
  const delays = [15000, 5000, 10000];

  for (let i = 0; i < delays.length + 1; i++) {
    try {
      const res = await axios.post(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        {
          filterGroups: [{
            filters: [{
              propertyName: "email",
              operator: "EQ",
              value: email
            }]
          }],
          limit: 1
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (res.data.results?.length) {
        return res.data.results[0].id;
      }

      if (i < delays.length) {
        console.log(`⏳ Tentative ${i + 1} : contact introuvable`);
        console.log(`⏳ Attente ${delays[i] / 1000}s`);
        await sleep(delays[i]);
      }

    } catch (err) {
      console.error("❌ HubSpot search error:", err.response?.data || err.message);
    }
  }

  return null;
}

// 🔹 Handler principal
export default async function calendlyHandler(req, res) {
  console.log("📩 Webhook Calendly reçu");

  const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
  if (!HUBSPOT_TOKEN) {
    console.error("❌ HUBSPOT_TOKEN manquant");
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
    return res.status(200).send("No email");
  }

  const email = invitee.email.toLowerCase();
  const event = invitee.scheduled_event || {};

  // 🔎 CONTACT
  const contactId = await findContactWithRetry(email, HUBSPOT_TOKEN);

  if (!contactId) {
    console.warn("⚠️ Contact introuvable après retry");
    return res.status(200).send("Contact not found");
  }

  console.log("✔ Contact OK :", contactId);

  // 🧩 questions
  const questionProperties = {};
  for (const qa of invitee.questions_and_answers || []) {
    const key = questionMap[qa.question];
    if (key) questionProperties[key] = qa.answer;
  }

  // 🧾 payload HubSpot
  const contactProps = {
    firstname: invitee.first_name,
    lastname: invitee.last_name,
    calendly_event_start: event.start_time,
    calendly_event_end: event.end_time,
    calendly_cancel_url: invitee.cancel_url,
    calendly_reschedule_url: invitee.reschedule_url,
    calendly_invitee_uri: invitee.uri,
    ...questionProperties
  };

  try {
    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      { properties: contactProps },
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✔ Contact enrichi");
  } catch (err) {
    console.error("❌ Worker crash:", err.response?.data || err.message);
  }

  res.status(200).send("Webhook traité");
}