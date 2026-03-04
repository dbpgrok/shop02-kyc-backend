import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  encodeURL,
  findReference,
  validateTransfer
} from "@solana/pay";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 4000;

// IMPORTANT : à mettre dans Render
const WALLET_PUBKEY = process.env.WALLET_PUBKEY; // ex: "6t6pLZ22wnbPSnUvBzv9ZRxVK5q7CSTXDE5LjHcQaaAs"
const JWT_SECRET = process.env.JWT_SECRET || "change_me_super_secret";
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

// Connexion Solana
const connection = new Connection(RPC_URL, "confirmed");

if (!WALLET_PUBKEY) {
  console.warn("⚠️ WALLET_PUBKEY manquant dans les variables d'environnement.");
}

// Stockage simple en mémoire (pour tests)
const orders = new Map(); // key: reference, value: order object

// Mapping trackId -> URL fichier MP3 complet
// À ADAPTER avec tes vraies URLs (GitHub, autre stockage, etc.)
const trackFiles = {
  "1": "https://exemple.com/full/track1.mp3",
  "2": "https://exemple.com/full/track2.mp3",
  "3": "https://exemple.com/full/track3.mp3",
  "4": "https://exemple.com/full/track4.mp3",
  "5": "https://exemple.com/full/track5.mp3",
  "6": "https://exemple.com/full/track6.mp3"
};

// ====== ROUTES ======

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "shop02 backend up" });
});

// Créer une commande et générer URL Solana Pay
app.post("/api/order/create", async (req, res) => {
  try {
    const { email, pseudo, tracks, totalSol, reference } = req.body;

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Email invalide" });
    }
    if (!tracks || tracks.length === 0) {
      return res.status(400).json({ error: "Aucune piste" });
    }
    if (!totalSol || Number(totalSol) <= 0) {
      return res.status(400).json({ error: "Montant invalide" });
    }
    if (!reference) {
      return res.status(400).json({ error: "Référence manquante" });
    }
    if (!WALLET_PUBKEY) {
      return res.status(500).json({ error: "WALLET_PUBKEY non configuré" });
    }

    const recipient = new PublicKey(WALLET_PUBKEY);
    const amount = Number(totalSol);

    const label = "Shop02 Musique";
    const message = `Achat pistes ${Array.isArray(tracks) ? tracks.join(",") : tracks}`;
    const memo = `shop02-${reference}`;

    // On convertit la référence (string) en clé publique "fake" pour Solana Pay
    // Astuce: on crée une nouvelle Keypair sur le front ou on laisse la string:
    const refString = reference; // on laissera comme string pour findReference

    const url = encodeURL({
      recipient,
      amount,
      label,
      message,
      memo,
      // On ne passe pas directement refString ici, on va l'utiliser côté findReference
    });

    const paymentUrl = url.toString();

    // QR simple via un service public
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(
      paymentUrl
    )}`;

    // Normalisation tracks en array de strings
    let trackArray;
    if (Array.isArray(tracks)) {
      trackArray = tracks.map(String);
    } else if (typeof tracks === "string") {
      trackArray = tracks.split(",").map((t) => t.trim());
    } else {
      trackArray = [];
    }

    const order = {
      email,
      pseudo: pseudo || "Anonyme",
      tracks: trackArray,
      totalSol: amount,
      reference: refString,
      status: "pending",
      createdAt: Date.now()
    };

    orders.set(refString, order);

    console.log("🧾 Nouvelle commande:", order);

    res.json({
      ok: true,
      paymentUrl,
      qrUrl,
      reference: refString
    });
  } catch (e) {
    console.error("Erreur /api/order/create:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Vérifier le statut d'une commande (paiement Solana)
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
    if (!WALLET_PUBKEY) {
      return res.status(500).json({ error: "WALLET_PUBKEY non configuré" });
    }

    const recipient = new PublicKey(WALLET_PUBKEY);
    const amount = order.totalSol;

    // findReference s'attend à une PublicKey ou une string "référence"
    const refString = order.reference;

    const found = await findReference(connection, refString, {
      finality: "confirmed"
    });

    await validateTransfer(
      connection,
      {
        recipient,
        amount,
        reference: refString
      },
      found.signature,
      {
        commitment: "confirmed"
      }
    );

    // Si on arrive ici : transfert valide
    order.status = "paid";
    order.paidAt = Date.now();
    orders.set(reference, order);

    console.log("✅ Paiement confirmé pour", reference);

    res.json({ status: "paid" });
  } catch (e) {
    console.log("ℹ️ Paiement encore en attente ou introuvable pour", reference, e.message);
    res.json({ status: "pending" });
  }
});

// Download sécurisé via token JWT
app.get("/download/:token", (req, res) => {
  const { token } = req.params;

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { trackId } = payload;

    const url = trackFiles[trackId];
    if (!url) {
      return res.status(404).send("Piste introuvable");
    }

    // Redirection vers le fichier réel (ou streaming)
    return res.redirect(url);
  } catch (e) {
    console.error("Token invalide:", e.message);
    return res.status(401).send("Lien expiré ou invalide");
  }
});

// Génération des tokens download après paiement (fonction utilitaire)
function generateDownloadLinks(order) {
  const links = order.tracks.map((tId) => {
    const token = jwt.sign(
      {
        trackId: tId
      },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
    return {
      trackId: tId,
      url: `/download/${token}`
    };
  });
  return links;
}

// Endpoint pour récupérer les liens download après paiement
app.get("/api/order/download-links/:reference", (req, res) => {
  const { reference } = req.params;
  const order = orders.get(reference);

  if (!order) {
    return res.status(404).json({ error: "Commande introuvable" });
  }
  if (order.status !== "paid") {
    return res.status(400).json({ error: "Commande non payée" });
  }

  const links = generateDownloadLinks(order);
  res.json({ links });
});

// ====== LANCEMENT SERVEUR ======

app.listen(PORT, () => {
  console.log(`🚀 shop02 backend listening on port ${PORT}`);
});
