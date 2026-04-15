const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const WATCHED_WALLETS = process.env.WATCHED_WALLETS
  // Track processed signatures untuk hindari duplikat
const processedTx = new Set();
  ? process.env.WATCHED_WALLETS.split(",").map(w => w.trim())
  : [];
console.log("WATCHED_WALLETS:", WATCHED_WALLETS);

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

// Skip kalau sudah diproses
if (processedTx.has(signature)) {
  console.log("Skipped duplicate TX:", signature.slice(0, 8));
  continue;
}
processedTx.add(signature);

// Bersihkan set kalau terlalu besar
if (processedTx.size > 1000) processedTx.clear();

      const transfers = tx.tokenTransfers || [];
      const nativeTransfers = tx.nativeTransfers || [];

      let solAmount = 0;
      let tokenMint = null;
      let tokenAmount = 0;
      let isBuy = false;

    // Cari wallet utama — harus dari WATCHED_WALLETS
let mainWallet = null;

// Cek apakah feePayer ada di watched wallets
if (WATCHED_WALLETS.includes(wallet)) {
  mainWallet = wallet;
}

// Cek dari transfers
if (!mainWallet) {
  for (const tt of transfers) {
    if (WATCHED_WALLETS.includes(tt.toUserAccount)) {
      mainWallet = tt.toUserAccount;
      break;
    }
    if (WATCHED_WALLETS.includes(tt.fromUserAccount)) {
      mainWallet = tt.fromUserAccount;
      break;
    }
  }
}

// Cek dari nativeTransfers
if (!mainWallet) {
  for (const nt of nativeTransfers) {
    if (WATCHED_WALLETS.includes(nt.fromUserAccount)) {
      mainWallet = nt.fromUserAccount;
      break;
    }
    if (WATCHED_WALLETS.includes(nt.toUserAccount)) {
      mainWallet = nt.toUserAccount;
      break;
    }
  }
}

// Skip kalau wallet tidak dikenal
if (!mainWallet) {
  console.log("Skipped: wallet not in WATCHED_WALLETS");
  continue;
}

      // Ambil SOL dari tokenTransfers (wrapped SOL) saja — lebih akurat
for (const tt of transfers) {
  const isSOL = tt.mint === "So11111111111111111111111111111111111111112";
  if (!isSOL) continue;
  if (isBuy && tt.fromUserAccount === mainWallet) {
    solAmount += tt.tokenAmount;
  } else if (!isBuy && tt.toUserAccount === mainWallet) {
    solAmount += tt.tokenAmount;
  }
}

// Fallback ke nativeTransfers kalau SOL masih 0
if (solAmount === 0) {
  for (const nt of nativeTransfers) {
    if (isBuy && nt.fromUserAccount === mainWallet) solAmount += nt.amount / 1e9;
    else if (!isBuy && nt.toUserAccount === mainWallet) solAmount += nt.amount / 1e9;
  }
}

     // Cek token direction — jumlahkan semua transfer
const tokenIn = {};  // mint -> total masuk
const tokenOut = {}; // mint -> total keluar

for (const tt of transfers) {
  const isSOL = tt.mint === "So11111111111111111111111111111111111111112";
  if (isSOL) continue;
  if (tt.toUserAccount === mainWallet) {
    tokenIn[tt.mint] = (tokenIn[tt.mint] || 0) + tt.tokenAmount;
  }
  if (tt.fromUserAccount === mainWallet) {
    tokenOut[tt.mint] = (tokenOut[tt.mint] || 0) + tt.tokenAmount;
  }
}

// Tentukan token utama dan arah transaksi
if (Object.keys(tokenIn).length > 0) {
  isBuy = true;
  // Ambil token dengan jumlah terbesar
  tokenMint = Object.keys(tokenIn).reduce((a, b) => tokenIn[a] > tokenIn[b] ? a : b);
  tokenAmount = tokenIn[tokenMint];
} else if (Object.keys(tokenOut).length > 0) {
  isBuy = false;
  tokenMint = Object.keys(tokenOut).reduce((a, b) => tokenOut[a] > tokenOut[b] ? a : b);
  tokenAmount = tokenOut[tokenMint];
}

      if (!tokenMint) continue;

console.log("=== SWAP DEBUG ===");
console.log("mainWallet:", mainWallet);
console.log("isBuy:", isBuy);
console.log("tokenMint:", tokenMint);
console.log("tokenAmount:", tokenAmount);
console.log("solAmount:", solAmount);
console.log("all transfers:", JSON.stringify(transfers.map(t => ({
  mint: t.mint?.slice(0,8),
  from: t.fromUserAccount?.slice(0,8),
  to: t.toUserAccount?.slice(0,8),
  amount: t.tokenAmount
}))));

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

      const swapLine = isBuy
        ? `<a href="${solscanWallet}">${shortWallet}</a> swapped <b>${solAmount.toFixed(4)} <a href="${solscanSOL}">SOL</a></b> for <b>${tokenAmount.toLocaleString()} ($${tokenUSDValue}) <a href="${solscanToken}">${tokenName}</a></b> @$${tokenPrice.toFixed(6)}`
        : `<a href="${solscanWallet}">${shortWallet}</a> swapped <b>${tokenAmount.toLocaleString()} ($${tokenUSDValue}) <a href="${solscanToken}">${tokenName}</a></b> for <b>${solAmount.toFixed(4)} <a href="${solscanSOL}">SOL</a></b> @$${tokenPrice.toFixed(6)}`;

      const message =
`🟢 <a href="${solscanTx}"><b>SWAP ${tokenName}</b></a> on ${dexName}
🔹 <a href="${solscanWallet}">${shortWallet}</a>

🔹${swapLine}

💊 <b>#${tokenSymbol}</b> | MC: ${formatUSD(marketCap)} | <a href="https://birdeye.so/token/${tokenMint}?chain=solana">BE</a> | <a href="https://dexscreener.com/solana/${tokenMint}">DS</a> | <a href="https://photon-sol.tinyastro.io/en/r/@RayBot/${tokenMint}">PH</a> | <a href="https://neo.bullx.io/terminal?chainId=1399811149&address=${tokenMint}">Bullx</a> | <a href="https://gmgn.ai/sol/token/${tokenMint}">GMGN</a> | <a href="https://axiom.trade/t/${tokenMint}">AXI</a> | <a href="https://t.me/solana_notify_bot?start=t__${tokenMint}">👥INFO</a>
<code>${tokenMint}</code>`;

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: "Trojan WEB", url: `https://t.me/solana_trojanbot?start=r-${tokenMint}` },
            { text: `Padre: ${tokenName}`, url: `https://t.me/padre_bot?start=${tokenMint}` },
            { text: `GMGN: ${tokenName}`, url: `https://gmgn.ai/sol/token/${tokenMint}` },
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
