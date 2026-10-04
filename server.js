
const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "warehouse.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('supervisor','downstairs','upstairs')),
  password_hash TEXT,
  status TEXT DEFAULT 'available',
  can_send INTEGER DEFAULT 1,
  can_receive INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  number TEXT,
  letter TEXT,
  size TEXT,
  color TEXT,
  notes TEXT,
  sender_id INTEGER,
  sender_name TEXT,
  status TEXT DEFAULT 'new',
  priority TEXT DEFAULT 'normal',
  claimant_id INTEGER,
  claimant_name TEXT,
  prepared_by TEXT,
  prepared_at TEXT,
  confirmed_at TEXT,
  closed_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  type TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  file_name TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS display_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  number TEXT,
  letter TEXT,
  size TEXT,
  color TEXT,
  status TEXT DEFAULT 'requested',
  created_by TEXT,
  completed_by TEXT,
  ended_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS special_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_name TEXT,
  text TEXT,
  audio_file TEXT,
  status TEXT DEFAULT 'new',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_name TEXT,
  location TEXT,
  detail TEXT,
  response TEXT,
  status TEXT DEFAULT 'new',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

function now() { return new Date().toISOString(); }
function idToken() { return crypto.randomBytes(18).toString("hex"); }

const defaults = {
  supervisor_password: bcrypt.hashSync("123456", 10),
  prep_limit: "10",
  display_alert_seconds: "30",
  display_alert_enabled: "1",
  audio_retention_days: "60"
};
for (const [k,v] of Object.entries(defaults)) {
  db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)").run(k,v);
}

if (db.prepare("SELECT COUNT(*) c FROM users").get().c === 0) {
  const t = now();
  const ins = db.prepare("INSERT INTO users(name,role,password_hash,created_at) VALUES(?,?,?,?)");
  ins.run("المشرف", "supervisor", defaults.supervisor_password, t);
  ins.run("موظف الصالة", "downstairs", null, t);
  ins.run("حافظ", "upstairs", null, t);
  ins.run("موظف مستودع 2", "upstairs", null, t);
}

app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname, "public")));
app.use("/audio", express.static(AUDIO_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_,__,cb)=>cb(null,AUDIO_DIR),
    filename: (_,file,cb)=>cb(null, Date.now()+"-"+idToken()+path.extname(file.originalname||".webm"))
  }),
  limits:{fileSize: 10*1024*1024}
});

const sessions = new Map();
const clients = new Set();

function auth(req,res,next){
  const token = req.headers.authorization?.replace("Bearer ","");
  const user = token && sessions.get(token);
  if(!user) return res.status(401).json({error:"غير مسجل الدخول"});
  req.user = user;
  next();
}
function role(req,...roles){ return roles.includes(req.user.role); }
function setting(k){ return db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value; }
function emit(type,payload={}) {
  const msg = JSON.stringify({type,...payload});
  for(const c of clients) try { c.send(msg); } catch {}
}
function event(orderId,type,actor,details=""){
  db.prepare("INSERT INTO events(order_id,type,actor_id,actor_name,details,created_at) VALUES(?,?,?,?,?,?)")
    .run(orderId,type,actor?.id||null,actor?.name||null,details,now());
}
function orderCode(o){
  return [o.number,o.letter,o.size,o.color].filter(Boolean).join("-");
}
function cleanUpper(v){ return (v??"").toString().trim().toUpperCase(); }

app.get("/health",(req,res)=>res.json({ok:true, time:now()}));

app.post("/api/login",(req,res)=>{
  const {role: r, name, password} = req.body;
  if(r==="supervisor"){
    const u=db.prepare("SELECT * FROM users WHERE role='supervisor' LIMIT 1").get();
    if(!u || !bcrypt.compareSync(password||"",u.password_hash)) return res.status(401).json({error:"بيانات المشرف غير صحيحة"});
    const user={id:u.id,name:u.name,role:u.role};
    const token=idToken(); sessions.set(token,user);
    return res.json({token,user});
  }
  if(!["downstairs","upstairs"].includes(r)) return res.status(400).json({error:"الدور غير صحيح"});
  const nm=(name||"").trim();
  if(!nm) return res.status(400).json({error:"اكتب الاسم"});
  let u=db.prepare("SELECT * FROM users WHERE name=? AND role=?").get(nm,r);
  if(!u){
    const t=now();
    const info=db.prepare("INSERT INTO users(name,role,created_at) VALUES(?,?,?)").run(nm,r,t);
    u={id:info.lastInsertRowid,name:nm,role:r,status:"available",can_send:1,can_receive:1};
  }
  const user={id:u.id,name:u.name,role:u.role};
  const token=idToken(); sessions.set(token,user);
  res.json({token,user});
});

app.post("/api/logout",auth,(req,res)=>{
  const token=req.headers.authorization?.replace("Bearer ",""); sessions.delete(token); res.json({ok:true});
});

app.get("/api/bootstrap",auth,(req,res)=>{
  const orders=db.prepare(`
    SELECT * FROM orders
    WHERE status NOT IN ('closed','cancelled')
    ORDER BY datetime(created_at) ASC
  `).all();
  const displays=db.prepare(`SELECT * FROM display_items WHERE status IN ('requested','waiting') ORDER BY datetime(created_at) ASC`).all();
  const allDisplays=db.prepare(`SELECT * FROM display_items ORDER BY datetime(created_at) DESC LIMIT 200`).all();
  const users=db.prepare(`SELECT id,name,role,status,can_send,can_receive FROM users ORDER BY name`).all();
  const specials=db.prepare(`SELECT * FROM special_requests ORDER BY datetime(created_at) DESC LIMIT 100`).all();
  const summons=db.prepare(`SELECT * FROM summons ORDER BY datetime(created_at) DESC LIMIT 100`).all();
  res.json({me:req.user,orders,displays,allDisplays,users,specials,summons,settings:{
    prepLimit:Number(setting("prep_limit")),
    displayAlertSeconds:Number(setting("display_alert_seconds")),
    displayAlertEnabled:setting("display_alert_enabled")==="1",
    audioRetentionDays:Number(setting("audio_retention_days"))
  }});
});

app.get("/api/history",auth,(req,res)=>{
  const q=cleanUpper(req.query.q||"");
  const status=req.query.status||"";
  const from=req.query.from||"";
  const to=req.query.to||"";
  let sql=`SELECT * FROM orders WHERE 1=1`;
  const args=[];
  if(q){sql+=` AND (UPPER(COALESCE(code,'')) LIKE ? OR UPPER(COALESCE(number,'')) LIKE ? OR UPPER(COALESCE(letter,'')) LIKE ? OR UPPER(COALESCE(size,'')) LIKE ? OR UPPER(COALESCE(color,'')) LIKE ? OR UPPER(COALESCE(sender_name,'')) LIKE ?)`; const z=`%${q}%`; args.push(z,z,z,z,z,z);}
  if(status){sql+=` AND status=?`;args.push(status);}
  if(from){sql+=` AND date(created_at)>=date(?)`;args.push(from);}
  if(to){sql+=` AND date(created_at)<=date(?)`;args.push(to);}
  sql+=` ORDER BY datetime(created_at) DESC LIMIT 500`;
  res.json({orders:db.prepare(sql).all(...args)});
});

app.post("/api/orders",auth,(req,res)=>{
  if(req.user.role==="upstairs") return res.status(403).json({error:"موظف المستودع لا يرسل طلب صالة من هنا"});
  const u=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if(u && !u.can_send) return res.status(403).json({error:"الإرسال متوقف عن جهازك"});
  const b=req.body;
  const number=cleanUpper(b.number), letter=cleanUpper(b.letter), size=cleanUpper(b.size), color=cleanUpper(b.color);
  if(!number && !letter && !size && !color && !(b.notes||"").trim()) return res.status(400).json({error:"أدخل معلومة واحدة على الأقل"});
  const t=now();
  const code=[number,letter,size,color].filter(Boolean).join("-");
  const info=db.prepare(`
    INSERT INTO orders(code,number,letter,size,color,notes,sender_id,sender_name,status,priority,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(code,number,letter,size,color,(b.notes||"").trim(),req.user.id,req.user.name,"new",b.priority==="urgent"?"urgent":"normal",t,t);
  const id=info.lastInsertRowid;
  event(id,"created",req.user,"");
  emit("orders_changed",{orderId:id});
  res.json({id});
});

app.post("/api/orders/:id/audio",auth,upload.single("audio"),(req,res)=>{
  const o=db.prepare("SELECT id FROM orders WHERE id=?").get(req.params.id);
  if(!o || !req.file) return res.status(400).json({error:"الصوت غير موجود"});
  db.prepare("INSERT INTO audio(order_id,file_name,created_at) VALUES(?,?,?)").run(o.id,req.file.filename,now());
  event(o.id,"audio",req.user,"");
  emit("orders_changed",{orderId:o.id});
  res.json({ok:true,file:req.file.filename});
});

app.post("/api/orders/:id/claim",auth,(req,res)=>{
  if(req.user.role!=="upstairs") return res.status(403).json({error:"الاستلام للمستودع"});
  const u=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if(u && !u.can_receive) return res.status(403).json({error:"الاستقبال متوقف عنك"});
  const prep=Number(db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('claimed','searching')").get().c);
  const limit=Number(setting("prep_limit")||10);
  if(prep>=limit) return res.status(409).json({error:`وصل عدد قيد التجهيز إلى ${limit}`});
  const o=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if(!o || ["closed","cancelled"].includes(o.status)) return res.status(404).json({error:"الطلب غير موجود"});
  if(o.claimant_id) return res.status(409).json({error:`تم استلامه بواسطة ${o.claimant_name}`});
  db.prepare("UPDATE orders SET status='claimed',claimant_id=?,claimant_name=?,updated_at=? WHERE id=?")
    .run(req.user.id,req.user.name,now(),o.id);
  event(o.id,"claimed",req.user,"");
  emit("orders_changed",{orderId:o.id});
  res.json({ok:true});
});

app.post("/api/orders/:id/status",auth,(req,res)=>{
  const o=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if(!o) return res.status(404).json({error:"الطلب غير موجود"});
  const s=req.body.status;
  const allowed=["searching","needs_reply","prepared","closed","cancelled","returned","unconfirmed","new","claimed"];
  if(!allowed.includes(s)) return res.status(400).json({error:"الحالة غير صحيحة"});
  if(s==="closed" && !["downstairs","supervisor"].includes(req.user.role)) return res.status(403).json({error:"الإغلاق من الصالة أو المشرف"});
  let extra={};
  if(s==="prepared") extra={prepared_by:req.user.name,prepared_at:now()};
  if(s==="closed") extra={closed_reason:req.body.reason||"تم"};
  if(s==="returned") extra={closed_reason:"ترجيع"};
  const sets=["status=?","updated_at=?"]; const vals=[s,now()];
  for(const [k,v] of Object.entries(extra)){sets.push(`${k}=?`);vals.push(v);}
  vals.push(o.id);
  db.prepare(`UPDATE orders SET ${sets.join(",")} WHERE id=?`).run(...vals);
  event(o.id,s,req.user,req.body.details||"");
  emit("orders_changed",{orderId:o.id});
  res.json({ok:true});
});

app.post("/api/orders/:id/transfer",auth,(req,res)=>{
  const toId=Number(req.body.toId);
  const target=db.prepare("SELECT * FROM users WHERE id=? AND role='upstairs'").get(toId);
  const o=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if(!target || !o) return res.status(400).json({error:"الموظف أو الطلب غير موجود"});
  db.prepare("UPDATE orders SET claimant_id=?,claimant_name=?,status='claimed',updated_at=? WHERE id=?").run(target.id,target.name,now(),o.id);
  event(o.id,"transfer",req.user,`إلى ${target.name}`);
  emit("orders_changed",{orderId:o.id});
  res.json({ok:true});
});

app.post("/api/orders/:id/edit",auth,(req,res)=>{
  const o=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if(!o) return res.status(404).json({error:"الطلب غير موجود"});
  const b=req.body;
  const number=cleanUpper(b.number), letter=cleanUpper(b.letter), size=cleanUpper(b.size), color=cleanUpper(b.color);
  const code=[number,letter,size,color].filter(Boolean).join("-");
  db.prepare(`UPDATE orders SET code=?,number=?,letter=?,size=?,color=?,notes=?,updated_at=? WHERE id=?`)
    .run(code,number,letter,size,color,(b.notes||"").trim(),now(),o.id);
  event(o.id,"edited",req.user,code);
  emit("orders_changed",{orderId:o.id});
  res.json({ok:true});
});

app.post("/api/displays",auth,(req,res)=>{
  const b=req.body;
  let source=null;
  if(b.orderId) source=db.prepare("SELECT * FROM orders WHERE id=?").get(b.orderId);
  const number=cleanUpper(b.number ?? source?.number);
  const letter=cleanUpper(b.letter ?? source?.letter);
  const size=cleanUpper(b.size ?? source?.size);
  const color=cleanUpper(b.color ?? source?.color);
  if(!number && !letter && !size && !color) return res.status(400).json({error:"بيانات العرض ناقصة"});
  const dup=db.prepare(`SELECT * FROM display_items WHERE status IN ('requested','waiting') AND COALESCE(number,'')=? AND COALESCE(letter,'')=? AND COALESCE(size,'')=? AND COALESCE(color,'')=?`)
    .get(number,letter,size,color);
  if(dup) return res.status(409).json({error:`الموظف ${dup.created_by} أضاف هذا العرض بالفعل`});
  const t=now();
  const info=db.prepare(`INSERT INTO display_items(order_id,number,letter,size,color,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'requested',?,?,?)`)
    .run(b.orderId||null,number,letter,size,color,req.user.name,t,t);
  if(b.orderId) event(b.orderId,"display_requested",req.user,`${number}-${letter}-${size}-${color}`);
  emit("displays_changed",{displayId:info.lastInsertRowid});
  res.json({ok:true,id:info.lastInsertRowid});
});

app.post("/api/displays/:id/status",auth,(req,res)=>{
  const s=req.body.status;
  const d=db.prepare("SELECT * FROM display_items WHERE id=?").get(req.params.id);
  if(!d) return res.status(404).json({error:"العرض غير موجود"});
  if(!["requested","waiting","displayed","ended","cancelled"].includes(s)) return res.status(400).json({error:"الحالة غير صحيحة"});
  const vals=[s,now(),d.id];
  let sql=`UPDATE display_items SET status=?,updated_at=?`;
  if(s==="displayed") sql+=`,completed_by='${String(req.user.name).replace(/'/g,"''")}'`;
  if(s==="ended") sql+=`,ended_by='${String(req.user.name).replace(/'/g,"''")}'`;
  sql+=` WHERE id=?`;
  db.prepare(sql).run(...vals);
  emit("displays_changed",{displayId:d.id});
  res.json({ok:true});
});

app.post("/api/special",auth,upload.single("audio"),(req,res)=>{
  const text=(req.body.text||"").trim();
  const file=req.file?.filename||null;
  if(!text && !file) return res.status(400).json({error:"اكتب أو سجل رسالة"});
  db.prepare("INSERT INTO special_requests(sender_name,text,audio_file,created_at) VALUES(?,?,?,?)").run(req.user.name,text,file,now());
  emit("special_changed",{});
  res.json({ok:true});
});

app.post("/api/summons",auth,(req,res)=>{
  const location=cleanUpper(req.body.location||"غير محدد");
  const detail=(req.body.detail||"").trim();
  const t=now();
  db.prepare("INSERT INTO summons(caller_name,location,detail,created_at) VALUES(?,?,?,?)").run(req.user.name,location,detail,t);
  emit("summons_changed",{});
  res.json({ok:true});
});

app.post("/api/summons/:id/respond",auth,(req,res)=>{
  const response=req.body.response||"حاضر";
  db.prepare("UPDATE summons SET response=?,status='answered' WHERE id=?").run(response,req.params.id);
  emit("summons_changed",{});
  res.json({ok:true});
});

app.post("/api/users/:id/status",auth,(req,res)=>{
  if(req.user.role!=="supervisor" && Number(req.params.id)!==req.user.id) return res.status(403).json({error:"غير مسموح"});
  db.prepare("UPDATE users SET status=? WHERE id=?").run(req.body.status,req.params.id);
  emit("users_changed",{});
  res.json({ok:true});
});

app.post("/api/users/:id/permissions",auth,(req,res)=>{
  if(req.user.role!=="supervisor") return res.status(403).json({error:"للمشرف فقط"});
  db.prepare("UPDATE users SET can_send=?,can_receive=? WHERE id=?").run(req.body.canSend?1:0,req.body.canReceive?1:0,req.params.id);
  emit("users_changed",{});
  res.json({ok:true});
});

app.post("/api/settings",auth,(req,res)=>{
  if(req.user.role!=="supervisor") return res.status(403).json({error:"للمشرف فقط"});
  const allowed=["prep_limit","display_alert_seconds","display_alert_enabled","audio_retention_days"];
  const st=db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for(const k of allowed) if(req.body[k]!==undefined) st.run(k,String(req.body[k]));
  res.json({ok:true});
});

app.delete("/api/history",auth,(req,res)=>{
  if(req.user.role!=="supervisor") return res.status(403).json({error:"حذف السجل للمشرف فقط"});
  db.prepare("DELETE FROM events").run();
  db.prepare("DELETE FROM audio").run();
  db.prepare("DELETE FROM orders").run();
  db.prepare("DELETE FROM display_items").run();
  res.json({ok:true});
});

app.get("/api/order/:id",auth,(req,res)=>{
  const order=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  const events=db.prepare("SELECT * FROM events WHERE order_id=? ORDER BY id").all(req.params.id);
  const audio=db.prepare("SELECT * FROM audio WHERE order_id=? ORDER BY id DESC").all(req.params.id);
  res.json({order,events,audio});
});

app.get("/events",(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.write("data: connected\\n\\n");
  const timer=setInterval(()=>res.write("data: ping\\n\\n"),25000);
  req.on("close",()=>clearInterval(timer));
});

// auto 30-second unconfirmed after prepared
setInterval(()=>{
  const cutoff=new Date(Date.now()-30000).toISOString();
  const rows=db.prepare(`SELECT * FROM orders WHERE status='prepared' AND prepared_at<?`).all(cutoff);
  for(const o of rows){
    db.prepare("UPDATE orders SET status='unconfirmed',updated_at=? WHERE id=?").run(now(),o.id);
    event(o.id,"unconfirmed",null,"لم يتم تأكيد الاستلام خلال 30 ثانية");
    emit("orders_changed",{orderId:o.id});
  }
},5000);

// cleanup audio according to setting
setInterval(()=>{
  const days=Number(setting("audio_retention_days")||60);
  const cutoff=Date.now()-days*86400000;
  const rows=db.prepare("SELECT * FROM audio").all();
  for(const a of rows){
    if(new Date(a.created_at).getTime()<cutoff){
      try{fs.unlinkSync(path.join(AUDIO_DIR,a.file_name));}catch{}
      db.prepare("DELETE FROM audio WHERE id=?").run(a.id);
    }
  }
},3600000);

const wss=new WebSocketServer({server,path:"/ws"});
const sockets=new Map();
wss.on("connection",(ws)=>{
  let me=null;
  ws.on("message",(raw)=>{
    try{
      const m=JSON.parse(raw.toString());
      if(m.type==="identify"){ me=m.user; sockets.set(me.id,ws); }
      if(m.type==="call"){
        const target=sockets.get(Number(m.to));
        if(target?.readyState===1) target.send(JSON.stringify({type:"incoming_call",from:me,offer:m.offer,callId:m.callId}));
      }
      if(m.type==="answer"){
        const target=sockets.get(Number(m.to));
        if(target?.readyState===1) target.send(JSON.stringify({type:"call_answer",from:me,answer:m.answer,callId:m.callId}));
      }
      if(m.type==="ice"){
        const target=sockets.get(Number(m.to));
        if(target?.readyState===1) target.send(JSON.stringify({type:"ice",from:me,candidate:m.candidate,callId:m.callId}));
      }
      if(m.type==="hangup"){
        const target=sockets.get(Number(m.to));
        if(target?.readyState===1) target.send(JSON.stringify({type:"hangup",from:me,callId:m.callId}));
      }
    }catch{}
  });
  ws.on("close",()=>{if(me) sockets.delete(me.id)});
});

server.listen(PORT,()=>console.log(`Warehouse app running on ${PORT}`));
