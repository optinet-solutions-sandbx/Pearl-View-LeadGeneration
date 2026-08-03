/**
 * booking-page.js — the public client rebooking page, served by THIS service
 * (Cloud Run) so it lives on a separate domain from the dashboard and never
 * exposes the CRM URL. Self-contained HTML + inline JS. Same-origin calls to
 * /book-info (bootstrap) and /book (confirm).
 */
const { BRAND_NAME } = require('./config');

function bookingPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Book your next clean — ${BRAND_NAME}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:#f6f7fb; display:flex; align-items:center; justify-content:center; padding:20px; font-family:Arial,Helvetica,sans-serif; color:#222; }
  .card { background:#fff; border-radius:16px; box-shadow:0 8px 40px rgba(0,0,0,0.10); width:100%; max-width:460px; padding:30px 26px; }
  .brand { font-size:20px; font-weight:800; color:#2f3a8f; margin-bottom:4px; }
  h2 { margin:8px 0 4px; font-size:22px; }
  .sub { font-size:15px; color:#555; margin-top:0; }
  .datebox { border-radius:12px; padding:16px; text-align:center; margin:14px 0; background:#f0fdfa; border:1.5px solid #99f6e4; }
  .datebox.taken { background:#fef2f2; border-color:#fecaca; }
  .bigdate { font-size:18px; font-weight:700; color:#0f766e; }
  .datebox.taken .bigdate, .datebox.taken .smalldate { color:#b91c1c; }
  .smalldate { font-size:14px; color:#0f766e; margin-top:2px; }
  .btn { width:100%; padding:14px; background:#0f766e; color:#fff; border:none; border-radius:10px; font-size:16px; font-weight:700; cursor:pointer; font-family:inherit; min-height:50px; }
  .btn:disabled { background:#9ca3af; cursor:not-allowed; }
  .link { width:100%; margin-top:10px; background:none; border:none; color:#0f766e; font-weight:700; font-size:14px; cursor:pointer; font-family:inherit; padding:8px; }
  label { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:#888; margin-bottom:6px; display:block; }
  input { width:100%; padding:12px; font-size:15px; border:1.5px solid #d6d9e0; border-radius:10px; font-family:inherit; }
  .field { margin-bottom:12px; }
  .err { color:#dc2626; font-size:13px; margin-top:10px; text-align:center; }
  .muted { color:#666; font-size:14px; }
  .center { text-align:center; }
  .hidden { display:none; }
</style>
</head>
<body>
<div class="card" id="card"><p class="center muted">Loading your booking…</p></div>
<script>
(function () {
  var card = document.getElementById('card');
  var token = new URLSearchParams(location.search).get('t') || '';
  var state = { name:'', email:'', booked:[], date:'', time:'09:00', manual:false, busy:false, err:'' };

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function todayISO(){ return new Date().toISOString().slice(0,10); }
  function addDays(iso,n){ var p=iso.split('-'); var dt=new Date(Date.UTC(+p[0],+p[1]-1,+p[2])); dt.setUTCDate(dt.getUTCDate()+n); return dt.toISOString().slice(0,10); }
  function pretty(iso){ try { return new Date(iso+'T00:00:00').toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',year:'numeric'}); } catch(e){ return iso; } }
  function isWeekend(iso){ var d=new Date(iso+'T00:00:00Z').getUTCDay(); return d===0||d===6; }
  function unavail(){ if(isWeekend(state.date)) return 'weekend'; if(state.booked.indexOf(state.date)!==-1) return 'full'; return ''; }

  function shell(inner){ card.innerHTML = inner; }
  function renderInfo(title, body){ shell('<div class="brand">${BRAND_NAME}</div><h2 style="margin-top:6px">'+title+'</h2><p class="muted">'+body+'</p>'); }

  function render(){
    var u = unavail(); var t = !!u;
    var badMsg = u==='weekend' ? 'Weekends unavailable — pick a weekday below' : (u==='full' ? 'That day is full — pick another below' : 'at '+esc(state.time));
    var inlineErr = u==='weekend' ? 'We only take bookings on weekdays (Mon–Fri).' : (u==='full' ? 'Sorry, that day is fully booked — please pick another.' : '');
    var dateBox = '<div class="datebox'+(t?' taken':'')+'"><div class="bigdate">'+pretty(state.date)+'</div><div class="smalldate">'+badMsg+'</div></div>';
    // Email field — the calendar invite is sent here. Prefilled from the lead if
    // we have it; the client can confirm/correct so the invite always lands.
    var emailField = '<div class="field"><label>Email for your calendar invite</label><input type="email" id="email" value="'+esc(state.email)+'" placeholder="you@email.com"></div>';
    var body;
    if (!state.manual) {
      body = dateBox
        + emailField
        + '<button class="btn" id="confirm"'+(state.busy||t?' disabled':'')+'>'+(state.busy?'Booking…':'Confirm this date')+'</button>'
        + '<button class="link" id="manual">Choose a different date/time</button>';
    } else {
      body = dateBox
        + '<div class="field"><label>Date (weekdays only)</label><input type="date" id="date" value="'+esc(state.date)+'" min="'+todayISO()+'">'+(inlineErr?'<div class="err" style="text-align:left">'+inlineErr+'</div>':'')+'</div>'
        + '<div class="field"><label>Time</label><input type="time" id="time" value="'+esc(state.time)+'"></div>'
        + emailField
        + '<button class="btn" id="confirm"'+(state.busy||t?' disabled':'')+'>'+(state.busy?'Booking…':'Confirm booking')+'</button>';
    }
    shell('<div class="brand">${BRAND_NAME}</div><h2>Book your next clean</h2><p class="sub">'+(state.name?'Hi '+esc(state.name)+', ':'')+'we suggest your next window clean for:</p>'+body+(state.err?'<div class="err">'+esc(state.err)+'</div>':''));
    var c=document.getElementById('confirm'); if(c) c.onclick=confirmBooking;
    var m=document.getElementById('manual'); if(m) m.onclick=function(){ state.manual=true; render(); };
    var d=document.getElementById('date'); if(d) d.onchange=function(e){ state.date=e.target.value; render(); };
    var ti=document.getElementById('time'); if(ti) ti.onchange=function(e){ state.time=e.target.value; render(); };
    // store email without re-rendering (keeps input focus while typing)
    var em=document.getElementById('email'); if(em) em.oninput=function(e){ state.email=e.target.value; };
  }

  function done(res){
    // Primary action: one-tap "Add to Google Calendar" right here on the confirmation
    // (no email hunting, no accepting an invite, no Google settings). Works for any
    // client. The emailed invite is a secondary backup.
    var gcal = res && res.gcalUrl;
    var addBtn = gcal
      ? '<a href="'+esc(gcal)+'" target="_blank" rel="noopener" class="btn" style="display:block;text-decoration:none;margin-top:16px;">📅 Add to my calendar</a>'
      : '';
    var emailNote = (res && res.inviteSent)
      ? '<p class="muted" style="font-size:13px;margin-top:14px;">We\\'ve also emailed a copy to <strong>'+esc(state.email)+'</strong>.</p>'
      : '';
    shell('<div class="center"><div style="font-size:44px">🧼</div><h2 style="color:#2f3a8f">You\\'re booked in!</h2><p class="muted">Your next clean is set for<br><strong>'+pretty(state.date)+' at '+esc(state.time)+'</strong>.</p><p class="muted" style="font-size:14px;">Tap below to save it to your calendar:</p>'+addBtn+emailNote+'</div>');
  }

  function confirmBooking(){
    var u=unavail(); if(u){ state.err = u==='weekend' ? 'We only take bookings on weekdays (Mon–Fri).' : 'That day is fully booked — please choose another.'; render(); return; }
    var email=(state.email||'').trim();
    if(!email || email.indexOf('@')<1 || email.indexOf('.')<1){ state.err='Please enter your email so we can send your calendar invite.'; render(); return; }
    state.busy=true; state.err=''; render();
    fetch('/book',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ t: token, date: state.date, time: state.time, email: email }) })
      .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, d:d }; }); })
      .then(function(res){ if(!res.ok) throw new Error(res.d.error || 'Booking failed'); done(res.d); })
      .catch(function(e){ state.busy=false; state.err=e.message||'Booking failed — please try again.'; render(); });
  }

  if (!token){ renderInfo('Invalid link','This booking link is invalid. Please use the link in your invoice email.'); return; }
  fetch('/book-info?t='+encodeURIComponent(token))
    .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, d:d }; }); })
    .then(function(res){
      if(!res.ok) throw new Error(res.d.error || 'This booking link is invalid or expired.');
      if(res.d.alreadyBooked){ renderInfo('You\\'re already booked ✅','You\\'ve already got an upcoming clean with us. Need to change it? Just reply to your email and we\\'ll sort it.'); return; }
      state.name = res.d.clientName || '';
      state.email = res.d.email || '';
      state.booked = res.d.bookedDates || [];
      var d = (res.d.suggest && /^\\d{4}-\\d{2}-\\d{2}$/.test(res.d.suggest)) ? res.d.suggest : (function(){ var x=new Date(); x.setMonth(x.getMonth()+3); return x.toISOString().slice(0,10); })();
      var bk = {}; state.booked.forEach(function(x){ bk[x]=1; });
      // nudge the suggested date to the next open WEEKDAY (skip full days + weekends)
      for (var i=0;i<120 && (bk[d]||isWeekend(d));i++){ d = addDays(d,1); }
      state.date = d;
      render();
    })
    .catch(function(e){ renderInfo('Link problem', e.message || 'This booking link is invalid or expired.'); });
})();
</script>
</body>
</html>`;
}

module.exports = { bookingPageHtml };
