const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

console.log("BOT_TOKEN:", BOT_TOKEN ? "✅ Found" : "❌ Missing");
console.log("CHANNEL_ID:", CHANNEL_ID ? "✅ Found" : "❌ Missing");

// ===== CONFIG =====
const MIN_SOL = 0.01; // minimum SOL untuk notif
const WALLETS = process.env.WALLETS ? process.env.WALLETS.split(",") : [];

// PnL tracker — simpan history beli per token per wallet
const pnlTracker = {}; // { wallet_mint: { totalSOL, totalToken } }

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

function getPnLEmoji(pnl) {
  if (pnl > 20) return "🚀";
  if (pnl > 0) return "✅";
  if (pnl < -20) return "💀";
  return "🔻";
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

      // Cari wallet utama
      let mainWallet = wallet;
      for (const tt of transfers) {
        const isSOL = tt.mint === "So11111111111111111111111111111111111111112";
        if (!isSOL) {
          mainWallet = tt.toUserAccount || tt.fromUserAccount;
          break;
        }
      }

      // Cek SOL dari nativeTransfers
      for (const nt of nativeTransfers) {
        if (nt.fromUserAccount === mainWallet) solAmount += nt.amount / 1e9;
      }

      // Cek SOL dari wrapped SOL tokenTransfers
      for (const tt of transfers) {
        const isSOL = tt.mint === "So11111111111111111111111111111111111111112";
        if (!isSOL) continue;
        if (tt.fromUserAccount === mainWallet) solAmount += tt.tokenAmount;
      }

      if (solAmount === 0) {
        for (const nt of nativeTransfers) {
          if (nt.fromUserAccount === mainWallet) solAmount += nt.amount / 1e9;
        }
      }

      // Cek token direction
      for (const tt of transfers) {
        const isSOL = tt.mint === "So11111111111111111111111111111111111111112";
        if (isSOL) continue;
        if (tt.toUserAccount === mainWallet) {
          isBuy = true;
          tokenMint = tt.mint;
          tokenAmount = tt.tokenAmount;
        } else if (tt.fromUserAccount === mainWallet) {
          isBuy = false;
          tokenMint = tt.mint;
          tokenAmount = tt.tokenAmount;
        }
      }

      if (!tokenMint) continue;

      // ===== FILTER MINIMUM SOL =====
      if (solAmount < MIN_SOL) {
        console.log(`Skipped: SOL amount ${solAmount} below minimum ${MIN_SOL}`);
        continue;
      }

      const tokenInfo = await getTokenInfo(tokenMint);
      const tokenName = tokenInfo?.name || "Unknown";
      const tokenSymbol = tokenInfo?.symbol || "???";
      const tokenPrice = tokenInfo?.price || 0;
      const marketCap = tokenInfo?.mc || 0;
      const dexName = (tokenInfo?.dex || "DEX").toUpperCase();

      const tokenUSDValue = (tokenAmount * tokenPrice).toFixed(2);
      const shortWallet = mainWallet.slice(0, 6) + "..." + mainWallet.slice(-4);
      const solscanTx = `https://solscan.io/tx/${signature}`;
      const solscanWallet = `https://solscan.io/account/${mainWallet}?exclude_amount_zero=true&remove_spam=true#transfers`;
      const solscanSOL = `https://solscan.io/token/So11111111111111111111111111111111111111112`;
      const solscanToken = `https://solscan.io/token/${tokenMint}`;

      // ===== PnL TRACKER =====
      const pnlKey = `${mainWallet}_${tokenMint}`;
      let pnlLine = "";
      let sellPercentLine = "";

      if (isBuy) {
        // Simpan posisi beli
        if (!pnlTracker[pnlKey]) {
          pnlTracker[pnlKey] = { totalSOLSpent: 0, totalTokenBought: 0 };
        }
        pnlTracker[pnlKey].totalSOLSpent += solAmount;
        pnlTracker[pnlKey].totalTokenBought += tokenAmount;
        console.log(`BUY tracked: ${pnlKey} | SOL: ${pnlTracker[pnlKey].totalSOLSpent} | Token: ${pnlTracker[pnlKey].totalTokenBought}`);

      } else {
        // Hitung PnL saat SELL
        if (pnlTracker[pnlKey]) {
          const position = pnlTracker[pnlKey];
          const avgBuyPrice = position.totalSOLSpent / position.totalTokenBought;
          const currentPrice = solAmount / tokenAmount;
          const pnlPercent = ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100;
          const pnlSOL = solAmount - (avgBuyPrice * tokenAmount);
          const pnlEmoji = getPnLEmoji(pnlPercent);

          // Sell % tracker
          const sellPercent = (tokenAmount / position.totalTokenBought) * 100;
          sellPercentLine = `\n📊 Sold: <b>${sellPercent.toFixed(1)}%</b> of position`;

          pnlLine = `\n${pnlEmoji} PnL: <b>${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(1)}%</b> (${pnlSOL >= 0 ? "+" : ""}${pnlSOL.toFixed(4)} SOL)`;

          // Update sisa posisi
          pnlTracker[pnlKey].totalTokenBought -= tokenAmount;
          if (pnlTracker[pnlKey].totalTokenBought <= 0) {
            delete pnlTracker[pnlKey]; // posisi habis
          }
        }
      }

      const swapLine = isBuy
        ? `<a href="${solscanWallet}">${shortWallet}</a> swapped <b>${solAmount.toFixed(4)} <a href="${solscanSOL}">SOL</a></b> for <b>${tokenAmount.toLocaleString()} ($${tokenUSDValue}) <a href="${solscanToken}">${tokenName}</a></b> @$${tokenPrice.toFixed(6)}`
        : `<a href="${solscanWallet}">${shortWallet}</a> swapped <b>${tokenAmount.toLocaleString()} ($${tokenUSDValue}) <a href="${solscanToken}">${tokenName}</a></b> for <b>${solAmount.toFixed(4)} <a href="${solscanSOL}">SOL</a></b> @$${tokenPrice.toFixed(6)}`;

      const message =
`🟢 <a href="${solscanTx}"><b>SWAP ${tokenName}</b></a> on ${dexName}
🔹 <a href="${solscanWallet}">${shortWallet}</a>

🔹${swapLine}${pnlLine}${sellPercentLine}

💊 <b>#${tokenSymbol}</b> | MC: ${formatUSD(marketCap)} | <a href="https://birdeye.so/token/${tokenMint}?chain=solana">BE</a> | <a href="https://dexscreener.com/solana/${tokenMint}">DS</a> | <a href="https://photon-sol.tinyastro.io/en/r/@RayBot/${tokenMint}">PH</a> | <a href="https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint}">Bullx</a> | <a href="https://gmgn.ai/sol/token/${tokenMint}">GMGN</a> | <a href="https://axiom.trade/t/${tokenMint}">AXI</a> | <a href="https://t.me/solana_notify_bot?start=t__${tokenMint}">👥INFO</a>
<code>${tokenMint}</code>`;

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: "🐴 Trojan WEB", url: `https://t.me/solana_trojanbot?start=r-${tokenMint}` },
            { text: `Padre: ${tokenName}`, url: `https://t.me/padre_bot?start=${tokenMint}` },
            { text: `🦅 GMGN: ${tokenName}`, url: `https://gmgn.ai/sol/token/${tokenMint}` },
          ],
          [
            { text: `AXIOM: ${tokenName}`, url: `https://axiom.trade/t/${tokenMint}` },
            { text: `Trojan: ${tokenName}`, url: `https://t.me/solana_trojanbot?start=${tokenMint}` },
            { text: `Bonk: ${tokenName}`, url: `https://bonkbot.io/?token=${tokenMint}` },
          ]
        ]
      };

      console.log(`Sending SWAP message for ${tokenName}...`);

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHANNEL_ID,
        text: message,
        parse_mode: "HTML",
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
