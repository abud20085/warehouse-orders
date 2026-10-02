const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let nextOrderId = 100;
const orders = [];
const clients = new Set();

function broadcast(payload) {
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(message); } catch {}
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "warehouse-orders" });
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: "snapshot", orders })}\n\n`);

  req.on("close", () => clients.delete(res));
});

app.post("/orders", (req, res) => {
  const { sender, product, size = "", color = "", note = "" } = req.body || {};

  if (!sender || !product) {
    return res.status(400).json({ error: "اسم الجهاز والمنتج مطلوبان" });
  }

  const order = {
    id: ++nextOrderId,
    createdAt: new Date().toISOString(),
    sender,
    product,
    size,
    color,
    note,
    status: "جديد",
    claimedBy: ""
  };

  orders.push(order);
  broadcast({ type: "order_created", order });

  res.json(order);
});

app.post("/orders/:id/claim", (req, res) => {
  const order = orders.find(x => x.id === Number(req.params.id));

  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });

  if (order.status !== "جديد") {
    return res.status(409).json({
      error: `تم استلام الطلب بواسطة ${order.claimedBy}`
    });
  }

  order.status = "مستلم";
  order.claimedBy = req.body?.by || "";

  broadcast({ type: "order_updated", order });
  res.json(order);
});

app.post("/orders/:id/status", (req, res) => {
  const order = orders.find(x => x.id === Number(req.params.id));

  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });

  const allowed = [
    "جديد",
    "مستلم",
    "جاري البحث",
    "وجدته",
    "غير موجود",
    "بديل",
    "مغلق"
  ];

  if (!allowed.includes(req.body?.status)) {
    return res.status(400).json({ error: "الحالة غير صحيحة" });
  }

  order.status = req.body.status;
  if (req.body.by) order.claimedBy = req.body.by;

  broadcast({ type: "order_updated", order });
  res.json(order);
});

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>نظام طلبات المستودع</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f4f6f8;color:#17202a;font-family:system-ui,-apple-system,Segoe UI,Tahoma,Arial}
.app{max-width:560px;margin:auto;min-height:100vh;background:#fff;padding:20px}
h1{font-size:29px;text-align:center;margin-top:55px}
p{color:#68727d;text-align:center}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:30px}
button{font:inherit;cursor:pointer}
.role{border:1px solid #dfe4e8;border-radius:20px;background:#fff;padding:25px 10px;font-weight:800;font-size:22px}
.role span{display:block;font-size:42px;margin-bottom
