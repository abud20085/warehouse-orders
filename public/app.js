
let token=localStorage.getItem("wh_token")||"";
let me=JSON.parse(localStorage.getItem("wh_user")||"null");
let data={orders:[],displays:[],allDisplays:[],users:[],specials:[],summons:[],settings:{}};
let view="home";
let roleChoice=null;
const COLORS=[["BLACK","BLK","black"],["BROWN","BRN","brown"],["COFFEE","COF","coffee"],["GRAY","GRY","gray"],["KHAKI","KHA","khaki"],["NAVY","NVY","navy"],["CAMEL","CML","camel"],["TAN","TAN","tan"],["CREAM","CRM","cream"],["WHITE","WHT","white"],["BLUE","BLU","blue"],["DARK GRAY","DGRY","dgray"],["LIGHT GRAY","LGRY","lgray"],["GREEN","GRN","green"],["OLIVE","OLV","olive"]];
const SIZES=["39","40","41","42","42.5","43","44","45","46","47","48","49","50"];
const LETTERS=["R","S","B","Z"];

function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function toast(msg){document.getElementById("toast").innerHTML=`<div class="toast-msg">${esc(msg)}</div>`;setTimeout(()=>document.getElementById("toast").innerHTML="",2600)}
async function api(url,opts={}){
  opts.headers=opts.headers||{}; if(token) opts.headers.Authorization="Bearer "+token;
  if(opts.body && !(opts.body instanceof FormData)){opts.headers["Content-Type"]="application/json";opts.body=JSON.stringify(opts.body)}
  const r=await fetch(url,opts); const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||"حدث خطأ");
  return j;
}
function chooseRole(r){
  roleChoice=r;
  const f=document.getElementById("loginForm");
  if(r==="supervisor") f.innerHTML=`<div class="field"><label>كلمة المرور</label><input id="loginPass" type="password" inputmode="numeric" placeholder="123456"></div><button onclick="login()">دخول المشرف</button>`;
  else f.innerHTML=`<div class="field"><label>اسم الموظف</label><input id="loginName" placeholder="اكتب اسمك"></div><button onclick="login()">دخول</button>`;
}
async function login(){
  try{
    const body={role:roleChoice};
    if(roleChoice==="supervisor") body.password=document.getElementById("loginPass").value;
    else body.name=document.getElementById("loginName").value;
    const r=await api("/api/login",{method:"POST",body});
    token=r.token;me=r.user;localStorage.setItem("wh_token",token);localStorage.setItem("wh_user",JSON.stringify(me));
    await startApp();
  }catch(e){toast(e.message)}
}
async function startApp(){
  document.getElementById("login").classList.add("hidden");document.getElementById("app").classList.remove("hidden");
  document.getElementById("meName").textContent=me.name;
  document.getElementById("meRole").textContent=me.role==="supervisor"?"المشرف":me.role==="upstairs"?"موظف المستودع (فوق)":"موظف الصالة (تحت)";
  connectEvents(); await refresh(); render();
}
async function refresh(){try{data=await api("/api/bootstrap")}catch(e){logout(true)}}
function connectEvents(){
  const es=new EventSource("/events"); // harmless fallback if old server; websocket handles calls
  es.onerror=()=>{};
  if(window.WebSocket){
    try{
      const ws=new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+"/ws");
      window.callWS=ws;
      ws.onopen=()=>ws.send(JSON.stringify({type:"identify",user:me}));
      ws.onmessage=async e=>{const m=JSON.parse(e.data);if(["orders_changed","displays_changed","special_changed","summons_changed","users_changed"].includes(m.type)){await refresh();render();notify("تحديث جديد");} handleCallSignal(m)};
    }catch{}
  }
}
function notify(msg){try{navigator.vibrate?.([120,80,120]);if(Notification.permission==="granted")new Notification("نظام المستودع",{body:msg})}catch{}}
if("Notification" in window && Notification.permission==="default") Notification.requestPermission().catch(()=>{});

function render(){
  const c=document.getElementById("content"), nav=document.getElementById("nav");
  if(me.role==="downstairs"){
    nav.innerHTML=navBtn("home","🏠 الرئيسية")+navBtn("orders","📋 الطلبات")+navBtn("display","🏷️ العروض")+navBtn("history","🕘 السجل")+navBtn("more","☰ المزيد");
    c.innerHTML=view==="home"?downHome():view==="orders"?downOrders():view==="display"?displayView():view==="history"?historyView():moreView();
  } else if(me.role==="upstairs"){
    nav.innerHTML=navBtn("home","🏠 الرئيسية")+navBtn("orders","📋 الطلبات")+navBtn("display","🏷️ العروض")+navBtn("special","📝 خاص")+navBtn("more","☰ المزيد");
    c.innerHTML=view==="home"?upHome():view==="orders"?upOrders():view==="display"?displayView():view==="special"?specialView():moreView();
  } else {
    nav.innerHTML=navBtn("home","🏠 الرئيسية")+navBtn("orders","📋 الطلبات")+navBtn("display","🏷️ العروض")+navBtn("history","🕘 السجل")+navBtn("more","⚙️ الإدارة");
    c.innerHTML=view==="home"?superHome():view==="orders"?allOrders():view==="display"?displayView():view==="history"?historyView():adminView();
  }
}
function navBtn(v,t){return `<button class="${view===v?'active':''}" onclick="view='${v}';render()">${t}</button>`}

function code(o){return [o.number,o.letter,o.size,o.color].filter(Boolean).join("-")||"بدون كود"}
function statusLabel(s){return ({new:"جديد",claimed:"مستلم",searching:"جاري البحث",needs_reply:"يحتاج رد",prepared:"مجهز",unconfirmed:"غير مؤكد",closed:"مغلق",cancelled:"ملغى",returned:"مرتجع"})[s]||s}
function orderCard(o){
  const canClaim=me.role==="upstairs"&&!o.claimant_id;
  const own=me.id===o.claimant_id;
  return `<div class="order ${o.priority==='urgent'?'urgent':''} ${o.claimant_id?'claimed':''}">
    <div class="order-head"><div><div class="code">${esc(code(o))}</div><div class="meta">🕒 ${new Date(o.created_at).toLocaleString("ar-SA")} · ${esc(o.sender_name||"")}</div></div><span class="status">${statusLabel(o.status)}</span></div>
    ${o.notes?`<div class="alert">📝 ${esc(o.notes)}</div>`:""}
    ${o.claimant_name?`<div class="meta">👤 مستلم: <b>${esc(o.claimant_name)}</b></div>`:""}
    <div class="actions">
      ${canClaim?`<button class="blue" onclick="claim(${o.id})">استلام الطلب</button>`:""}
      ${me.role==="upstairs"&&own?`<button class="purple" onclick="setOrder(${o.id},'searching')">جاري البحث</button><button class="good" onclick="setOrder(${o.id},'prepared')">تم التجهيز</button><button class="secondary" onclick="transferOrder(${o.id})">تحويل</button>`:""}
      ${me.role!=="upstairs"?`<button class="good" onclick="setOrder(${o.id},'closed','تم')">تم</button><button class="warn" onclick="setOrder(${o.id},'returned','ترجيع')">ترجيع</button>`:""}
      <button class="secondary" onclick="editOrder(${o.id})">تعديل</button>
      <button class="secondary" onclick="displayFromOrder(${o.id})">🏷️ عرض</button>
      <button class="secondary" onclick="moreOrder(${o.id})">⋯</button>
    </div>
  </div>`
}
function downHome(){return `<div class="card"><h2>طلب جديد</h2>${orderForm()}</div><div class="section-title"><h2>قيد المتابعة</h2><span class="badge">${data.orders.length}</span></div>${data.orders.map(orderCard).join("")}`}
function orderForm(){
  return `<form onsubmit="sendOrder(event)">
  <div class="grid2"><div class="field"><label>الرقم</label><input id="fNumber" class="big-input" inputmode="numeric" maxlength="3" placeholder="150"></div>
  <div class="field"><label>الحرف</label><div class="grid3">${LETTERS.map(x=>`<button type="button" class="choice" onclick="pick('fLetter','${x}')">${x}</button>`).join("")}</div></div></div>
  <div class="field"><label>الحرف الآخر</label><input id="fLetter" class="big-input" maxlength="3" placeholder="R / S / B / Z"></div>
  <div class="field"><label>المقاس — ضغط مطول يضيف /</label><div class="grid3">${SIZES.map(x=>`<button type="button" class="choice" onpointerdown="holdStart(event,'fSize','${x}')" onpointerup="holdEnd()" onpointerleave="holdEnd()">${x}</button>`).join("")}</div><input id="fSize" class="big-input" placeholder="42/44"></div>
  <div class="field"><label>اللون — ضغط مطول يضيف /</label><div class="grid3">${COLORS.map(x=>`<button type="button" class="color ${x[2]}" onpointerdown="holdStart(event,'fColor','${x[1]}')" onpointerup="holdEnd()" onpointerleave="holdEnd()"><small>${x[0]}</small>${x[1]}</button>`).join("")}</div><input id="fColor" class="big-input" placeholder="BLK/BRN"></div>
  <div class="field"><label>ملاحظات</label><textarea id="fNotes" placeholder="اختياري"></textarea></div>
  <div class="row"><button type="button" class="secondary" onclick="recordAudio('order')">🎙️ تسجيل صوت</button><button type="button" class="danger" onclick="document.getElementById('urgent').value='urgent'">🚨 عاجل</button><input id="urgent" type="hidden" value="normal"></div>
  <button style="width:100%;margin-top:10px;font-size:18px" type="submit">إرسال الطلب ➜</button></form>`
}
let holdTimer;
function holdStart(e,id,val){holdTimer=setTimeout(()=>{document.getElementById(id).value+=(document.getElementById(id).value?"/":"")+val+"/";holdTimer=null},550)}
function holdEnd(){if(holdTimer){clearTimeout(holdTimer);holdTimer=null}}
function pick(id,val){document.getElementById(id).value=val}
async function sendOrder(e){
  e.preventDefault();
  try{
    const r=await api("/api/orders",{method:"POST",body:{number:document.getElementById("fNumber").value,letter:document.getElementById("fLetter").value,size:document.getElementById("fSize").value,color:document.getElementById("fColor").value,notes:document.getElementById("fNotes").value,priority:document.getElementById("urgent").value}});
    toast("تم إرسال الطلب");await refresh();render();
    if(window.pendingAudio) await uploadAudio(r.id);
  }catch(e){toast(e.message)}
}
async function claim(id){try{await api(`/api/orders/${id}/claim`,{method:"POST"});toast("تم استلام الطلب");await refresh();render()}catch(e){toast(e.message)}}
async function setOrder(id,status,reason){try{await api(`/api/orders/${id}/status`,{method:"POST",body:{status,reason}});toast("تم تحديث الطلب");await refresh();render()}catch(e){toast(e.message)}}
function downOrders(){return `<div class="section-title"><h2>كل الطلبات الحالية</h2><span class="badge">${data.orders.length}</span></div>${data.orders.map(orderCard).join("")||empty("لا توجد طلبات")}`}
function upHome(){const prep=data.orders.filter(o=>["claimed","searching"].includes(o.status)).length;return `<div class="kpi"><div class="card"><b>${data.orders.filter(o=>o.status==="new").length}</b>جديد</div><div class="card"><b>${prep}/${data.settings.prepLimit||10}</b>قيد التجهيز</div></div><div class="card"><h2>أحدث الطلبات</h2>${data.orders.slice(0,8).map(orderCard).join("")||empty("لا توجد طلبات")}</div><div class="card"><h2>العروض المطلوبة</h2>${displayList(true)}</div>`}
function upOrders(){return `<div class="section-title"><h2>الطلبات</h2><span class="badge">حد التجهيز ${data.settings.prepLimit||10}</span></div>${data.orders.map(orderCard).join("")||empty("لا توجد طلبات")}`}
function allOrders(){return `<div class="section-title"><h2>إدارة الطلبات</h2></div>${data.orders.map(orderCard).join("")||empty("لا توجد طلبات")}`}
function displayView(){return `<div class="tabs"><button class="active">العروض المطلوبة</button><button onclick="displayHistory()">أخرى</button></div><div class="card"><div class="row"><button onclick="requestAllDisplays()">طلب الكل</button><button class="secondary" onclick="openManualDisplay()">إضافة عرض</button></div></div>${displayList(false)}`}
function displayList(simple){return data.displays.map(d=>`<div class="display-card"><div><div class="display-code">${esc([d.number,d.letter,d.size,d.color].filter(Boolean).join("-"))}</div><div class="meta">${esc(d.created_by)} · ${new Date(d.created_at).toLocaleTimeString("ar-SA")}</div></div><div class="row">${me.role==="upstairs"?`<button class="good" onclick="displayStatus(${d.id},'displayed')">تم</button>`:`<button class="blue" onclick="displayStatus(${d.id},'displayed')">طلب</button>`}<button class="danger" onclick="displayStatus(${d.id},'cancelled')">حذف</button></div></div>`).join("")||empty("لا توجد عروض مطلوبة")}
function displayHistory(){document.getElementById("modalBody").innerHTML=`<div class="modal-title">أخرى — سجل العروض</div>${data.allDisplays.map(d=>`<div class="display-card"><div><b>${esc([d.number,d.letter,d.size,d.color].filter(Boolean).join("-"))}</b><div class="meta">${d.status} · ${new Date(d.created_at).toLocaleString("ar-SA")}</div></div></div>`).join("")||empty("لا يوجد سجل")}<button onclick="closeModal()" class="secondary">إغلاق</button>`;openModal()}
function displayFromOrder(id){const o=data.orders.find(x=>x.id===id);api("/api/displays",{method:"POST",body:{orderId:id}}).then(()=>{toast("أضيف للعرض");refresh().then(render)}).catch(e=>toast(e.message))}
function openManualDisplay(){document.getElementById("modalBody").innerHTML=`<div class="modal-title">إضافة طلب عرض</div><div class="field"><input id="dm" placeholder="150-R-44-BLK"></div><button onclick="manualDisplay()">إضافة</button><button class="secondary" onclick="closeModal()">إلغاء</button>`;openModal()}
async function manualDisplay(){const p=document.getElementById("dm").value.toUpperCase().split("-");try{await api("/api/displays",{method:"POST",body:{number:p[0],letter:p[1],size:p[2],color:p[3]}});closeModal();await refresh();render()}catch(e){toast(e.message)}}
async function displayStatus(id,s){try{await api(`/api/displays/${id}/status`,{method:"POST",body:{status:s}});await refresh();render()}catch(e){toast(e.message)}}
async function requestAllDisplays(){for(const d of data.displays){try{await api(`/api/displays/${d.id}/status`,{method:"POST",body:{status:"displayed"}})}catch{}}await refresh();render();toast("تم طلب العروض الحالية")}
function specialView(){return `<div class="card"><h2>طلب خاص</h2><textarea id="specialText" placeholder="رسالة للمستودع"></textarea><button style="width:100%;margin-top:8px" onclick="sendSpecial()">إرسال</button></div>${data.specials.map(s=>`<div class="card"><b>${esc(s.sender_name)}</b><div>${esc(s.text)}</div><div class="meta">${new Date(s.created_at).toLocaleString("ar-SA")}</div></div>`).join("")}`}
async function sendSpecial(){try{await api("/api/special",{method:"POST",body:{text:document.getElementById("specialText").value}});toast("تم الإرسال");await refresh();render()}catch(e){toast(e.message)}}
function moreView(){return `<div class="card"><h2>استدعاء موظف</h2><div class="grid2">${["الكاشير","البلاستيكات","المكتب","الجسر","ورا اللوحة","مكان آخر"].map(x=>`<button class="choice" onclick="summon('${x}')">${x}</button>`).join("")}</div></div><div class="card"><h2>كيس الرجيع</h2><button class="warn" onclick="returnBag()">🛍️ طلب كيس رجيع</button></div><div class="card"><h2>حالتي</h2><div class="row"><button onclick="setMyStatus('available')">🟢 متاح</button><button class="warn" onclick="setMyStatus('busy')">🟠 مشغول</button><button class="danger" onclick="setMyStatus('away')">🔴 غير متاح</button><button class="secondary" onclick="setMyStatus('break')">🚻 استراحة</button></div></div>`}
async function summon(location){try{await api("/api/summons",{method:"POST",body:{location}});toast("تم الاستدعاء");}catch(e){toast(e.message)}}
async function returnBag(){try{await api("/api/special",{method:"POST",body:{text:"🛍️ كيس الرجيع مطلوب"}});toast("تم طلب كيس الرجيع")}catch(e){toast(e.message)}}
async function setMyStatus(s){try{await api(`/api/users/${me.id}/status`,{method:"POST",body:{status:s}});toast("تم تغيير الحالة")}catch(e){toast(e.message)}}
function historyView(){return `<div class="card"><h2>البحث في السجل</h2><div class="grid2"><input id="hq" placeholder="رقم / موديل / لون / موظف"><select id="hs"><option value="">كل الحالات</option><option value="closed">مغلق</option><option value="returned">مرتجع</option><option value="cancelled">ملغى</option><option value="unconfirmed">غير مؤكد</option></select></div><button style="width:100%;margin-top:8px" onclick="searchHistory()">بحث</button></div><div id="historyResults"></div>`}
async function searchHistory(){try{const r=await api(`/api/history?q=${encodeURIComponent(document.getElementById("hq").value)}&status=${encodeURIComponent(document.getElementById("hs").value)}`);document.getElementById("historyResults").innerHTML=r.orders.map(orderCard).join("")||empty("لا نتائج")}catch(e){toast(e.message)}}
function superHome(){return `<div class="kpi"><div class="card"><b>${data.orders.length}</b>طلبات حالية</div><div class="card"><b>${data.displays.length}</b>عروض مطلوبة</div><div class="card"><b>${data.users.length}</b>موظفين</div><div class="card"><b>${data.orders.filter(o=>o.priority==='urgent').length}</b>عاجل</div></div><div class="card"><h2>حالة الموظفين</h2>${data.users.map(u=>`<div class="display-card"><div><b>${esc(u.name)}</b><div class="meta">${u.role} · ${u.status}</div></div><button onclick="toggleUser(${u.id},${u.can_send},${u.can_receive})">صلاحيات</button></div>`).join("")}</div>`}
function adminView(){return `<div class="card"><h2>إعدادات سريعة</h2><div class="grid2"><div class="field"><label>حد قيد التجهيز</label><input id="setLimit" type="number" value="${data.settings.prepLimit||10}"></div><div class="field"><label>حذف الصوت بعد (يوم)</label><input id="setAudio" type="number" value="${data.settings.audioRetentionDays||60}"></div></div><button onclick="saveSettings()">حفظ</button></div><div class="card"><h2>حذف السجل</h2><button class="danger" onclick="deleteHistory()">حذف السجل بالكامل</button></div><div class="card"><h2>كلمة المشرف</h2><p class="muted">الكلمة الأولية: 123456 — لا تتغير تلقائياً.</p></div>`}
async function saveSettings(){try{await api("/api/settings",{method:"POST",body:{prep_limit:document.getElementById("setLimit").value,audio_retention_days:document.getElementById("setAudio").value}});toast("تم الحفظ");await refresh();render()}catch(e){toast(e.message)}}
async function deleteHistory(){if(!confirm("متأكد؟"))return;try{await api("/api/history",{method:"DELETE"});toast("تم حذف السجل");await refresh();render()}catch(e){toast(e.message)}}
async function toggleUser(id,send,recv){document.getElementById("modalBody").innerHTML=`<div class="modal-title">صلاحيات الموظف</div><button onclick="savePerm(${id},${send?0:1},${recv})">الإرسال: ${send?'مسموح':'موقوف'}</button><button onclick="savePerm(${id},${send},${recv?0:1})">الاستقبال: ${recv?'مسموح':'موقوف'}</button><button class="secondary" onclick="closeModal()">إغلاق</button>`;openModal()}
async function savePerm(id,s,r){try{await api(`/api/users/${id}/permissions`,{method:"POST",body:{canSend:s,canReceive:r}});closeModal();await refresh();render()}catch(e){toast(e.message)}}
async function editOrder(id){const o=data.orders.find(x=>x.id===id);document.getElementById("modalBody").innerHTML=`<div class="modal-title">تعديل الطلب</div><div class="grid2"><input id="em" value="${esc(o.number)}" placeholder="الرقم"><input id="el" value="${esc(o.letter)}" placeholder="الحرف"><input id="es" value="${esc(o.size)}" placeholder="المقاس"><input id="ec" value="${esc(o.color)}" placeholder="اللون"></div><textarea id="en">${esc(o.notes)}</textarea><button onclick="saveEdit(${id})">حفظ</button><button class="secondary" onclick="closeModal()">إلغاء</button>`;openModal()}
async function saveEdit(id){try{await api(`/api/orders/${id}/edit`,{method:"POST",body:{number:em.value,letter:el.value,size:es.value,color:ec.value,notes:en.value}});closeModal();await refresh();render()}catch(e){toast(e.message)}}
async function transferOrder(id){const ups=data.users.filter(u=>u.role==="upstairs"&&u.id!==me.id);document.getElementById("modalBody").innerHTML=`<div class="modal-title">تحويل الطلب</div>${ups.map(u=>`<button style="width:100%;margin:4px 0" onclick="doTransfer(${id},${u.id})">${esc(u.name)}</button>`).join("")}<button class="secondary" onclick="closeModal()">إلغاء</button>`;openModal()}
async function doTransfer(id,to){try{await api(`/api/orders/${id}/transfer`,{method:"POST",body:{toId:to}});closeModal();await refresh();render();toast("تم التحويل")}catch(e){toast(e.message)}}
function moreOrder(id){document.getElementById("modalBody").innerHTML=`<div class="modal-title">خيارات الطلب</div><button onclick="setOrder(${id},'cancelled','إلغاء');closeModal()">إلغاء الطلب</button><button class="secondary" onclick="editOrder(${id})">تعديل الطلب</button><button class="secondary" onclick="closeModal()">إغلاق</button>`;openModal()}
function openStatus(){document.getElementById("modalBody").innerHTML=`<div class="modal-title">حالتك</div><button onclick="setMyStatus('available')">🟢 متاح</button><button onclick="setMyStatus('busy')">🟠 مشغول</button><button onclick="setMyStatus('away')">🔴 غير متاح</button><button onclick="setMyStatus('break')">🚻 استراحة</button><button class="secondary" onclick="closeModal()">إغلاق</button>`;openModal()}
function openCallPicker(){const targets=data.users.filter(u=>u.id!==me.id);document.getElementById("modalBody").innerHTML=`<div class="modal-title">اتصال صوتي</div>${targets.map(u=>`<button style="width:100%;margin:4px 0" onclick="startCall(${u.id})">📞 ${esc(u.name)}</button>`).join("")}<button class="secondary" onclick="closeModal()">إلغاء</button>`;openModal()}
let pc=null,currentCall=null;
async function startCall(to){
  const target=data.users.find(u=>u.id===to); if(!target)return;
  closeModal();
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    pc=new RTCPeerConnection(); stream.getTracks().forEach(t=>pc.addTrack(t,stream));
    pc.onicecandidate=e=>e.candidate&&callWS?.send(JSON.stringify({type:"ice",to, candidate:e.candidate,callId:currentCall}));
    pc.ontrack=e=>{let a=document.getElementById("remoteAudio");if(!a){a=document.createElement("audio");a.id="remoteAudio";a.autoplay=true;document.body.appendChild(a)}a.srcObject=e.streams[0]};
    currentCall=idTokenLocal(); const offer=await pc.createOffer();await pc.setLocalDescription(offer);
    callWS?.send(JSON.stringify({type:"call",to,offer,callId:currentCall}));toast("جاري الاتصال بـ "+target.name);
  }catch(e){toast("لا يمكن تشغيل الميكروفون")}
}
function idTokenLocal(){return Math.random().toString(36).slice(2)+Date.now()}
async function handleCallSignal(m){
  if(m.type==="incoming_call"){
    document.getElementById("modalBody").innerHTML=`<div class="modal-title">📞 اتصال وارد</div><p>من: <b>${esc(m.from.name)}</b></p><button class="good" onclick="answerCall(${m.from.id},${JSON.stringify(m.offer)},'${m.callId}')">قبول</button><button class="danger" onclick="rejectCall(${m.from.id},'${m.callId}')">رفض</button>`;
    openModal();notify("اتصال وارد من "+m.from.name);
  } else if(m.type==="call_answer" && pc){await pc.setRemoteDescription(m.answer)}
  else if(m.type==="ice" && pc){try{await pc.addIceCandidate(m.candidate)}catch{}}
  else if(m.type==="hangup"){pc?.close();pc=null;toast("انتهى الاتصال")}
}
async function answerCall(to,offer,callId){
  closeModal();try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});pc=new RTCPeerConnection();stream.getTracks().forEach(t=>pc.addTrack(t,stream));
    pc.onicecandidate=e=>e.candidate&&callWS?.send(JSON.stringify({type:"ice",to,candidate:e.candidate,callId}));
    pc.ontrack=e=>{let a=document.getElementById("remoteAudio");if(!a){a=document.createElement("audio");a.id="remoteAudio";a.autoplay=true;document.body.appendChild(a)}a.srcObject=e.streams[0]};
    await pc.setRemoteDescription(offer);const ans=await pc.createAnswer();await pc.setLocalDescription(ans);callWS?.send(JSON.stringify({type:"answer",to,answer:ans,callId}));
  }catch{toast("تعذر قبول الاتصال")}
}
function rejectCall(to,callId){closeModal();callWS?.send(JSON.stringify({type:"hangup",to,callId}))}
function openModal(){document.getElementById("modal").showModal()}
function closeModal(){document.getElementById("modal").close()}
function empty(t){return `<div class="card center muted">${t}</div>`}
async function recordAudio(kind){
  if(!navigator.mediaDevices?.getUserMedia)return toast("المتصفح لا يدعم التسجيل");
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});const rec=new MediaRecorder(stream);let chunks=[];
    rec.ondataavailable=e=>chunks.push(e.data);rec.onstop=()=>{stream.getTracks().forEach(t=>t.stop());window.pendingAudio=new Blob(chunks,{type:"audio/webm"});toast("تم تسجيل الصوت — أرسل الطلب لحفظه")};rec.start();toast("يسجل الآن... اضغط موافق للإيقاف");setTimeout(()=>rec.stop(),10000);
  }catch{toast("تعذر الوصول للميكروفون")}
}
async function uploadAudio(id){if(!window.pendingAudio)return;const fd=new FormData();fd.append("audio",window.pendingAudio,"note.webm");try{await api(`/api/orders/${id}/audio`,{method:"POST",body:fd});window.pendingAudio=null}catch(e){toast(e.message)}}
async function logout(force=false){if(!force)try{await api("/api/logout",{method:"POST"})}catch{}localStorage.removeItem("wh_token");localStorage.removeItem("wh_user");location.reload()}
if(token&&me) startApp();
