import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import nodemailer from "nodemailer";
import calendlyHandler from "./calendlyHandler.mjs";

const PORT = process.env.PORT || 3000;
const app = express();

// =========================
// MIDDLEWARE
// =========================
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  })
);

// =========================
// HELPERS
// =========================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =========================
// EMAIL ALERT
// =========================
async function sendFailureEmail(email, reason) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn("⚠️ Email non configuré");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.ALERT_EMAIL,
    subject: "❌ Échec Calendly → HubSpot",
    text: `
Échec traitement webhook

Email : ${email}
Raison : ${reason}
    `
  });
}

// =========================
// RETRY HUBSPOT CONTACT
// =========================
async function findContactWithRetry(email, HUBSPOT_TOKEN) {
  const delays = [0, 15000, 5000, 10000];

  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      console.log(`⏳ Attente ${delays[i] / 1000}s (tentative ${i + 1})`);
      await sleep(delays[i]);
    }

    try {
      const res = await axios.post(
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

      const contactId = res.data.results?.[0]?.id;

      if (contactId) {
        console.log("✔ Contact trouvé :", contactId);
        return contactId;
      }

      console.log(`⚠️ Tentative ${i + 1} : contact introuvable`);

    } catch (err) {
      console.error("❌ HubSpot error:", err.response?.data || err.message);
    }
  }

  return null;
}

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

  try {
    const contactId = await findContactWithRetry(email, HUBSPOT_TOKEN);

    if (!contactId) {
      const reason = "Contact introuvable après retries";

      console.error("❌ ÉCHEC FINAL :", reason);

      await sendFailureEmail(email, reason);

      return res.status(200).send("failed notified");
    }

    console.log("✔ Contact OK :", contactId);

    // =========================
    // 👉 HUBSPOT UPDATE (tu remets ton code ici)
    // =========================

    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      {
        properties: {
          calendly_email: email
        }
      },
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✔ Contact enrichi");

    return res.status(200).send("done");

  } catch (err) {
    console.error("❌ Worker crash:", err.message);

    await sendFailureEmail(email, "Worker crash");

    return res.status(200).send("error handled");
  }
});

// =========================
// CALENDLY WEBHOOK ROUTE
// =========================
app.post("/calendly", calendlyHandler);

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});