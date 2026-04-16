const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const WATCHED_WALLETS = process.env.WATCHED_WALLETS
  ? process.env.WATCHED_WALLETS.split(",").map(function(w) { return w.trim(); })
  : [];
const WALLET_LABELS = {};
if (process.env.WALLET_LABELS) {
  process.env.WALLET_LABELS.split(",").forEach(function(item) {
    const parts = item.split("=");
    if (parts.length === 2) {
      WALLET_LABELS[parts[0].trim()] = parts[1].trim();
    }
  });
}
console.log("WALLET_LABELS:", WALLET_LABELS);

const processedTx = new Set();

console.log("BOT_TOKEN:", BOT_TOKEN ? "✅ Found" : "❌ Missing");
console.log("CHANNEL_ID:", CHANNEL_ID ? "✅ Found" : "❌ Missing");
console.log("WATCHED_WALLETS:", WATCHED_WALLETS);

async function getTokenInfo(mint) {
  try {
    const res = await axios.get(
      "https://api.dexscreener.com/latest/dex/tokens/" + mint,
      { timeout: 3000 }
    );
    const pair = res.data && res.data.pairs && res.data.pairs[0];
    if (!pair) return null;
    return {
      name: pair.baseToken.name || "Unknown",
      symbol: pair.baseToken.symbol || "???",
      price: parseFloat(pair.priceUsd || 0),
      mc: pair.marketCap || 0,
      dex: pair.dexId || "unknown",
    };
  } catch (e) {
    return null;
  }
}

function formatUSD(num) {
  if (num >= 1000000) return "$" + (num / 1000000).toFixed(2) + "M";
  if (num >= 1000) return "$" + (num / 1000).toFixed(2) + "K";
  return "$" + num.toFixed(2);
}

app.get("/", function(req, res) {
  res.send("Wallet Tracker is running!");
});

app.post("/webhook", async function(req, res) {
  try {
    const txs = req.body;
    if (!txs || !txs.length) return res.sendStatus(200);

    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      const wallet = tx.feePayer || "Unknown";
      const type = tx.type || "UNKNOWN";
      const signature = tx.signature || "";

      console.log("TX type:", type);
      if (type !== "SWAP") continue;

      // Skip duplikat
      if (processedTx.has(signature)) {
        console.log("Skipped duplicate:", signature.slice(0, 8));
        continue;
      }
      processedTx.add(signature);
      if (processedTx.size > 1000) processedTx.clear();

      const transfers = tx.tokenTransfers || [];
      const nativeTransfers = tx.nativeTransfers || [];

      // Cari mainWallet dari WATCHED_WALLETS
      let mainWallet = null;

      if (WATCHED_WALLETS.indexOf(wallet) !== -1) {
        mainWallet = wallet;
      }

      if (!mainWallet) {
        for (let j = 0; j < transfers.length; j++) {
          const tt = transfers[j];
          if (WATCHED_WALLETS.indexOf(tt.toUserAccount) !== -1) {
            mainWallet = tt.toUserAccount;
            break;
          }
          if (WATCHED_WALLETS.indexOf(tt.fromUserAccount) !== -1) {
            mainWallet = tt.fromUserAccount;
            break;
          }
        }
      }

      if (!mainWallet) {
        for (let j = 0; j < nativeTransfers.length; j++) {
          const nt = nativeTransfers[j];
          if (WATCHED_WALLETS.indexOf(nt.fromUserAccount) !== -1) {
            mainWallet = nt.fromUserAccount;
            break;
          }
          if (WATCHED_WALLETS.indexOf(nt.toUserAccount) !== -1) {
            mainWallet = nt.toUserAccount;
            break;
          }
        }
      }

      if (!mainWallet) {
        console.log("Skipped: wallet not in WATCHED_WALLETS");
        continue;
      }

      let solAmount = 0;
      let tokenMint = null;
      let tokenAmount = 0;
      let isBuy = false;

      // Deteksi token direction
      const tokenIn = {};
      const tokenOut = {};
      const SOL_MINT = "So11111111111111111111111111111111111111112";

      for (let j = 0; j < transfers.length; j++) {
        const tt = transfers[j];
        if (tt.mint === SOL_MINT) continue;
        if (tt.toUserAccount === mainWallet) {
          tokenIn[tt.mint] = (tokenIn[tt.mint] || 0) + tt.tokenAmount;
        }
        if (tt.fromUserAccount === mainWallet) {
          tokenOut[tt.mint] = (tokenOut[tt.mint] || 0) + tt.tokenAmount;
        }
      }

      const tokenInKeys = Object.keys(tokenIn);
      const tokenOutKeys = Object.keys(tokenOut);

      if (tokenInKeys.length > 0) {
        isBuy = true;
        tokenMint = tokenInKeys.reduce(function(a, b) {
          return tokenIn[a] > tokenIn[b] ? a : b;
        });
        tokenAmount = tokenIn[tokenMint];
      } else if (tokenOutKeys.length > 0) {
        isBuy = false;
        tokenMint = tokenOutKeys.reduce(function(a, b) {
          return tokenOut[a] > tokenOut[b] ? a : b;
        });
        tokenAmount = tokenOut[tokenMint];
      }

      if (!tokenMint) continue;

      // Hitung SOL
      for (let j = 0; j < transfers.length; j++) {
        const tt = transfers[j];
        if (tt.mint !== SOL_MINT) continue;
        if (isBuy && tt.fromUserAccount === mainWallet) solAmount += tt.tokenAmount;
        else if (!isBuy && tt.toUserAccount === mainWallet) solAmount += tt.tokenAmount;
      }

      if (solAmount === 0) {
        for (let j = 0; j < nativeTransfers.length; j++) {
          const nt = nativeTransfers[j];
          if (isBuy && nt.fromUserAccount === mainWallet) solAmount += nt.amount / 1e9;
          else if (!isBuy && nt.toUserAccount === mainWallet) solAmount += nt.amount / 1e9;
        }
      }

      console.log("mainWallet:", mainWallet);
      console.log("isBuy:", isBuy, "| tokenAmount:", tokenAmount, "| solAmount:", solAmount);

      const tokenInfo = await getTokenInfo(tokenMint);
      const tokenName = tokenInfo ? tokenInfo.name : "Unknown";
      const tokenSymbol = tokenInfo ? tokenInfo.symbol : "???";
      const tokenPrice = tokenInfo ? tokenInfo.price : 0;
      const marketCap = tokenInfo ? tokenInfo.mc : 0;
      const dexName = tokenInfo ? tokenInfo.dex.toUpperCase() : "DEX";

      const tokenUSDValue = (tokenAmount * tokenPrice).toFixed(2);
      const shortWallet = WALLET_LABELS[mainWallet] || mainWallet.slice(0, 6) + "..." + mainWallet.slice(-4);
      const solscanTx = "https://solscan.io/tx/" + signature;
      const solscanWallet = "https://solscan.io/account/" + mainWallet + "?exclude_amount_zero=true&remove_spam=true#transfers";
      const solscanSOL = "https://solscan.io/token/" + SOL_MINT;
      const solscanToken = "https://solscan.io/token/" + tokenMint;

      const swapLine = isBuy
        ? '<a href="' + solscanWallet + '">' + shortWallet + '</a> swapped <b>' + solAmount.toFixed(4) + ' <a href="' + solscanSOL + '">SOL</a></b> for <b>' + tokenAmount.toLocaleString() + ' ($' + tokenUSDValue + ') <a href="' + solscanToken + '">' + tokenName + '</a></b> @$' + tokenPrice.toFixed(6)
        : '<a href="' + solscanWallet + '">' + shortWallet + '</a> swapped <b>' + tokenAmount.toLocaleString() + ' ($' + tokenUSDValue + ') <a href="' + solscanToken + '">' + tokenName + '</a></b> for <b>' + solAmount.toFixed(4) + ' <a href="' + solscanSOL + '">SOL</a></b> @$' + tokenPrice.toFixed(6);

      const message =
        (isBuy ? "🟢" : "🔴") + ' <a href="' + solscanTx + '"><b>SWAP ' + tokenName + '</b></a> on ' + dexName + '\n' +
        '🔹 <a href="' + solscanWallet + '">' + shortWallet + '</a>\n\n' +
        '🔹' + swapLine + '\n\n' +
        '💊 <b>#' + tokenSymbol + '</b> | MC: ' + formatUSD(marketCap) +
        ' | <a href="https://birdeye.so/token/' + tokenMint + '?chain=solana">BE</a>' +
        ' | <a href="https://dexscreener.com/solana/' + tokenMint + '">DS</a>' +
        ' | <a href="https://photon-sol.tinyastro.io/en/r/@RayBot/' + tokenMint + '">PH</a>' +
        ' | <a href="https://neo.bullx.io/terminal?chainId=1399811149&address=' + tokenMint + '">Bullx</a>' +
        ' | <a href="https://gmgn.ai/sol/token/' + tokenMint + '">GMGN</a>' +
        ' | <a href="https://axiom.trade/t/' + tokenMint + '">AXI</a>' +
        ' | <a href="https://t.me/solana_notify_bot?start=t__' + tokenMint + '">👥INFO</a>\n' +
        '<code>' + tokenMint + '</code>';

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: "🐴 Trojan WEB", url: "https://t.me/solana_trojanbot?start=r-" + tokenMint },
            { text: "Padre: " + tokenName, url: "https://t.me/padre_bot?start=" + tokenMint },
            { text: "🦅 GMGN: " + tokenName, url: "https://gmgn.ai/sol/token/" + tokenMint },
          ],
          [
            { text: "AXIOM: " + tokenName, url: "https://axiom.trade/t/" + tokenMint },
            { text: "Trojan: " + tokenName, url: "https://t.me/solana_trojanbot?start=" + tokenMint },
            { text: "Bonk: " + tokenName, url: "https://bonkbot.io/?token=" + tokenMint },
          ]
        ]
      };

      console.log("Sending SWAP message for " + tokenName + "...");

      await axios.post("https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage", {
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
    console.error("Error:", err.response ? err.response.data : err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});
