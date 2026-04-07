import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { encodeURL, findReference, validateTransfer } from "@solana/pay";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes" }
});
app.use("/api/order/", orderLimiter);

const PORT = process.env.PORT || 4000;
const WALLET_PUBKEY = process.env.WALLET_PUBKEY;
const JWT_SECRET = process.env.JWT_SECRET;
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

if (!WALLET_PUBKEY) console.error("❌ WALLET_PUBKEY manquant");
if (!JWT_SECRET) console.error("❌ JWT_SECRET manquant");

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

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeTracks(tracks) {
  const arr = Array.isArray(tracks) ? tracks : [tracks];
  const clean = arr.map(String).map(v => v.trim()).filter(Boolean);
  const allExist = clean.every(trackId => trackFiles[trackId]);
  return allExist ? clean : null;
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Number(amount.toFixed(9));
}

cron.schedule("*/5 * * * *", () => {
  const now = Date.now();
  let cleaned = 0;

  for (const [ref, order] of orders) {
    if (order.status === "pending" && now - order.createdAt > 3600000) {
      orders.delete(ref);
      cleaned++;
    }
  }

  if (cleaned) console.log(`🧹 ${cleaned} commandes nettoyées`);
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "shop02 backend LIVE",
    tracks: Object.keys(trackFiles),
    orders: orders.size,
    walletConfigured: Boolean(WALLET_PUBKEY),
    jwtConfigured: Boolean(JWT_SECRET)
  });
});

app.post("/api/order/create", async (req, res) => {
  try {
    if (!WALLET_PUBKEY) {
      return res.status(500).json({ error: "Paiements désactivés" });
    }

    const { email, pseudo, tracks, totalSol } = req.body;

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Email invalide" });
    }

    const trackArray = normalizeTracks(tracks);
    if (!trackArray || !trackArray.length) {
      return res.status(400).json({ error: "Pistes invalides" });
    }

    const amount = normalizeAmount(totalSol);
    if (!amount) {
      return res.status(400).json({ error: "Montant invalide" });
    }

    const recipient = new PublicKey(WALLET_PUBKEY);
    const referenceKeypair = Keypair.generate();
    const reference = referenceKeypair.publicKey.toBase58();

    const label = "Shop02 Musique";
    const message = trackArray.join(", ");
    const memo = `shop02-${reference}`;

    const url = encodeURL({
      recipient,
      amount,
      reference: new PublicKey(reference),
      label,
      message,
      memo
    });

    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url.toString())}`;

    const order = {
      email,
      pseudo: typeof pseudo === "string" && pseudo.trim() ? pseudo.trim() : "Anonyme",
      tracks: trackArray,
      totalSol: amount,
      reference,
      status: "pending",
      createdAt: Date.now(),
      paidAt: null
    };

    orders.set(reference, order);
    console.log("🧾 Commande:", reference);

    res.json({
      ok: true,
      paymentUrl: url.toString(),
      qrUrl,
      reference
    });
  } catch (e) {
    console.error("create order:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/order/status/:reference", async (req, res) => {
  const reference = req.params.reference;
  const order = orders.get(reference);

  if (!WALLET_PUBKEY) {
    return res.status(500).json({ error: "Paiements désactivés" });
  }

  if (!order) {
    return res.status(404).json({ status: "not_found" });
  }

  if (order.status === "paid") {
    return res.json({ status: "paid" });
  }

  try {
    const recipient = new PublicKey(WALLET_PUBKEY);
    const refPublicKey = new PublicKey(reference);

    const found = await findReference(connection, refPublicKey, {
      finality: "confirmed"
    });

    await validateTransfer(
      connection,
      found.signature,
      {
        recipient,
        amount: order.totalSol,
        reference: refPublicKey
      },
      {
        commitment: "confirmed"
      }
    );

    order.status = "paid";
    order.paidAt = Date.now();
    orders.set(reference, order);

    console.log("✅ Paid:", reference);
    return res.json({ status: "paid" });
  } catch (e) {
    console.log("⏳ Pending:", reference, e?.message || e);
    return res.json({ status: "pending" });
  }
});

app.get("/download/:token", (req, res) => {
  try {
    if (!JWT_SECRET) {
      return res.status(500).send("JWT_SECRET manquant");
    }

    const { trackId } = jwt.verify(req.params.token, JWT_SECRET);
    const url = trackFiles[String(trackId)];

    if (!url) {
      return res.status(404).send("Piste introuvable");
    }

    return res.redirect(url);
  } catch (e) {
    return res.status(401).send("Lien invalide");
  }
});

app.get("/api/order/download-links/:reference", (req, res) => {
  try {
    if (!JWT_SECRET) {
      return res.status(500).json({ error: "Téléchargements indisponibles" });
    }

    const order = orders.get(req.params.reference);

    if (!order || order.status !== "paid") {
      return res.status(400).json({ error: "Commande non payée" });
    }

    const links = order.tracks.map(trackId => ({
      trackId,
      title: decodeURIComponent(trackFiles[trackId]?.split("/").pop() || `Track ${trackId}`),
      url: `${req.protocol}://${req.get("host")}/download/${jwt.sign(
        { trackId },
        JWT_SECRET,
        { expiresIn: "1h" }
      )}`
    }));

    return res.json({ links });
  } catch (e) {
    return res.status(500).json({ error: "Erreur génération liens" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend sur port ${PORT}`);
  console.log("✅ Health: /api/health");
});
