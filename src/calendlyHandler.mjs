import crypto from "crypto";
import axios from "axios";

const VERIFY_SIGNATURE = process.env.CALENDLY_WEBHOOK_VERIFY === "true";

// 🔐 Vérification signature Calendly
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

// 🎂 Conversion date de naissance Calendly → HubSpot date
function parseBirthDate(value) {
  if (!value) return null;

  let clean = value.trim();

  let day;
  let month;
  let year;

  // DD/MM/YYYY
  let match = clean.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

  // DD-MM-YYYY
  if (!match) {
    match = clean.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  }

  // DDMMYYYY
  if (!match) {
    match = clean.match(/^(\d{2})(\d{2})(\d{4})$/);
  }

  // DD/MM/YY ou DD-MM-YY ou DDMMYY
  if (!match) {
    match = clean.match(/^(\d{2})[\/-]?(\d{2})[\/-]?(\d{2})$/);
  }

  if (!match) {
    console.warn(`⚠️ Format date naissance ignoré : ${value}`);
    return null;
  }

  [, day, month, year] = match;

  day = Number(day);
  month = Number(month);
  year = Number(year);

  // Année courte
  if (year < 100) {
    year = year <= 30 ? 2000 + year : 1900 + year;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  // Vérification date réelle
  if (
    date.getUTCDate() !== day ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCFullYear() !== year
  ) {
    console.warn(`⚠️ Date invalide ignorée : ${value}`);
    return null;
  }

  console.log(
    `🎂 Date de naissance convertie : ${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`
  );

  return date.getTime();
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

  // 🧩 QUESTIONS CALENDLY
const questionProperties = {};

let birthDateValue = null;

for (const qa of invitee.questions_and_answers || []) {

  console.log("📝", qa.question, "=>", qa.answer);

  const key = questionMap[qa.question];

  if (key) {
    questionProperties[key] = qa.answer;
  }

  if (qa.question === "Date de naissance Calendly") {
    birthDateValue = parseBirthDate(qa.answer);
  }
}

if (birthDateValue) {
  questionProperties.date_de_naissance = birthDateValue;
}

  // 🧾 UPDATE CONTACT HUBSPOT
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

  // 🏢 ENTREPRISE (search → create → associate)
  const companyName = event.name;
  const companyLocation = event.location?.location || "";
  const organizerName = event.event_memberships?.[0]?.user_name || "";

  if (companyName) {
    try {
      const companySearch = await axios.post(
        "https://api.hubapi.com/crm/v3/objects/companies/search",
        {
          filterGroups: [{
            filters: [{
              propertyName: "name",
              operator: "EQ",
              value: companyName
            }]
          }],
          limit: 1
        },
        {
          headers: {
            Authorization: `Bearer ${HUBSPOT_TOKEN}`,
            "Content-Type": "application/json"
          }
        }
      );

      let companyId;

      if (companySearch.data.total > 0) {
        companyId = companySearch.data.results[0].id;
        console.log("🏢 Entreprise trouvée :", companyId);
      } else {
        const created = await axios.post(
          "https://api.hubapi.com/crm/v3/objects/companies",
          {
            properties: {
              name: companyName,
              address: companyLocation,
              opticien_sur_zone: organizerName
            }
          },
          {
            headers: {
              Authorization: `Bearer ${HUBSPOT_TOKEN}`,
              "Content-Type": "application/json"
            }
          }
        );

        companyId = created.data.id;
        console.log("🏢 Entreprise créée :", companyId);
      }

      // 🔗 association contact ↔ company
      const assocCheck = await axios.get(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/companies`,
        {
          headers: {
            Authorization: `Bearer ${HUBSPOT_TOKEN}`,
            "Content-Type": "application/json"
          }
        }
      );

      const existing = (assocCheck.data.results || []).map(r => String(r.id));

      if (!existing.includes(String(companyId))) {
        await axios.post(
          "https://api.hubapi.com/crm/v3/associations/contact/company/batch/create",
          {
            inputs: [{
              from: { id: contactId },
              to: { id: companyId },
              type: "contact_to_company"
            }]
          },
          {
            headers: {
              Authorization: `Bearer ${HUBSPOT_TOKEN}`,
              "Content-Type": "application/json"
            }
          }
        );

        console.log("🔗 Contact ↔ Entreprise associé");
      } else {
        console.log("ℹ️ Déjà associé");
      }

    } catch (err) {
      console.error("❌ Erreur entreprise :", err.response?.data || err.message);
    }
  }

  res.status(200).send("Webhook traité");
}