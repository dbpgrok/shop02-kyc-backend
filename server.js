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

// ====== RATE LIMITING ======
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requêtes par IP
  message: { error: "Trop de requêtes, attendez 15 min" },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/order/', orderLimiter);

// ====== CONFIG ======
const PORT = process.env.PORT || 4000;

// IMPORTANT : à mettre dans Render (.env)
const WALLET_PUBKEY = process.env.WALLET_PUBKEY;
const JWT_SECRET = process.env.JWT_SECRET; // ❌ SUPPRIME LE FALLBACK EN PROD
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

if (!WALLET_PUBKEY) {
  console.error("❌ WALLET_PUBKEY manquant ! Arrêt du serveur.");
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error("❌ JWT_SECRET manquant ! Arrêt du serveur.");
  process.exit(1);
}

// Connexion Solana
const connection = new Connection(RPC_URL, "confirmed");

// Stockage en mémoire (à remplacer par DB en prod)
const orders = new Map();

// TES VRAIS FICHIERS MP3
const trackFiles = {
  "1": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/Al%20Dograma.mp3",
  "2": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/Hamsterrad-Revolte.mp3",
  "3": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/Sebene2.mp3",
  "4": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/Self%20Care%20Groove.mp3",
  "5": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/The%20Hope%20Wins.mp3",
  "6": "https://raw.githubusercontent.com/dbpgrok/shop02/main/assets/trk3.mp3"
};

// ====== CRON NETTOYAGE ======
cron.schedule('*/5 * * * *', () => {
  const now = Date.now();
  let cleaned = 0;
  for (const [ref, order] of orders.entries()) {
    if (order.status === 'pending' && now - order.createdAt > 3600000) { // 1h
      orders.delete(ref);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`🧹 ${cleaned} commande(s) expirée(s) supprimée(s)`);
});

// ====== ROUTES ======

// Health check
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    message: "shop02 backend PROD READY", 
    tracks: Object.keys(trackFiles),
    orders: orders.size 
  });
});

// Créer une commande et générer URL Solana Pay
app.post("/api/order/create", async (req, res) => {
  try {
    const { email, pseudo, tracks, totalSol } = req.body;

    // Validations
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Email invalide" });
    }
    if (!tracks || (Array.isArray(tracks) ? tracks.length === 0 : !tracks)) {
      return res.status(400).json({ error: "Aucune piste sélectionnée" });
    }
    if (!totalSol || Number(totalSol) <= 0) {
      return res.status(400).json({ error: "Montant invalide (> 0 SOL)" });
    }

    const recipient = new PublicKey(WALLET_PUBKEY);
    const amount = Number(totalSol);

    // ✅ GÉNÉRATION REFERENCE CÔTÉ SERVEUR (sécurisé)
    const referenceKeypair = Keypair.generate();
    const reference = referenceKeypair.publicKey.toBase58();

    const label = "Shop02 Musique";
    const message = `Achat pistes ${Array.isArray(tracks) ? tracks.join(", ") : tracks}`;
    const memo = `shop02-${reference}`;

    // Génération URL Solana Pay
    const url = encodeURL({ recipient, amount, label, message, memo });
    const paymentUrl = url.toString();

    // QR Code
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(paymentUrl)}`;

    // Normalisation tracks
    let trackArray;
    if (Array.isArray(tracks)) {
      trackArray = tracks.map(String);
    } else if (typeof tracks === "string") {
      trackArray = tracks.split(",").map(t => t.trim());
    } else {
      trackArray = [tracks.toString()];
    }

    const order = {
      email,
      pseudo: pseudo || "Anonyme",
      tracks: trackArray,
      totalSol: amount,
      reference,
      status: "pending",
      createdAt: Date.now()
    };

    orders.set(reference, order);
    console.log("🧾 Nouvelle commande générée:", reference);

    res.json({
      ok: true,
      paymentUrl,
      qrUrl,
      reference
    });
  } catch (e) {
    console.error("Erreur /api/order/create:", e);
    res.status(500).json({ error: "Erreur serveur interne" });
  }
});

// Vérifier le statut d'une commande
app.get("/api/order/status/:reference", async (req, res) => {
  const { reference } = req.params;
  const order = orders.get(reference);

  if (!order) {
    return res.status(404).json({ status: "not_found" });
  }

  if (order.status === "paid") {
    return res.json({ status: "paid" });
  }

  try {
    const recipient = new PublicKey(WALLET_PUBKEY);
    const amount = order.totalSol;
    const refPublicKey = new PublicKey(order.reference);

    // Vérification Solana Pay ✅
    const found = await findReference(connection, refPublicKey, { finality: "confirmed" });
    await validateTransfer(
      connection,
      found.signature,
      { recipient, amount, reference: refPublicKey },
      { commitment: "confirmed" }
    );

    // Paiement validé !
    order.status = "paid";
    order.paidAt = Date.now();
    orders.set(reference, order);
    console.log("✅ Paiement confirmé:", reference);

    res.json({ status: "paid" });
  } catch (e) {
    console.log("⏳ Paiement en attente:", reference, e.message);
    res.json({ status: "pending" });
  }
});

// Download sécurisé
app.get("/download/:token", (req, res) => {
  const { token } = req.params;

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { trackId } = payload;
    const url = trackFiles[trackId];

    if (!url) {
      return res.status(404).send("Piste introuvable");
    }

    // Redirection directe vers MP3
    res.redirect(url);
  } catch (e) {
    console.error("Token invalide:", e.message);
    res.status(401).send("Lien expiré ou invalide");
  }
});

// Liens de téléchargement après paiement
app.get("/api/order/download-links/:reference", (req, res) => {
  const { reference } = req.params;
  const order = orders.get(reference);

  if (!order || order.status !== "paid") {
    return res.status(400).json({ error: "Commande non payée ou introuvable" });
  }

  const links = order.tracks.map(trackId => {
    const token = jwt.sign({ trackId }, JWT_SECRET, { expiresIn: "1h" });
    return {
      trackId,
      title: decodeURIComponent(trackFiles[trackId]?.split('/').pop() || `Track ${trackId}`),
      url: `${req.protocol}://${req.get('host')}/download/${token}`
    };
  });

  res.json({ links });
});

// ====== SERVEUR ======
app.listen(PORT, () => {
  console.log(`🚀 shop02 backend PROD READY sur port ${PORT}`);
  console.log("✅ Tracks configurés:", Object.keys(trackFiles));
  console.log("🔒 Rate limiting activé");
  console.log("🧹 Cron nettoyage activé toutes les 5 min");
});
