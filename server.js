const express=require('express');
const http=require('http');
const path=require('path');
const fs=require('fs');
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const Database=require('better-sqlite3');
const multer=require('multer');
const {WebSocketServer}=require('ws');

const ROOT=__dirname;
const DATA=path.join(ROOT,'data');

fs.mkdirSync(DATA,{recursive:true});
fs.mkdirSync(path.join(DATA,'audio'),{recursive:true});

const db=new Database(path.join(DATA,'warehouse.db'));
db.pragma('journal_mode=WAL');
db.pragma('foreign_keys=ON');
db.pragma('busy_timeout=5000');
db.pragma('synchronous=NORMAL');

const now=()=>new Date().toISOString();
const id=()=>crypto.randomUUID();
const clean=v=>String(v??'').trim();
const json=v=>{try{return JSON.parse(v)}catch{return null}};

function bind(sql,p){
  if(p===undefined||p===null)return [];
  if(Array.isArray(p))return p;
  if(typeof p!=='object')return p;
  if(sql.includes('?')&&!/[@:$][A-Za-z_][A-Za-z0-9_]*/.test(sql))
    return Object.values(p);
  return p;
}

function q(sql,p){return db.prepare(sql).get(bind(sql,p))}
function all(sql,p){return db.prepare(sql).all(bind(sql,p))}
function run(sql,p){return db.prepare(sql).run(bind(sql,p))}

function column(table,col){
  return db.prepare(`PRAGMA table_info(${table})`).all().some(x=>x.name===col);
}

function add(table,col,type,def=''){
  if(!column(table,col))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type} ${def}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id TEXT PRIMARY KEY,
 username TEXT UNIQUE NOT NULL,
 name TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'operator',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders(
 id TEXT PRIMARY KEY,
 order_no TEXT UNIQUE NOT NULL,
 customer TEXT NOT NULL,
 department TEXT DEFAULT '',
 priority TEXT NOT NULL DEFAULT 'normal',
 status TEXT NOT NULL DEFAULT 'new',
 items_json TEXT NOT NULL DEFAULT '[]',
 notes TEXT DEFAULT '',
 created_by TEXT,
 assigned_to TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 claimed_at TEXT,
 completed_at TEXT,
 check_note TEXT,
 alternative_note TEXT,
 edit_lock_by TEXT,
 edit_lock_at TEXT
);

CREATE TABLE IF NOT EXISTS order_events(
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL,
 event TEXT NOT NULL,
 detail TEXT DEFAULT '',
 user_id TEXT,
 created_at TEXT NOT NULL,
 FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications(
 id TEXT PRIMARY KEY,
 user_id TEXT,
 order_id TEXT,
 type TEXT NOT NULL,
 title TEXT NOT NULL,
 body TEXT DEFAULT '',
 read_at TEXT,
 created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings(
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit(
 id TEXT PRIMARY KEY,
 user_id TEXT,
 action TEXT,
 entity TEXT,
 entity_id TEXT,
 detail TEXT,
 created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS displays(
 id TEXT PRIMARY KEY,
 name TEXT UNIQUE NOT NULL,
 location TEXT DEFAULT '',
 enabled INTEGER NOT NULL DEFAULT 1,
 config_json TEXT NOT NULL DEFAULT '{}',
 last_seen TEXT
);

CREATE TABLE IF NOT EXISTS special_requests(
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 body TEXT DEFAULT '',
 status TEXT NOT NULL DEFAULT 'open',
 created_by TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summons(
 id TEXT PRIMARY KEY,
 user_id TEXT,
 title TEXT NOT NULL,
 body TEXT DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL,
 ack_at TEXT
);

CREATE TABLE IF NOT EXISTS replies(
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL,
 user_id TEXT,
 body TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_audio(
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL,
 user_id TEXT,
 filename TEXT NOT NULL,
 original_name TEXT,
 created_at TEXT NOT NULL,
 FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ui_config(
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
`);

add('orders','check_note','TEXT');
add('orders','alternative_note','TEXT');
add('orders','edit_lock_by','TEXT');
add('orders','edit_lock_at','TEXT');

const defaults={
 app_name:'Warehouse Control',
 company_name:'Warehouse Operations',
 accent:'#2563eb',
 dark_mode:'0',
 compact:'0',
 auto_refresh:'1',
 refresh_seconds:'8',
 items_per_page:'25',
 sound:'1',
 allow_operator_delete:'0',
 require_delete_confirm:'1',
 show_analytics:'1',
 welcome:'لوحة تشغيل المستودع — كل شيء واضح، سريع، وتحت السيطرة.'
};

const seedSettings=db.transaction(()=>{
  for(const [key,value] of Object.entries(defaults)){
    if(!q('SELECT key FROM settings WHERE key=?',{key})){
      run(
        'INSERT INTO settings(key,value,updated_at) VALUES(@key,@value,@updated_at)',
        {key,value,updated_at:now()}
      );
    }
  }
});

seedSettings();

if(!q('SELECT id FROM users LIMIT 1')){
  const t=now();

  const ins=db.prepare(`
    INSERT INTO users(
      id,username,name,password_hash,role,active,created_at,updated_at
    )
    VALUES(
      @id,@username,@name,@password_hash,@role,1,@created_at,@updated_at
    )
  `);

  ins.run({
    id:id(),
    username:'admin',
    name:'المشرف العام',
    password_hash:bcrypt.hashSync('admin123',10),
    role:'supervisor',
    created_at:t,
    updated_at:t
  });

  ins.run({
    id:id(),
    username:'downstairs',
    name:'موظف المستودع',
    password_hash:bcrypt.hashSync('1234',10),
    role:'operator',
    created_at:t,
    updated_at:t
  });

  ins.run({
    id:id(),
    username:'upstairs',
    name:'موظف المكتب',
    password_hash:bcrypt.hashSync('1234',10),
    role:'operator',
    created_at:t,
    updated_at:t
  });
}

const sessions=new Map();
const sockets=new Set();

function user(req){
  const s=sessions.get(req.headers['x-session-token']||'');
  return s?.user||null;
}

function auth(req,res,next){
  const u=user(req);
  if(!u)return res.status(401).json({error:'انتهت الجلسة'});
  req.user=u;
  next();
}

function supervisor(req,res,next){
  if(req.user.role!=='supervisor')
    return res.status(403).json({error:'صلاحية المشرف مطلوبة'});
  next();
}

function audit(u,action,entity,entityId,detail=''){
  run(`
    INSERT INTO audit(
      id,user_id,action,entity,entity_id,detail,created_at
    )
    VALUES(
      @id,@user_id,@action,@entity,@entity_id,@detail,@created_at
    )
  `,{
    id:id(),
    user_id:u?.id||null,
    action,
    entity,
    entity_id:entityId||null,
    detail,
    created_at:now()
  });
}

function event(orderId,eventName,detail,u){
  run(`
    INSERT INTO order_events(
      id,order_id,event,detail,user_id,created_at
    )
    VALUES(
      @id,@order_id,@event,@detail,@user_id,@created_at
    )
  `,{
    id:id(),
    order_id:orderId,
    event:eventName,
    detail,
    user_id:u?.id||null,
    created_at:now()
  });

  broadcast({type:'order',orderId,event:eventName});
}

function notify(userId,title,body,orderId=null,type='info'){
  run(`
    INSERT INTO notifications(
      id,user_id,order_id,type,title,body,created_at
    )
    VALUES(
      @id,@user_id,@order_id,@type,@title,@body,@created_at
    )
  `,{
    id:id(),
    user_id:userId,
    order_id:orderId,
    type,
    title,
    body,
    created_at:now()
  });

  broadcast({type:'notification',userId});
}

function broadcast(msg){
  const s=JSON.stringify(msg);

  for(const ws of sockets){
    if(ws.readyState===1)ws.send(s);
  }
}

function settings(){
  return Object.fromEntries(
    all('SELECT key,value FROM settings').map(x=>[x.key,x.value])
  );
}

const app=express();

app.disable('x-powered-by');

app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true}));

app.use('/audio',express.static(path.join(DATA,'audio')));

app.get('/api/health',(req,res)=>{
  res.json({ok:true,time:now()});
});

app.post('/api/login',(req,res)=>{
  const username=clean(req.body.username);
  const password=String(req.body.password||'');

  const u=q(
    'SELECT * FROM users WHERE username=? AND active=1',
    {username}
  );

  if(!u||!bcrypt.compareSync(password,u.password_hash)){
    return res.status(401).json({
      error:'اسم المستخدم أو كلمة المرور غير صحيحة'
    });
  }

  const token=crypto.randomBytes(32).toString('hex');

  sessions.set(token,{
    user:{
      id:u.id,
      username:u.username,
      name:u.name,
      role:u.role
    },
    at:Date.now()
  });

  audit(u,'login','session',null);

  res.json({
    token,
    user:{
      id:u.id,
      username:u.username,
      name:u.name,
      role:u.role
    }
  });
});

app.post('/api/logout',auth,(req,res)=>{
  for(const [k,v] of sessions){
    if(v.user.id===req.user.id)sessions.delete(k);
  }

  audit(req.user,'logout','session',null);

  res.json({ok:true});
});

app.get('/api/bootstrap',auth,(req,res)=>{
  const s=settings();

  const stats=all(`
    SELECT status,COUNT(*) count
    FROM orders
    GROUP BY status
  `);

  res.json({
    user:req.user,
    settings:s,
    stats:Object.fromEntries(stats.map(x=>[x.status,x.count])),
    unread:q(`
      SELECT COUNT(*) c
      FROM notifications
      WHERE (user_id IS NULL OR user_id=?)
      AND read_at IS NULL
    `,{user_id:req.user.id}).c
  });
});

app.get('/api/orders',auth,(req,res)=>{
  const search=clean(req.query.search);
  const status=clean(req.query.status);
  const priority=clean(req.query.priority);

  let sql=`
    SELECT
      o.*,
      u.name assigned_name,
      c.name creator_name,
      (
        SELECT COUNT(*)
        FROM replies r
        WHERE r.order_id=o.id
      ) replies_count
    FROM orders o
    LEFT JOIN users u ON u.id=o.assigned_to
    LEFT JOIN users c ON c.id=o.created_by
    WHERE 1=1
  `;

  const p={};

  if(search){
    sql+=`
      AND (
        o.order_no LIKE @s
        OR o.customer LIKE @s
        OR o.department LIKE @s
        OR o.notes LIKE @s
      )
    `;
    p.s='%'+search+'%';
  }

  if(status){
    sql+=' AND o.status=@status';
    p.status=status;
  }

  if(priority){
    sql+=' AND o.priority=@priority';
    p.priority=priority;
  }

  sql+=`
    ORDER BY
      CASE o.priority
        WHEN "urgent" THEN 0
        WHEN "high" THEN 1
        ELSE 2
      END,
      o.created_at DESC
    LIMIT 500
  `;

  const rows=all(sql,p).map(o=>({
    ...o,
    items:json(o.items_json)||[]
  }));

  res.json({orders:rows});
});

app.get('/api/orders/:id',auth,(req,res)=>{
  const o=q(`
    SELECT
      o.*,
      u.name assigned_name,
      c.name creator_name
    FROM orders o
    LEFT JOIN users u ON u.id=o.assigned_to
    LEFT JOIN users c ON c.id=o.created_by
    WHERE o.id=?
  `,{id:req.params.id});

  if(!o)
    return res.status(404).json({error:'الطلب غير موجود'});

  o.items=json(o.items_json)||[];

  o.events=all(`
    SELECT e.*,u.name user_name
    FROM order_events e
    LEFT JOIN users u ON u.id=e.user_id
    WHERE order_id=?
    ORDER BY created_at DESC
  `,{order_id:o.id});

  o.replies=all(`
    SELECT r.*,u.name user_name
    FROM replies r
    LEFT JOIN users u ON u.id=r.user_id
    WHERE order_id=?
    ORDER BY created_at
  `,{order_id:o.id});

  o.audio=all(`
    SELECT *
    FROM order_audio
    WHERE order_id=?
    ORDER BY created_at DESC
  `,{order_id:o.id});

  res.json({order:o});
});

const createOrder=db.transaction((body,u)=>{
  const oid=id();
  const t=now();

  const no=clean(body.order_no)||
    `WO-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${String(Math.floor(Math.random()*9999)).padStart(4,'0')}`;

  const items=Array.isArray(body.items)
    ?body.items.map(x=>({
      name:clean(x.name),
      qty:Number(x.qty)||1,
      unit:clean(x.unit)||'قطعة'
    })).filter(x=>x.name)
    :[];

  if(!clean(body.customer))
    throw Error('اسم العميل مطلوب');

  if(!items.length)
    throw Error('أضف صنفاً واحداً على الأقل');

  run(`
    INSERT INTO orders(
      id,order_no,customer,department,priority,status,
      items_json,notes,created_by,created_at,updated_at
    )
    VALUES(
      @id,@order_no,@customer,@department,@priority,'new',
      @items_json,@notes,@created_by,@created_at,@updated_at
    )
  `,{
    id:oid,
    order_no:no,
    customer:clean(body.customer),
    department:clean(body.department),
    priority:['normal','high','urgent'].includes(body.priority)
      ?body.priority:'normal',
    items_json:JSON.stringify(items),
    notes:clean(body.notes),
    created_by:u.id,
    created_at:t,
    updated_at:t
  });

  event(oid,'created',`تم إنشاء الطلب ${no}`,u);
  audit(u,'create','order',oid,no);

  return oid;
});

app.post('/api/orders',auth,(req,res)=>{
  try{
    const oid=createOrder(req.body,req.user);
    res.json({ok:true,id:oid});
  }catch(e){
    res.status(400).json({error:e.message});
  }
});

app.patch('/api/orders/:id',auth,(req,res)=>{
  const o=q(
    'SELECT * FROM orders WHERE id=?',
    {id:req.params.id}
  );

  if(!o)
    return res.status(404).json({error:'الطلب غير موجود'});

  if(
    req.user.role!=='supervisor' &&
    o.created_by!==req.user.id &&
    o.assigned_to!==req.user.id
  ){
    return res.status(403).json({
      error:'لا تملك صلاحية تعديل هذا الطلب'
    });
  }

  const fields=[];
  const p={
    id:o.id,
    updated_at:now()
  };

  for(const k of ['customer','department','notes']){
    if(req.body[k]!==undefined){
      fields.push(`${k}=@${k}`);
      p[k]=clean(req.body[k]);
    }
  }

  if(
    req.body.priority &&
    ['normal','high','urgent'].includes(req.body.priority)
  ){
    fields.push('priority=@priority');
    p.priority=req.body.priority;
  }

  if(Array.isArray(req.body.items)){
    fields.push('items_json=@items_json');
    p.items_json=JSON.stringify(req.body.items);
  }

  if(!fields.length)
    return res.json({ok:true});

  run(`
    UPDATE orders
    SET ${fields.join(',')},updated_at=@updated_at
    WHERE id=@id
  `,p);

  event(o.id,'edited','تم تعديل بيانات الطلب',req.user);
  audit(req.user,'edit','order',o.id);

  res.json({ok:true});
});

app.post('/api/orders/:id/claim',auth,(req,res)=>{
  const o=q(
    'SELECT * FROM orders WHERE id=?',
    {id:req.params.id}
  );

  if(!o)
    return res.status(404).json({error:'الطلب غير موجود'});

  run(`
    UPDATE orders
    SET
      assigned_to=@u,
      status=CASE
        WHEN status='new' THEN 'processing'
        ELSE status
      END,
      claimed_at=@t,
      updated_at=@t
    WHERE id=@id
  `,{
    u:req.user.id,
    t:now(),
    id:o.id
  });

  event(o.id,'claimed',`استلم الطلب ${req.user.name}`,req.user);
  audit(req.user,'claim','order',o.id);

  res.json({ok:true});
});

app.post('/api/orders/:id/status',auth,(req,res)=>{
  const allowed=[
    'new',
    'processing',
    'checking',
    'waiting',
    'completed',
    'cancelled'
  ];

  const st=clean(req.body.status);

  if(!allowed.includes(st))
    return res.status(400).json({error:'حالة غير صالحة'});

  const o=q(
    'SELECT * FROM orders WHERE id=?',
    {id:req.params.id}
  );

  if(!o)
    return res.status(404).json({error:'الطلب غير موجود'});

  const t=now();

  run(`
    UPDATE orders
    SET
      status=@status,
      updated_at=@t,
      completed_at=CASE
        WHEN @status="completed" THEN @t
        ELSE completed_at
      END
    WHERE id=@id
  `,{
    status:st,
    t,
    id:o.id
  });

  event(o.id,'status',`تغيرت الحالة إلى ${st}`,req.user);
  audit(req.user,'status','order',o.id,st);

  res.json({ok:true});
});

app.delete('/api/orders/:id',auth,(req,res)=>{
  const o=q(
    'SELECT * FROM orders WHERE id=?',
    {id:req.params.id}
  );

  if(!o)
    return res.status(404).json({error:'الطلب غير موجود'});

  const s=settings();

  if(
    req.user.role!=='supervisor' &&
    s.allow_operator_delete!=='1'
  ){
    return res.status(403).json({
      error:'الحذف متاح للمشرف فقط'
    });
  }

  db.transaction(()=>{
    all(
      'SELECT filename FROM order_audio WHERE order_id=?',
      {order_id:o.id}
    ).forEach(a=>{
      try{
        fs.unlinkSync(path.join(DATA,'audio',a.filename));
      }catch{}
    });

    run(
      'DELETE FROM orders WHERE id=?',
      {id:o.id}
    );
  })();

  audit(req.user,'delete','order',o.id,o.order_no);
  broadcast({type:'order_deleted',orderId:o.id});

  res.json({ok:true});
});

app.post('/api/orders/:id/reply',auth,(req,res)=>{
  const body=clean(req.body.body);

  if(!body)
    return res.status(400).json({error:'الرد فارغ'});

  run(`
    INSERT INTO replies(
      id,order_id,user_id,body,created_at
    )
    VALUES(
      @id,@order_id,@user_id,@body,@created_at
    )
  `,{
    id:id(),
    order_id:req.params.id,
    user_id:req.user.id,
    body,
    created_at:now()
  });

  event(req.params.id,'reply','تمت إضافة رد',req.user);

  res.json({ok:true});
});

app.get('/api/notifications',auth,(req,res)=>{
  res.json({
    notifications:all(`
      SELECT *
      FROM notifications
      WHERE user_id IS NULL OR user_id=?
      ORDER BY created_at DESC
      LIMIT 100
    `,{user_id:req.user.id})
  });
});

app.post('/api/notifications/read',auth,(req,res)=>{
  if(req.body.all){
    run(`
      UPDATE notifications
      SET read_at=?
      WHERE (user_id IS NULL OR user_id=?)
      AND read_at IS NULL
    `,{
      0:now(),
      1:req.user.id
    });
  }else{
    run(`
      UPDATE notifications
      SET read_at=?
      WHERE id=?
      AND (user_id IS NULL OR user_id=?)
    `,{
      0:now(),
      1:req.body.id,
      2:req.user.id
    });
  }

  res.json({ok:true});
});

app.get('/api/users',auth,supervisor,(req,res)=>{
  res.json({
    users:all(`
      SELECT
        id,username,name,role,active,created_at,updated_at
      FROM users
      ORDER BY name
    `)
  });
});

app.post('/api/users',auth,supervisor,(req,res)=>{
  const t=now();

  const u={
    id:id(),
    username:clean(req.body.username),
    name:clean(req.body.name),
    password_hash:bcrypt.hashSync(
      String(req.body.password||'1234'),10
    ),
    role:req.body.role==='supervisor'
      ?'supervisor'
      :'operator',
    created_at:t,
    updated_at:t
  };

  if(!u.username||!u.name)
    return res.status(400).json({
      error:'الاسم واسم المستخدم مطلوبان'
    });

  try{
    run(`
      INSERT INTO users(
        id,username,name,password_hash,role,
        active,created_at,updated_at
      )
      VALUES(
        @id,@username,@name,@password_hash,@role,
        1,@created_at,@updated_at
      )
    `,u);

    audit(req.user,'create','user',u.id,u.username);
    res.json({ok:true});
  }catch(e){
    res.status(400).json({
      error:'اسم المستخدم مستخدم بالفعل'
    });
  }
});

app.patch('/api/users/:id',auth,supervisor,(req,res)=>{
  const fields=[];
  const p={
    id:req.params.id,
    updated_at:now()
  };

  for(const k of ['name','role','active']){
    if(req.body[k]!==undefined){
      fields.push(`${k}=@${k}`);
      p[k]=k==='active'
        ?(req.body[k]?1:0)
        :req.body[k];
    }
  }

  if(req.body.password){
    fields.push('password_hash=@password_hash');
    p.password_hash=bcrypt.hashSync(
      String(req.body.password),10
    );
  }

  if(fields.length){
    run(`
      UPDATE users
      SET ${fields.join(',')},updated_at=@updated_at
      WHERE id=@id
    `,p);
  }

  res.json({ok:true});
});

app.delete('/api/users/:id',auth,supervisor,(req,res)=>{
  if(req.params.id===req.user.id)
    return res.status(400).json({
      error:'لا يمكن حذف حسابك الحالي'
    });

  run(
    'DELETE FROM users WHERE id=?',
    {id:req.params.id}
  );

  res.json({ok:true});
});

app.get('/api/settings',auth,supervisor,(req,res)=>{
  res.json({settings:settings()});
});

app.patch('/api/settings',auth,supervisor,(req,res)=>{
  const entries=req.body||{};

  for(const [key,value] of Object.entries(entries)){
    if(!/^[a-zA-Z0-9_]+$/.test(key))continue;

    run(`
      INSERT INTO settings(key,value,updated_at)
      VALUES(@key,@value,@t)
      ON CONFLICT(key)
      DO UPDATE SET
        value=excluded.value,
        updated_at=excluded.updated_at
    `,{
      key,
      value:String(value),
      t:now()
    });
  }

  audit(req.user,'settings','settings');
  broadcast({type:'settings'});

  res.json({
    ok:true,
    settings:settings()
  });
});

app.post('/api/settings/password',auth,(req,res)=>{
  const old=String(req.body.old_password||'');
  const nw=String(req.body.new_password||'');

  const u=q(
    'SELECT * FROM users WHERE id=?',
    {id:req.user.id}
  );

  if(!bcrypt.compareSync(old,u.password_hash))
    return res.status(400).json({
      error:'كلمة المرور الحالية غير صحيحة'
    });

  if(nw.length<4)
    return res.status(400).json({
      error:'كلمة المرور الجديدة قصيرة'
    });

  run(`
    UPDATE users
    SET password_hash=?,updated_at=?
    WHERE id=?
  `,{
    0:bcrypt.hashSync(nw,10),
    1:now(),
    2:u.id
  });

  res.json({ok:true});
});

app.get('/api/analytics',auth,(req,res)=>{
  const totals=q(`
    SELECT
      COUNT(*) total,
      SUM(status="completed") completed,
      SUM(status="new") new,
      SUM(status="processing") processing,
      SUM(status="urgent") urgent
    FROM orders
  `)||{};

  const byDay=all(`
    SELECT
      substr(created_at,1,10) day,
      COUNT(*) count
    FROM orders
    WHERE created_at>=datetime('now','-14 days')
    GROUP BY day
    ORDER BY day
  `);

  const byUser=all(`
    SELECT
      COALESCE(u.name,'غير مسند') name,
      COUNT(*) count
    FROM orders o
    LEFT JOIN users u ON u.id=o.assigned_to
    GROUP BY o.assigned_to
    ORDER BY count DESC
    LIMIT 10
  `);

  res.json({
    totals,
    byDay,
    byUser
  });
});

app.get('/api/audit',auth,supervisor,(req,res)=>{
  res.json({
    audit:all(`
      SELECT
        a.*,
        u.name user_name
      FROM audit a
      LEFT JOIN users u ON u.id=a.user_id
      ORDER BY a.created_at DESC
      LIMIT 500
    `)
  });
});

app.get('/api/events/:id',auth,(req,res)=>{
  res.json({
    events:all(`
      SELECT
        e.*,
        u.name user_name
      FROM order_events e
      LEFT JOIN users u ON u.id=e.user_id
      WHERE order_id=?
      ORDER BY created_at DESC
    `,{
      order_id:req.params.id
    })
  });
});

app.get('/api/special',auth,(req,res)=>{
  res.json({
    requests:all(`
      SELECT
        s.*,
        u.name creator_name
      FROM special_requests s
      LEFT JOIN users u ON u.id=s.created_by
      ORDER BY s.created_at DESC
    `)
  });
});

app.post('/api/special',auth,(req,res)=>{
  const t=now();

  run(`
    INSERT INTO special_requests(
      id,title,body,status,created_by,created_at,updated_at
    )
    VALUES(
      @id,@title,@body,"open",
      @created_by,@created_at,@updated_at
    )
  `,{
    id:id(),
    title:clean(req.body.title)||'طلب خاص',
    body:clean(req.body.body),
    created_by:req.user.id,
    created_at:t,
    updated_at:t
  });

  broadcast({type:'special'});

  res.json({ok:true});
});

app.patch('/api/special/:id',auth,(req,res)=>{
  run(`
    UPDATE special_requests
    SET status=?,updated_at=?
    WHERE id=?
  `,{
    0:req.body.status,
    1:now(),
    2:req.params.id
  });

  res.json({ok:true});
});

app.get('/api/summons',auth,(req,res)=>{
  res.json({
    summons:all(`
      SELECT
        s.*,
        u.name user_name
      FROM summons s
      LEFT JOIN users u ON u.id=s.user_id
      WHERE s.user_id IS NULL OR s.user_id=?
      ORDER BY created_at DESC
      LIMIT 100
    `,{
      user_id:req.user.id
    })
  });
});

app.post('/api/summons',auth,supervisor,(req,res)=>{
  const sid=req.body.user_id||null;

  run(`
    INSERT INTO summons(
      id,user_id,title,body,created_at
    )
    VALUES(
      @id,@user_id,@title,@body,@created_at
    )
  `,{
    id:id(),
    user_id:sid,
    title:clean(req.body.title)||'استدعاء',
    body:clean(req.body.body),
    created_at:now()
  });

  if(sid)
    notify(
      sid,
      'استدعاء جديد',
      clean(req.body.body)
    );

  broadcast({type:'summon'});

  res.json({ok:true});
});

app.post('/api/summons/:id/ack',auth,(req,res)=>{
  run(`
    UPDATE summons
    SET status="acknowledged",ack_at=?
    WHERE id=?
    AND (user_id=? OR user_id IS NULL)
  `,{
    0:now(),
    1:req.params.id,
    2:req.user.id
  });

  res.json({ok:true});
});

const upload=multer({
  dest:path.join(DATA,'audio'),
  limits:{
    fileSize:10*1024*1024
  }
});

app.post(
  '/api/orders/:id/audio',
  auth,
  upload.single('audio'),
  (req,res)=>{
    if(!req.file)
      return res.status(400).json({
        error:'لم يتم رفع ملف'
      });

    run(`
      INSERT INTO order_audio(
        id,order_id,user_id,filename,original_name,created_at
      )
      VALUES(
        @id,@order_id,@user_id,
        @filename,@original_name,@created_at
      )
    `,{
      id:id(),
      order_id:req.params.id,
      user_id:req.user.id,
      filename:req.file.filename,
      original_name:req.file.originalname,
      created_at:now()
    });

    res.json({ok:true});
  }
);

app.use(express.static(path.join(ROOT,'public')));

/*
  IMPORTANT:
  Express 5 لا يقبل app.get('*', ...)
  لذلك نستخدم Regex route للفallback.
*/
app.get(/.*/,(req,res)=>{
  res.sendFile(path.join(ROOT,'public','index.html'));
});

const server=http.createServer(app);

const wss=new WebSocketServer({
  server,
  path:'/ws'
});

wss.on('connection',ws=>{
  sockets.add(ws);

  ws.on('message',buf=>{
    const m=json(buf.toString());
    if(!m)return;

    if(m.type==='ping'){
      return ws.send(
        JSON.stringify({type:'pong'})
      );
    }

    if(
      ['call','offer','answer','ice','hangup']
      .includes(m.type)
    ){
      broadcast({
        ...m,
        from:m.from||null
      });
    }
  });

  ws.on('close',()=>{
    sockets.delete(ws);
  });

  ws.send(
    JSON.stringify({type:'connected'})
  );
});

setInterval(()=>{
  const cutoff=Date.now()-1000*60*60*24;

  for(const [k,v] of sessions){
    if(v.at<cutoff)
      sessions.delete(k);
  }
},60*60*1000);

const PORT=Number(process.env.PORT||10000);
const HOST='0.0.0.0';

server.keepAliveTimeout=120000;
server.headersTimeout=125000;

server.listen(PORT,HOST,()=>{
  console.log(
    `Warehouse Control listening on ${HOST}:${PORT}`
  );
});

process.on('SIGTERM',()=>{
  server.close(()=>{
    db.close();
  });
});

process.on('SIGINT',()=>{
  server.close(()=>{
    db.close();
  });
});
