# Warehouse Control Pro 6.0.1

نظام إدارة وتشغيل مستودع عربي RTL.

## الملفات
- `server.js` — الخادم وقاعدة البيانات وواجهات API وWebSocket.
- `public/index.html` — واجهة الموقع.
- `package.json` — الاعتمادات وأوامر التشغيل وإصدار Node المثبت.
- `.node-version` — إصدار Node لـ Render.
- `NODE_VERSION.txt` — نسخة ظاهرة للتأكد من الإصدار: 24.21.0.

## Render
Build Command: `npm install`
Start Command: `npm start`
Node.js: `24.21.0`

تم تثبيت إصدار Node في `package.json` و`.node-version` حتى لا يتحول تلقائياً إلى إصدار أحدث.

## الدخول الأول
- المشرف: `admin` / `admin123`
- الموظف: `downstairs` / `1234`
- الموظف: `upstairs` / `1234`

غيّر كلمات المرور بعد أول دخول.

## ملاحظات
- لا تضع `server.js` داخل `public`.
- يجب أن يكون `public/index.html` داخل مجلد `public`.
- لا تحذف مجلد `data` إذا كان يحتوي على قاعدة بيانات تريد الاحتفاظ بها.
- لا ترفع `node_modules` إلى GitHub؛ Render ينفذ `npm install`.
