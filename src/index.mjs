import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import calendlyHandler from "./calendlyHandler.mjs";

const PORT = process.env.PORT || 3000;
const app = express();

// =========================
// Middleware JSON + rawBody
// =========================
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  })
);

// =========================
// WEBHOOK CALENDLY
// =========================
app.post("/calendly", calendlyHandler);

// =========================
// WORKER HUBSPOT
// =========================
app.post("/worker", async (req, res) => {
  const invitee = req.body.invitee;

  const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

  if (!invitee?.email) {
    return res.status(200).send("no email");
  }

  const email = invitee.email.toLowerCase();
  const scheduledEvent = invitee.scheduled_event || {};

  try {
    // =========================
    // 1. FIND CONTACT
    // =========================
    const searchRes = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "email",
                operator: "EQ",
                value: email
              }
            ]
          }
        ],
        limit: 1
      },
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    const contactId = searchRes.data.results?.[0]?.id;

    if (!contactId) {
      console.warn("⚠️ Contact introuvable HubSpot");
      return res.status(200).send("no contact");
    }

    console.log("✔ Contact trouvé :", contactId);

    // =========================
    // 2. QUESTION MAP
    // =========================
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
      const d = new Date(scheduledEvent.start_time);

      heureRdv = d.toLocaleTimeString("fr-FR", {
        timeZone: "Europe/Paris",
        hour: "2-digit",
        minute: "2-digit"
      });

      jourRdv = d.toLocaleDateString("fr-FR", {
        timeZone: "Europe/Paris",
        weekday: "long",
        day: "numeric",
        month: "long"
      });
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

    // =========================
    // 3. UPDATE CONTACT
    // =========================
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

    // =========================
    // 4. COMPANY LOGIC
    // =========================
    const companyName = scheduledEvent.name;
    const companyLocation = scheduledEvent.location?.location || "";
    const organizerName =
      scheduledEvent.event_memberships?.[0]?.user_name || "";

    if (companyName) {
      try {
        const companySearch = await axios.post(
          "https://api.hubapi.com/crm/v3/objects/companies/search",
          {
            filterGroups: [
              {
                filters: [
                  {
                    propertyName: "name",
                    operator: "EQ",
                    value: companyName
                  }
                ]
              }
            ],
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
        }

        console.log("🏢 Company OK :", companyId);
      } catch (err) {
        console.error(
          "❌ Company error:",
          err.response?.data || err.message
        );
      }
    }

    res.status(200).send("done");
  } catch (err) {
    console.error("❌ Worker error:", err.response?.data || err.message);
    res.status(200).send("error handled");
  }
});

// =========================
// OAUTH CALLBACK (Calendly)
// =========================
app.post("/calendly/oauth/callback", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).send("Code OAuth manquant");

  try {
    const { getCalendlyAccessToken } = await import(
      "./calendlyHandler.mjs"
    );

    const tokenData = await getCalendlyAccessToken(code);
    console.log("📌 Token OAuth Calendly :", tokenData);

    res.status(200).json(tokenData);
  } catch (err) {
    console.error(
      "❌ Erreur OAuth Calendly :",
      err.response?.data || err
    );
    res.status(500).send("Erreur OAuth");
  }
});

// =========================
// TEST USER CALENDLY
// =========================
app.get("/calendly/me", async (req, res) => {
  const accessToken = req.headers["authorization"]?.split(" ")[1];

  if (!accessToken) {
    return res.status(400).send("Access token manquant");
  }

  try {
    const { getCalendlyUser } = await import("./calendlyHandler.mjs");

    const userData = await getCalendlyUser(accessToken);

    res.status(200).json(userData);
  } catch (err) {
    console.error("❌ Calendly API error:", err.response?.data || err);
    res.status(500).send("Erreur API Calendly");
  }
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});