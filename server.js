const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let nextOrderId = 100;
const orders = [];
const clients = new Set();

function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;

  for (const client of clients) {
    try {
      client.write(message);
    } catch (error) {
      clients.delete(client);
    }
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "warehouse-orders"
  });
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  clients.add(res);

  res.write(
    `data: ${JSON.stringify({
      type: "snapshot",
      orders
    })}\n\n`
  );

  req.on("close", () => {
    clients.delete(res);
  });
});

app.post("/orders", (req, res) => {
  const {
    sender,
    product,
    size = "",
    color = "",
    note = ""
  } = req.body || {};

  if (!sender || !product) {
    return res.status(400).json({
      error: "اسم الجهاز والمنتج مطلوبان"
    });
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

  broadcast({
    type: "order_created",
    order
  });

  res.json(order);
});

app.post("/orders/:id/claim", (req, res) => {
  const id = Number(req.params.id);

  const order = orders.find(item => item.id === id);

  if (!order) {
    return res.status(404).json({
      error: "الطلب غير موجود"
    });
  }

  if (order.status !== "جديد") {
    return res.status(409).json({
      error: `تم استلام الطلب بواسطة ${order.claimedBy}`
    });
  }

  order.status = "مستلم";
  order.claimedBy = req.body?.by || "";

  broadcast({
    type: "order_updated",
    order
  });

  res.json(order);
});

app.post("/orders/:id/status", (req, res) => {
  const id = Number(req.params.id);

  const order = orders.find(item => item.id === id);

  if (!order) {
    return res.status(404).json({
      error: "الطلب غير موجود"
    });
  }

  const allowedStatuses = [
    "جديد",
    "مستلم",
    "جاري البحث",
    "وجدته",
    "غير موجود",
    "بديل",
    "مغلق"
  ];

  const newStatus = req.body?.status;

  if (!allowedStatuses.includes(newStatus)) {
    return res.status(400).json({
      error: "الحالة غير صحيحة"
    });
  }

  order.status = newStatus;

  if (req.body?.by) {
    order.claimedBy = req.body.by;
  }

  broadcast({
    type: "order_updated",
    order
  });

  res.json(order);
});

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>

<html lang="ar" dir="rtl">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
/>

<title>نظام طلبات المستودع</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f4f6f8;
  color: #17202a;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Tahoma,
    Arial,
    sans-serif;
}

.app {
  max-width: 600px;
  min-height: 100vh;
  margin: auto;
  background: white;
  padding: 20px;
}

h1 {
  text-align: center;
  margin-top: 50px;
  font-size: 30px;
}

h2 {
  margin-top: 10px;
}

p {
  color: #68727d;
  text-align: center;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 30px;
}

button {
  font: inherit;
  cursor: pointer;
}

.role {
  background: white;
  border: 1px solid #dfe4e8;
  border-radius: 20px;
  padding: 25px 10px;
  font-size: 21px;
  font-weight: 800;
}

.role span {
  display: block;
  font-size: 42px;
  margin-bottom: 10px;
}

.panel {
  margin-top: 35px;
}

input,
textarea {
  width: 100%;
  padding: 14px;
  margin: 6px 0 14px;
  border: 1px solid #d7dde2;
  border-radius: 13px;
  font: inherit;
}

textarea {
  min-height: 100px;
  resize: vertical;
}

.primary {
  width: 100%;
  padding: 15px;
  border: 0;
  border-radius: 14px;
  background: #17202a;
  color: white;
  font-weight: 800;
}

.secondary {
  border: 0;
  border-radius: 11px;
  padding: 11px 14px;
  background: #edf0f2;
  font-weight: 700;
}

.hidden {
  display: none;
}

.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.badge {
  background: #edf0f2;
  border-radius: 20px;
  padding: 6px 10px;
  font-size: 12px;
  white-space: nowrap;
}

.card {
  border: 1px solid #dfe4e8;
  border-radius: 17px;
  padding: 15px;
  margin: 12px 0;
}

.card b {
  font-size: 17px;
}

.meta {
  color: #68727d;
  font-size: 13px;
  margin-top: 7px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}

.action {
  border: 0;
  border-radius: 10px;
  padding: 10px 12px;
  background: #edf0f2;
  font-weight: 700;
}

.claim {
  background: #17202a;
  color: white;
}

.back {
  border: 0;
  background: transparent;
  padding: 5px;
  font-weight: 700;
}

.empty {
  padding: 30px 10px;
}

</style>

</head>

<body>

<div class="app">

  <div id="home">

    <h1>📦 نظام طلبات المستودع</h1>

    <p>
      اختر نوع الجهاز
    </p>

    <div class="grid">

      <button
        class="role"
        onclick="chooseRole('downstairs')"
      >
        <span>🛒</span>
        تحت
      </button>

      <button
        class="role"
        onclick="chooseRole('upstairs')"
      >
        <span>📦</span>
        فوق
      </button>

    </div>

  </div>


  <div id="login" class="hidden panel">

    <button
      class="back"
      onclick="showScreen('home')"
    >
      ← رجوع
    </button>

    <h2 id="loginTitle">
      تسجيل الجهاز
    </h2>

    <p>
      اكتب اسم الجهاز
    </p>

    <input
      id="deviceName"
      placeholder="مثال: جهاز 1"
    />

    <button
      class="primary"
      onclick="login()"
    >
      دخول
    </button>

  </div>


  <div id="main" class="hidden">

    <div class="top">

      <h2 id="pageTitle"></h2>

      <span
        class="badge"
        id="deviceBadge"
      ></span>

    </div>


    <div id="senderPanel" class="hidden">

      <button
        class="primary"
        onclick="openOrderForm()"
      >
        ＋ إرسال طلب
      </button>

      <h3>
        طلباتي
      </h3>

      <div id="myOrders"></div>

    </div>


    <div id="warehousePanel" class="hidden">

      <h3>
        الطلبات الواردة
      </h3>

      <div id="warehouseOrders"></div>

    </div>

  </div>


  <div id="orderForm" class="hidden panel">

    <button
      class="back"
      onclick="showScreen('main')"
    >
      ← رجوع
    </button>

    <h2>
      إرسال طلب جديد
    </h2>

    <input
      id="product"
      placeholder="اسم المنتج"
    />

    <input
      id="size"
      placeholder="المقاس"
    />

    <input
      id="color"
      placeholder="اللون"
    />

    <textarea
      id="note"
      placeholder="ملاحظة إضافية"
    ></textarea>

    <button
      class="primary"
      onclick="sendOrder()"
    >
      إرسال الطلب
    </button>

  </div>

</div>


<script>

let role = "";

let deviceName = "";

let orders = [];

let eventSource = null;


const $ = id => {
  return document.getElementById(id);
};


function showScreen(screen) {

  const screens = [
    "home",
    "login",
    "main",
    "orderForm"
  ];

  screens.forEach(id => {
    $(id).classList.add("hidden");
  });

  $(screen).classList.remove("hidden");
}


function chooseRole(selectedRole) {

  role = selectedRole;

  if (role === "upstairs") {

    $("loginTitle").textContent =
      "تسجيل جهاز المستودع";

  } else {

    $("loginTitle").textContent =
      "تسجيل جهاز تحت";

  }

  $("deviceName").value = "";

  showScreen("login");

  $("deviceName").focus();
}


function login() {

  const name =
    $("deviceName").value.trim();

  if (!name) {

    alert("اكتب اسم الجهاز أولاً");

    return;
  }

  deviceName = name;

  if (role === "upstairs") {

    $("pageTitle").textContent =
      "المستودع";

  } else {

    $("pageTitle").textContent =
      "الطلبات";

  }

  $("deviceBadge").textContent =
    deviceName;

  $("senderPanel")
    .classList.toggle(
      "hidden",
      role !== "downstairs"
    );

  $("warehousePanel")
    .classList.toggle(
      "hidden",
      role !== "upstairs"
    );

  showScreen("main");

  connectToServer();

  render();
}


function openOrderForm() {

  showScreen("orderForm");

}


async function sendOrder() {

  const product =
    $("product").value.trim();

  const size =
    $("size").value.trim();

  const color =
    $("color").value.trim();

  const note =
    $("note").value.trim();


  if (!product) {

    alert("اكتب اسم المنتج");

    return;
  }


  try {

    const response =
      await fetch("/orders", {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({

          sender: deviceName,

          product,

          size,

          color,

          note

        })

      });


    if (!response.ok) {

      throw new Error(
        "تعذر إرسال الطلب"
      );

    }


    $("product").value = "";

    $("size").value = "";

    $("color").value = "";

    $("note").value = "";


    showScreen("main");

  } catch (error) {

    alert(
      "تعذر إرسال الطلب. حاول مرة أخرى."
    );

  }

}


async function claimOrder(id) {

  try {

    const response =
      await fetch(
        "/orders/" + id + "/claim",
        {

          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            by: deviceName
          })

        }
      );


    if (!response.ok) {

      const data =
        await response.json();

      alert(
        data.error ||
        "تم استلام الطلب مسبقاً"
      );

    }

  } catch (error) {

    alert(
      "حدث خطأ في استلام الطلب"
    );

  }

}


async function changeStatus(
  id,
  status
) {

  try {

    await fetch(
      "/orders/" + id + "/status",
      {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({

          status,

          by: deviceName

        })

      }
    );

  } catch (error) {

    alert(
      "تعذر تحديث حالة الطلب"
    );

  }

}


function connectToServer() {

  if (eventSource) {

    eventSource.close();

  }


  eventSource =
    new EventSource("/events");


  eventSource.onmessage =
    function(event) {

      const data =
        JSON.parse(event.data);


      if (data.type === "snapshot") {

        orders =
          data.orders || [];

      }


      if (data.order) {

        const index =
          orders.findIndex(
            item =>
              item.id === data.order.id
          );


        if (index === -1) {

          orders.push(
            data.order
          );

        } else {

          orders[index] =
            data.order;

        }

      }


      render();

    };


  eventSource.onerror =
    function() {

      /*
        المتصفح سيحاول إعادة
        الاتصال تلقائياً.
      */

    };

}


function render() {

  if (role === "downstairs") {

    const myOrders =
      orders.filter(
        order =>
          order.sender === deviceName
      );


    if (!myOrders.length) {

      $("myOrders").innerHTML =
        '<div class="empty"><p>لا توجد طلبات حالياً</p></div>';

      return;

    }


    $("myOrders").innerHTML =
      myOrders
        .slice()
        .reverse()
        .map(renderSenderOrder)
        .join("");

  }


  if (role === "upstairs") {

    const openOrders =
      orders.filter(
        order =>
          order.status !== "مغلق"
      );


    if (!openOrders.length) {

      $("warehouseOrders").innerHTML =
        '<div class="empty"><p>لا توجد طلبات حالياً</p></div>';

      return;

    }


    $("warehouseOrders").innerHTML =
      openOrders
        .slice()
        .sort(
          (a, b) =>
            new Date(a.createdAt) -
            new Date(b.createdAt)
        )
        .map(renderWarehouseOrder)
        .join("");

  }

}


function renderSenderOrder(order) {

  return `

    <div class="card">

      <b>
        #${order.id}
        —
        ${escapeHtml(order.product)}
      </b>

      <div class="meta">
        الحالة:
        ${escapeHtml(order.status)}
      </div>

      ${
        order.size
          ? `
            <div class="meta">
              المقاس:
              ${escapeHtml(order.size)}
            </div>
          `
          : ""
      }

      ${
        order.color
          ? `
            <div class="meta">
              اللون:
              ${escapeHtml(order.color)}
            </div>
          `
          : ""
      }

      ${
        order.claimedBy
          ? `
            <div class="meta">
              مستلم بواسطة:
              ${escapeHtml(order.claimedBy)}
            </div>
          `
          : ""
      }

    </div>

  `;

}


function renderWarehouseOrder(order) {

  return `

    <div class="card">

      <b>
        #${order.id}
        —
        ${escapeHtml(order.product)}
      </b>

      <div class="meta">
        من:
        ${escapeHtml(order.sender)}
      </div>

      ${
        order.size
          ? `
            <div class="meta">
              المقاس:
              ${escapeHtml(order.size)}
            </div>
          `
          : ""
      }

      ${
        order.color
          ? `
            <div class="meta">
              اللون:
              ${escapeHtml(order.color)}
            </div>
          `
          : ""
      }

      ${
        order.note
          ? `
            <div class="meta">
              الملاحظة:
              ${escapeHtml(order.note)}
            </div>
          `
          : ""
      }

      <div class="meta">

        الحالة:

        <b>
          ${escapeHtml(order.status)}
        </b>

        ${
          order.claimedBy
            ? `
              —
              ${escapeHtml(
                order.claimedBy
              )}
            `
            : ""
        }

      </div>


      <div class="actions">

        ${
          order.status === "جديد"
            ? `
              <button
                class="action claim"
                onclick="claimOrder(${order.id})"
              >
                استلام الطلب
              </button>
            `
            : ""
        }


        <button
          class="action"
          onclick="changeStatus(
            ${order.id},
            'جاري البحث'
          )"
        >
          جاري البحث
        </button>


        <button
          class="action"
          onclick="changeStatus(
            ${order.id},
            'وجدته'
          )"
        >
          وجدته
        </button>


        <button
          class="action"
          onclick="changeStatus(
            ${order.id},
            'غير موجود'
          )"
        >
          غير موجود
        </button>


        <button
          class="action"
          onclick="changeStatus(
            ${order.id},
            'بديل'
          )"
        >
          بديل
        </button>


        <button
          class="action"
          onclick="changeStatus(
            ${order.id},
            'مغلق'
          )"
        >
          إغلاق
        </button>

      </div>

    </div>

  `;

}


function escapeHtml(value) {

  return String(value ?? "")
    .replace(
      /[&<>"']/g,
      function(character) {

        return {

          "&": "&amp;",

          "<": "&lt;",

          ">": "&gt;",

          '"': "&quot;",

          "'": "&#039;"

        }[character];

      }
    );

}

</script>

</body>

</html>
  `);
});


app.listen(PORT, () => {

  console.log(
    "Warehouse Orders running on port " +
    PORT
  );

});
