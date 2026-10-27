// EVG Tof — serveur Express + MongoDB Atlas
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const webpush = require("web-push");

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "evg-tof";
const ADMIN_PIN = process.env.ADMIN_PIN || "";
const MAX_PARTICIPANTS = 20;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const PUSH_READY = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_READY) webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:organisateur@evg-tof.fr", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const WEEKEND_ID = /^\d{4}$/; // ex. "0403" = week-end du 3 avril

const app = express();
app.use(express.json({ limit: "20kb" }));
const FICHIERS = ["index.html", "sw.js", "manifest.json", "icon-192.png", "icon-512.png"];
app.get("/", (req, res) => res.sendFile(__dirname + "/index.html"));
app.get("/:f", (req, res, next) => FICHIERS.includes(req.params.f) ? res.sendFile(__dirname + "/" + req.params.f) : next());

let participants, subscriptions;

function cleanName(n) {
  return String(n || "").trim().replace(/\s+/g, " ").slice(0, 30);
}
function toId(id) {
  try { return new ObjectId(id); } catch { return null; }
}
function isAdmin(req) {
  return ADMIN_PIN && req.get("x-admin-pin") === ADMIN_PIN;
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Liste des participants et de leurs réponses
app.get("/api/participants", async (req, res) => {
  const list = await participants.find().sort({ order: 1 }).toArray();
  res.json(list.map(p => ({ id: p._id, name: p.name, votes: p.votes || {}, conge: p.conge || {} })));
});

// Ajouter un participant
app.post("/api/participants", async (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: "Indique un prénom." });
  const count = await participants.countDocuments();
  if (count >= MAX_PARTICIPANTS) return res.status(400).json({ error: "La liste est complète." });
  const exists = await participants.findOne({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
  if (exists) return res.status(409).json({ error: `${name} est déjà dans la liste.` });
  const r = await participants.insertOne({ name, order: Date.now(), votes: {}, conge: {} });
  res.json({ id: r.insertedId });
});

// Voter dispo / pas dispo sur un week-end (value: "oui" | "non" | null)
app.put("/api/participants/:id/vote", async (req, res) => {
  const _id = toId(req.params.id);
  const { weekend, value } = req.body;
  if (!_id || !WEEKEND_ID.test(weekend) || ![ "oui", "non", null ].includes(value))
    return res.status(400).json({ error: "Réponse invalide." });
  const update = value ? { $set: { [`votes.${weekend}`]: value } } : { $unset: { [`votes.${weekend}`]: "" } };
  const r = await participants.updateOne({ _id }, update);
  if (!r.matchedCount) return res.status(404).json({ error: "Participant introuvable." });
  res.json({ ok: true });
});

// Case « Je dois poser une journée » (value: true | false)
app.put("/api/participants/:id/conge", async (req, res) => {
  const _id = toId(req.params.id);
  const { weekend, value } = req.body;
  if (!_id || !WEEKEND_ID.test(weekend) || typeof value !== "boolean")
    return res.status(400).json({ error: "Réponse invalide." });
  const update = value ? { $set: { [`conge.${weekend}`]: true } } : { $unset: { [`conge.${weekend}`]: "" } };
  const r = await participants.updateOne({ _id }, update);
  if (!r.matchedCount) return res.status(404).json({ error: "Participant introuvable." });
  res.json({ ok: true });
});

// ---------- Notifications ----------
// Clé publique pour que le téléphone s'abonne
app.get("/api/push/key", (req, res) => res.json({ key: PUSH_READY ? VAPID_PUBLIC_KEY : null }));

// Enregistrer un téléphone
app.post("/api/push/subscribe", async (req, res) => {
  const sub = req.body.subscription;
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys) return res.status(400).json({ error: "Abonnement invalide." });
  await subscriptions.updateOne(
    { endpoint: sub.endpoint },
    { $set: { endpoint: sub.endpoint, keys: sub.keys, participantId: String(req.body.participantId || ""), updatedAt: new Date() } },
    { upsert: true }
  );
  res.json({ ok: true });
});

// Désabonner un téléphone
app.post("/api/push/unsubscribe", async (req, res) => {
  if (typeof req.body.endpoint === "string") await subscriptions.deleteOne({ endpoint: req.body.endpoint });
  res.json({ ok: true });
});

// Nombre de téléphones abonnés (admin)
app.get("/api/push/count", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Code admin incorrect." });
  res.json({ count: await subscriptions.countDocuments() });
});

// Envoyer une notification à tout le monde (admin)
app.post("/api/push/send", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Code admin incorrect." });
  if (!PUSH_READY) return res.status(500).json({ error: "Clés de notification manquantes sur Render." });
  const title = String(req.body.title || "EVG de Tof").trim().slice(0, 60) || "EVG de Tof";
  const body = String(req.body.body || "").trim().slice(0, 240);
  if (!body) return res.status(400).json({ error: "Écris un message." });
  const payload = JSON.stringify({ title, body, url: "/" });
  const subs = await subscriptions.find().toArray();
  let sent = 0, removed = 0;
  await Promise.all(subs.map(async s => {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload); sent++; }
    catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) { await subscriptions.deleteOne({ _id: s._id }); removed++; }
    }
  }));
  res.json({ ok: true, sent, removed });
});

// Vérifier le code admin
app.post("/api/admin/check", (req, res) => res.json({ ok: !!isAdmin(req) }));

// Supprimer un participant (admin)
app.delete("/api/participants/:id", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Code admin incorrect." });
  const _id = toId(req.params.id);
  if (!_id) return res.status(400).json({ error: "Participant introuvable." });
  await participants.deleteOne({ _id });
  res.json({ ok: true });
});

async function start() {
  if (!MONGODB_URI) {
    console.error("MONGODB_URI manquant : ajoute-le dans Environment sur Render.");
    process.exit(1);
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  participants = client.db(DB_NAME).collection("participants");
  subscriptions = client.db(DB_NAME).collection("subscriptions");
  if (!PUSH_READY) console.log("Notifications désactivées : VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquants.");

  // Premier démarrage : les 3 organisateurs
  if ((await participants.countDocuments()) === 0) {
    await participants.insertMany(
      ["Julien", "Vincent", "Alexis"].map((name, i) => ({ name, order: i + 1, votes: {}, conge: {} }))
    );
    console.log("Participants de départ créés.");
  }

  app.listen(PORT, () => console.log(`EVG Tof en ligne sur le port ${PORT}`));
}

start().catch(err => {
  console.error("Démarrage impossible :", err.message);
  process.exit(1);
});
