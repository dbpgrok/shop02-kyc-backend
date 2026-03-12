import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import {
  encodeURL,
  findReference,
  validateTransfer
} from "@solana/pay";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Rate limiting
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Trop de requêtes" }
});
app.use('/api/order/', orderLimiter);

// CONFIG (tolérant Render)
const PORT = process.env.PORT || 4000;
const WALLET_PUBKEY = process.env.WALLET_PUBKEY;
const JWT_SECRET = process.env.JWT_SECRET || "render-dev-fallback";
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

if (!WALLET_PUBKEY) console.error("❌ WALLET_PUBKEY manquant");
if (!JWT_SECRET || JWT_SECRET === "render-dev-fallback") console.warn("⚠️ JWT_SECRET faible");

const connection = new Connection(RPC_URL, "confirmed");
const orders = new Map();

const trackFiles = {
  "1": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/Al%20Dograma.mp3",
  "2": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/Hamsterrad-Revolte.mp3",
  "3": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/Sebene2.mp3",
  "4": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/Self%20Care%20Groove.mp3",
  "5": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/The%20Hope%20Wins.mp3",
  "6": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/trk3.mp3"
};

// Cron nettoyage
cron.schedule('*/5 * * * *', () => {
  const now = Date.now();
  let cleaned = 0;
  for (const [ref, order] of orders) {
    if (order.status === 'pending' && now - order.createdAt > 3600000) {
      orders.delete(ref);
      cleaned++;
    }
  }
  if (cleaned) console.log(`🧹 ${cleaned} commandes nettoyées`);
});

// ROUTES
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    message: "shop02 backend LIVE", 
    tracks: Object.keys(trackFiles),
    orders: orders.size 
  });
});

app.post("/api/order/create", async (req, res) => {
  try {
    const { email, pseudo, tracks, totalSol } = req.body;

    if (!email?.includes("@")) return res.status(400).json({ error: "Email invalide" });
    if (!tracks?.length) return res.status(400).json({ error: "Aucune piste" });
    if (!totalSol || Number(totalSol) <= 0) return res.status(400).json({ error: "Montant invalide" });
    if (!WALLET_PUBKEY) return res.status(500).json({ error: "Paiements désactivés" });

    const recipient = new PublicKey(WALLET_PUBKEY);
    const amount = Number(totalSol);
    const referenceKeypair = Keypair.generate();
    const reference = referenceKeypair.publicKey.toBase58();

    const label = "Shop02 Musique";
    const message = Array.isArray(tracks) ? tracks.join(", ") : tracks;
    const memo = `shop02-${reference}`;

    const url = encodeURL({ recipient, amount, label, message, memo });
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url.toString())}`;

    const trackArray = Array.isArray(tracks) ? tracks.map(String) : [tracks.toString()];
    const order = {
      email, pseudo: pseudo || "Anonyme", tracks: trackArray,
      totalSol: amount, reference, status: "pending", createdAt: Date.now()
    };

    orders.set(reference, order);
    console.log("🧾 Commande:", reference);

    res.json({ ok: true, paymentUrl: url.toString(), qrUrl, reference });
  } catch (e) {
    console.error("create order:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/order/status/:reference", async (req, res) => {
  const reference = req.params.reference;
  const order = orders.get(reference);

  if (!order) return res.status(404).json({ status: "not_found" });
  if (order.status === "paid") return res.json({ status: "paid" });

  try {
    const recipient = new PublicKey(WALLET_PUBKEY);
    const refPublicKey = new PublicKey(reference);
    const found = await findReference(connection, refPublicKey, { finality: "confirmed" });
    await validateTransfer(connection, found.signature, { 
      recipient, amount: order.totalSol, reference: refPublicKey 
    }, { commitment: "confirmed" });

    order.status = "paid"; order.paidAt = Date.now();
    orders.set(reference, order);
    console.log("✅ Paid:", reference);
    res.json({ status: "paid" });
  } catch (e) {
    console.log("⏳ Pending:", reference, e.message);
    res.json({ status: "pending" });
  }
});

app.get("/download/:token", (req, res) => {
  try {
    const { trackId } = jwt.verify(req.params.token, JWT_SECRET);
    const url = trackFiles[trackId];
    if (!url) return res.status(404).send("Piste introuvable");
    res.redirect(url);
  } catch {
    res.status(401).send("Lien invalide");
  }
});

app.get("/api/order/download-links/:reference", (req, res) => {
  const order = orders.get(req.params.reference);
  if (!order || order.status !== "paid") {
    return res.status(400).json({ error: "Commande non payée" });
  }

  const links = order.tracks.map(trackId => ({
    trackId,
    title: decodeURIComponent(trackFiles[trackId]?.split('/').pop() || `Track ${trackId}`),
    url: `${req.protocol}://${req.get('host')}/download/${jwt.sign({ trackId }, JWT_SECRET, { expiresIn: "1h" })}`
  }));

  res.json({ links });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend sur port ${PORT}`);
  console.log("✅ Health: /api/health");
});

