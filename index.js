const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

app.get("/", (req, res) => res.send("Wallet Tracker is running!"));

app.post("/webhook", async (req, res) => {
  try {
    const txs = req.body;
    if (!txs || !txs.length) return res.sendStatus(200);

    for (const tx of txs) {
      const wallet = tx.feePayer || "Unknown";
      const type = tx.type || "UNKNOWN";
      const signature = tx.signature || "";
      const timestamp = new Date(tx.timestamp * 1000).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta"
      });

      // Hanya proses transaksi SWAP (beli/jual token)
      if (type !== "SWAP") continue;

      const transfers = tx.tokenTransfers || [];
      const tokenIn = transfers[0];
      const tokenOut = transfers[1];

      const amountIn = tokenIn?.tokenAmount?.toFixed(4) || "?";
      const amountOut = tokenOut?.tokenAmount?.toFixed(4) || "?";
      const mintIn = tokenIn?.mint ? tokenIn.mint.slice(0, 6) + "..." : "SOL";
      const mintOut = tokenOut?.mint ? tokenOut.mint.slice(0, 6) + "..." : "SOL";
      const shortWallet = wallet.slice(0, 6) + "..." + wallet.slice(-4);
      const solscanUrl = `https://solscan.io/tx/${signature}`;

      const message = 
`🟢 *SWAP DETECTED*

👛 Wallet: \`${shortWallet}\`
💸 Spent: ${amountIn} ${mintIn}
🪙 Received: ${amountOut} ${mintOut}
🕐 Time: ${timestamp}

🔗 [View on Solscan](${solscanUrl})`;

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHANNEL_ID,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error:", err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
