const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// إعدادات السيرفر
// =========================

app.use(express.json());
app.use(express.static("public"));

// =========================
// البيانات المؤقتة
// =========================

let orders = [];
let nextId = 1;

const clients = new Set();

// =========================
// الصفحة الرئيسية
// =========================

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// =========================
// فحص السيرفر
// =========================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    orders: orders.length
  });
});

// =========================
// جلب الطلبات
// =========================

app.get("/api/orders", (req, res) => {
  res.json(orders);
});

// =========================
// إنشاء طلب جديد
// =========================

app.post("/api/orders", (req, res) => {
  const {
    product,
    size,
    color,
    note,
    sender
  } = req.body;

  if (!product) {
    return res.status(400).json({
      error: "اسم المنتج مطلوب"
    });
  }

  const order = {
    id: nextId++,
    product: String(product).trim(),
    size: size ? String(size).trim() : "",
    color: color ? String(color).trim() : "",
    note: note ? String(note).trim() : "",
    sender: sender ? String(sender).trim() : "غير معروف",

    status: "new",
    claimedBy: null,

    createdAt: new Date().toISOString(),
    claimedAt: null,
    completedAt: null
  };

  orders.push(order);

  broadcast({
    type: "new_order",
    order
  });

  res.status(201).json(order);
});

// =========================
// استلام الطلب
// =========================

app.post("/api/orders/:id/claim", (req, res) => {
  const id = Number(req.params.id);
  const { receiver } = req.body;

  const order = orders.find(o => o.id === id);

  if (!order) {
    return res.status(404).json({
      error: "الطلب غير موجود"
    });
  }

  // شخص آخر استلم الطلب قبلك
  if (order.claimedBy) {
    return res.status(409).json({
      error: "تم استلام الطلب مسبقاً",
      order
    });
  }

  if (!receiver) {
    return res.status(400).json({
      error: "اسم المستلم مطلوب"
    });
  }

  order.status = "claimed";
  order.claimedBy = String(receiver).trim();
  order.claimedAt = new Date().toISOString();

  broadcast({
    type: "order_claimed",
    order
  });

  res.json(order);
});

// =========================
// تغيير حالة الطلب
// =========================

app.post("/api/orders/:id/status", (req, res) => {
  const id = Number(req.params.id);
  const { status, receiver } = req.body;

  const order = orders.find(o => o.id === id);

  if (!order) {
    return res.status(404).json({
      error: "الطلب غير موجود"
    });
  }

  // فقط الشخص الذي استلم الطلب يستطيع تغييره
  if (order.claimedBy && receiver !== order.claimedBy) {
    return res.status(403).json({
      error: "هذا الطلب مستلم بواسطة موظف آخر"
    });
  }

  const allowedStatuses = [
    "new",
    "claimed",
    "completed",
    "closed"
  ];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: "حالة غير صحيحة"
    });
  }

  order.status = status;

  if (status === "completed" || status === "closed") {
    order.completedAt = new Date().toISOString();
  }

  broadcast({
    type: "order_updated",
    order
  });

  res.json(order);
});

// =========================
// الاتصال المباشر للأجهزة
// SSE
// =========================

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`data: ${JSON.stringify({
    type: "connected"
  })}\n\n`);

  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });
});

// =========================
// إرسال تحديث لجميع الأجهزة
// =========================

function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;

  for (const client of clients) {
    client.write(message);
  }
}

// =========================
// تشغيل السيرفر
// =========================

app.listen(PORT, () => {
  console.log(`Warehouse server running on port ${PORT}`);
});
