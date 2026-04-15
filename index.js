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
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 3000 }
    );
    const pair = res.data?.pairs?.[0];
    if (!pair) return null;
    return {
      name: pair.baseToken?.name || "Unknown",
      symbol: pair.baseToken?.symbol || "???",
      price: parseFloat(pair.priceUsd || 0),
      mc: pair.marketCap || 0,
      dex: pair.dexId || "unknown",
      pairAddress: pair.pairAddress || mint,
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

      let solAmount = 0;
      let tokenMint = null;
      let tokenAmount = 0;
      let isBuy = false;

      // Cek SOL direction
      for (const nt of nativeTransfers) {
        if (nt.fromUserAccount === wallet) solAmount += nt.amount / 1e9;
      }

      // Cek token direction — BUY = terima token, SELL = kirim token
      for (const tt of transfers) {
        const isSOL = tt.mint === "So11111111111111111111111111111111111111112";
        if (isSOL) continue;
        if (tt.toUserAccount === wallet) {
          isBuy = true;
          tokenMint = tt.mint;
          tokenAmount = tt.tokenAmount;
        } else if (tt.fromUserAccount === wallet) {
          isBuy = false;
          tokenMint = tt.mint;
          tokenAmount = tt.tokenAmount;
        }
      }

      if (!tokenMint) continue;

      const tokenInfo = await getTokenInfo(tokenMint);
      const tokenName = tokenInfo?.name || "Unknown";
      const tokenSymbol = tokenInfo?.symbol || "???";
      const tokenPrice = tokenInfo?.price || 0;
      const marketCap = tokenInfo?.mc || 0;
      const dexName = (tokenInfo?.dex || "DEX").toUpperCase();
      const pairAddress = tokenInfo?.pairAddress || tokenMint;

      const tokenUSDValue = (tokenAmount * tokenPrice).toFixed(2);
      const shortWallet = wallet.slice(0, 4) + "..." + wallet.slice(-4);

      const emoji = isBuy ? "🟢" : "🔴";
      const action = isBuy ? "BUY" : "SELL";
      const swapText = isBuy
        ? `swapped *${solAmount.toFixed(4)} SOL* for *${tokenAmount.toLocaleString()}* (*$${tokenUSDValue}*) ${tokenName}\n@$${tokenPrice.toFixed(6)}`
        : `swapped *${tokenAmount.toLocaleString()}* (*$${tokenUSDValue}*) ${tokenName} for *${solAmount.toFixed(4)} SOL*\n@$${tokenPrice.toFixed(6)}`;

      const message =
`${emoji} *${action} ${tokenName} on ${dexName}*
💠 ${shortWallet}

💠 \`${shortWallet}\` ${swapText}

🪙 *#${tokenSymbol}* | MC: ${formatUSD(marketCap)} | [INFO](https://dexscreener.com/solana/${pairAddress})
\`${tokenMint}\``;

      // Inline buttons
      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: "🦅 GMGN", url: `https://gmgn.ai/sol/token/${tokenMint}` },
            { text: "📊 DexScreener", url: `https://dexscreener.com/solana/${pairAddress}` },
            { text: "🪐 Jupiter", url: `https://jup.ag/swap/SOL-${tokenMint}` },
          ],
          [
            { text: "🔱 Axiom", url: `https://axiom.trade/token/${tokenMint}` },
            { text: "🍌 Bonk", url: `https://bonkbot.io/?token=${tokenMint}` },
            { text: "🔗 Solscan", url: `https://solscan.io/tx/${signature}` },
          ]
        ]
      };

      console.log(`Sending ${action} message...`);

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHANNEL_ID,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: inlineKeyboard,
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
