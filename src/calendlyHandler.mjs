import crypto from "crypto";
import axios from "axios";

const VERIFY_SIGNATURE = process.env.CALENDLY_WEBHOOK_VERIFY === "true";

// 🔹 Delay helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 🔐 Vérifie la signature du webhook Calendly
function verifyCalendlySignature(req) {
  const CALENDLY_WEBHOOK_KEY = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;

  if (!CALENDLY_WEBHOOK_KEY) {
    console.warn("⚠️ CALENDLY_WEBHOOK_KEY non défini, vérification désactivée !");
    return true;
  }

  const header = req.headers["calendly-webhook-signature"];
  if (!header) return false;

  const match = header.match(/t=(\d+),v1=(.+)/);
  if (!match) return false;

  const [_, timestamp, signatureReceived] = match;
  const hmac = crypto.createHmac("sha256", CALENDLY_WEBHOOK_KEY);
  hmac.update(`${timestamp}.${req.rawBody}`);
  const expectedSignature = hmac.digest("hex");

  return signatureReceived === expectedSignature;
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

// 🔹 Polling pour rechercher le contact sur HubSpot
async function findHubspotContact(email, HUBSPOT_TOKEN, retries = 6, interval = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      const searchRes = await axios.post(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        {
          filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
          limit: 1
        },
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" } }
      );

      if (searchRes.data.total > 0) {
        return searchRes.data.results[0].id;
      }

      console.log(`⏳ Contact non trouvé, tentative ${i + 1}/${retries}…`);
      await sleep(interval);
    } catch (err) {
      console.error("❌ Erreur recherche contact :", err.response?.data || err.message);
    }
  }

  return null; // Toujours pas trouvé après toutes les tentatives
}

// 🔹 Handler principal
export default async function calendlyHandler(req, res) {
  console.log("📩 Webhook Calendly reçu");

  const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
  if (!HUBSPOT_TOKEN) {
    console.error("❌ HUBSPOT_TOKEN manquant");
    return res.status(500).send("Config manquante");
  }

  if (VERIFY_SIGNATURE && !verifyCalendlySignature(req)) {
    return res.status(401).send("Signature invalide");
  }

  let payload;
  try {
    payload = JSON.parse(req.rawBody);
  } catch {
    return res.status(400).send("JSON invalide");
  }

  const invitee = payload.payload;
  if (!invitee?.email) {
    return res.status(200).send("Pas d’email, skip");
  }

  const email = invitee.email.toLowerCase();
  const scheduledEvent = invitee.scheduled_event || {};

  // === Recherche contact avec polling
  const contactId = await findHubspotContact(email, HUBSPOT_TOKEN);
  if (!contactId) {
    console.warn("⚠️ Contact introuvable après plusieurs tentatives, abandon");
    return res.status(200).send("Contact non trouvé après plusieurs tentatives");
  }

  console.log("✔ Contact trouvé :", contactId);

  // === Propriétés Calendly → HubSpot
  const questionProperties = {};
  for (const qa of invitee.questions_and_answers || []) {
    if (questionMap[qa.question]) {
      questionProperties[questionMap[qa.question]] = qa.answer;
    }
  }

  const cancelUrl = invitee.cancel_url || "";
  const eventID = cancelUrl.split("/").pop();

  let heureRdv = "";
  let jourRdv = "";
  if (scheduledEvent.start_time) {
    const dateObj = new Date(scheduledEvent.start_time);
    heureRdv = dateObj.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
    jourRdv = dateObj.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long" });
  }

  const contactProps = {
    firstname: invitee.first_name || undefined,
    lastname: invitee.last_name || undefined,
    calendly_event_uuid: scheduledEvent.uri?.split("/").pop(),
    calendly_event_start: scheduledEvent.start_time,
    calendly_event_end: scheduledEvent.end_time,
    calendly_location: scheduledEvent.location?.location,
    calendly_cancel_url: invitee.cancel_url,
    calendly_reschedule_url: invitee.reschedule_url,
    calendly_invitee_uri: invitee.uri,
    event_id: eventID,
    heure_rdv: heureRdv,
    calendly_jour_meeting: jourRdv,
    ...questionProperties
  };

  try {
    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      { properties: contactProps },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("✔ Contact enrichi");
  } catch (err) {
    console.error("❌ Erreur mise à jour contact :", err.response?.data || err.message);
  }

  // === Entreprise (search → create → associate)
  const companyName = scheduledEvent.name;
  const companyLocation = scheduledEvent.location?.location || "";
  const organizerName = scheduledEvent.event_memberships?.[0]?.user_name || "";

  if (companyName) {
    let companyId;
    try {
      const companySearch = await axios.post(
        "https://api.hubapi.com/crm/v3/objects/companies/search",
        {
          filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: companyName }] }],
          limit: 1
        },
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" } }
      );

      if (companySearch.data.total > 0) {
        companyId = companySearch.data.results[0].id;
        console.log("🏢 Entreprise trouvée :", companyId);
      } else {
        const created = await axios.post(
          "https://api.hubapi.com/crm/v3/objects/companies",
          { properties: { name: companyName, address: companyLocation, opticien_sur_zone: organizerName } },
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" } }
        );
        companyId = created.data.id;
        console.log("🏢 Entreprise créée :", companyId);
      }

      // Association contact ↔ entreprise
      const existingAssocRes = await axios.get(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/companies`,
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" } }
      );

      const existingCompanyIds = (existingAssocRes.data.results || []).map(r => String(r.id));
      if (!existingCompanyIds.includes(String(companyId))) {
        await axios.post(
          `https://api.hubapi.com/crm/v3/associations/contact/company/batch/create`,
          {
            inputs: [{ from: { id: contactId }, to: { id: companyId }, type: "contact_to_company" }]
          },
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" } }
        );
        console.log("🔗 Contact ↔ entreprise associé");
      } else {
        console.log("ℹ️ L'entreprise est déjà associée au contact.");
      }
    } catch (err) {
      console.error("❌ Erreur création/recherche entreprise :", err.response?.data || err.message);
    }
  }

  res.status(200).send("Webhook traité");
}
