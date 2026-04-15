const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

console.log("BOT_TOKEN:", BOT_TOKEN ? "✅ Found" : "❌ Missing");
console.log("CHANNEL_ID:", CHANNEL_ID ? "✅ Found" : "❌ Missing");

async function getTokenInfo(mint) {
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const pair = res.data?.pairs?.[0];
    if (!pair) return null;
    return {
      name: pair.baseToken?.name || "Unknown",
      symbol: pair.baseToken?.symbol || "???",
      price: parseFloat(pair.priceUsd || 0),
      mc: pair.marketCap || 0,
      dex: pair.dexId || "unknown",
    };
  } catch {
    return null;
  }
}

function formatUSD(num) {
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

app.get("/", (req, res) => res.send("Wallet Tracker is running!"));

app.post("/webhook", async (req, res) => {
  try {
    const txs = req.body;
    if (!txs || !txs.length) return res.sendStatus(200);

    for (const tx of txs) {
      const wallet = tx.feePayer || "Unknown";
      const type = tx.type || "UNKNOWN";
      const signature = tx.signature || "";

      console.log("TX type:", type);
      if (type !== "SWAP") continue;

      const transfers = tx.tokenTransfers || [];
      const nativeTransfers = tx.nativeTransfers || [];

      // Deteksi SOL spent dan token received
      let solSpent = 0;
      let tokenMint = null;
      let tokenAmount = 0;

      // Cek native transfers untuk SOL
      for (const nt of nativeTransfers) {
        if (nt.fromUserAccount === wallet) {
          solSpent += nt.amount / 1e9;
        }
      }

      // Cek token transfers untuk token yang diterima
      for (const tt of transfers) {
        if (tt.toUserAccount === wallet && tt.mint !== "So11111111111111111111111111111111111111112") {
          tokenMint = tt.mint;
          tokenAmount = tt.tokenAmount;
        }
      }

      if (!tokenMint) continue;

      // Ambil info token dari DexScreener
      const tokenInfo = await getTokenInfo(tokenMint);
      const tokenName = tokenInfo?.name || tokenMint.slice(0, 8) + "...";
      const tokenSymbol = tokenInfo?.symbol || "???";
      const tokenPrice = tokenInfo?.price || 0;
      const marketCap = tokenInfo?.mc || 0;
      const dexName = tokenInfo?.dex?.toUpperCase() || "DEX";

      const usdValue = solSpent * tokenPrice * tokenAmount / tokenAmount;
      const totalUSD = (solSpent * (tokenPrice > 0 ? (tokenAmount * tokenPrice) / tokenAmount : 0)).toFixed(2);
      const tokenUSDValue = (tokenAmount * tokenPrice).toFixed(2);

      const shortWallet = wallet.slice(0, 4) + "..." + wallet.slice(-4);
      const solscanUrl = `https://solscan.io/tx/${signature}`;
      const dexUrl = `https://dexscreener.com/solana/${tokenMint}`;
      const jupiterUrl = `https://jup.ag/swap/SOL-${tokenMint}`;

      const message =
`🟢 *BUY ${tokenName} on ${dexName}*

👛 \`${shortWallet}\` swapped *${solSpent.toFixed(4)} SOL* for *${tokenAmount.toLocaleString()}* (*$${tokenUSDValue}*) ${tokenSymbol}
💲 @$${tokenPrice.toFixed(6)}

🪙 *#${tokenSymbol}* | MC: ${formatUSD(marketCap)}
\`${tokenMint}\`

🔗 [Solscan](${solscanUrl}) | [DexScreener](${dexUrl}) | [Jupiter](${jupiterUrl})`;

      console.log("Sending message...");

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHANNEL_ID,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });

      console.log("Message sent!");
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
