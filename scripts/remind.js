// scripts/remind.js —— 每日提醒信：產品跟進 / 會員續約 / 生日與日期提醒 / 每月1號生日彙整 / 新促銷
const admin = require('firebase-admin'), nodemailer = require('nodemailer');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
// 手機推播（Firebase Cloud Messaging，免費）。失敗不影響 Email
const push = async (uid, u, title, body) => {
  const tokens = (u && u.fcmTokens) || [];
  if (!tokens.length) return 0;
  try {
    const r = await admin.messaging().sendEachForMulticast({ tokens, data: { title, body, url: process.env.SITE_URL || '' }, webpush: { headers: { Urgency: 'high', TTL: '43200' } } });
    const bad = [];
    r.responses.forEach((x, i) => { if (!x.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test((x.error && x.error.code) || '')) bad.push(tokens[i]); });
    if (bad.length) await db.collection('users').doc(uid).update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...bad) });
    return r.successCount;
  } catch (e) { console.error('推播失敗：' + (e.code || e.message)); return 0; }
};
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
const dn = s => Math.round(Date.parse(s + 'T00:00:00Z') / 864e5);
const addDays = (s, n) => new Date((dn(s) + n) * 864e5).toISOString().slice(0, 10);
const diff = s => dn(s) - dn(today);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = n => n < 0 ? `逾期 ${-n} 天` : n === 0 ? '今天' : `還有 ${n} 天`;
const hourMY = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', hourCycle: 'h23' }).format(new Date());
const MORNING = hourMY < 12; // 09:00 這班才寄 Email（15:00、20:00 只推播）
const memCycle = (m, rn) => { const [y, mo] = m.join.split('-').map(Number), ey = y + 1 + (+rn || 0), F = k => new Date(Date.UTC(ey, mo - 1 + k, 1)).toISOString().slice(0, 10); return { E: new Date(Date.UTC(ey, mo, 0)).toISOString().slice(0, 10), Dl: new Date(Date.UTC(ey, mo - 1 + 7, 0)).toISOString().slice(0, 10), st: [-1, 0, 3, 5, 6].map(F) }; };
const BDAY = { id: 'birthday', label: '顧客生日', type: 'date', on: 1, remOn: 1, yearly: 1, monthly: 1 };

(async () => {
  const [cat, set, fl, us, cs, pr, os] = await Promise.all([
    db.doc('config/catalog').get(), db.doc('config/settings').get(), db.doc('config/fields').get(),
    db.collection('users').where('status', '==', 'approved').get(),
    db.collection('customers').get(), db.collection('promos').get(), db.collection('opps').get()
  ]);
  const cfg = { ahead: 3, renewDays: 365, renewAhead: 30, ...(set.exists ? set.data() : {}) };
  const NM = new Map((cat.exists ? cat.data().nodes || [] : []).map(n => [n.id, n]));
  let F = fl.exists && fl.data().list ? fl.data().list : [];
  if (!fl.exists || (!fl.data().bday && !F.some(f => f.id === 'birthday'))) F = [...F, BDAY];
  F = F.filter(f => f.on && f.remOn && f.type === 'date');
  const users = new Map(us.docs.map(d => [d.id, d.data()]));
  if (process.env.BROADCAST_BODY) {
    let n = 0; for (const [uid, u] of users) n += await push(uid, u, process.env.BROADCAST_TITLE || 'Unfinished跟進系統', process.env.BROADCAST_BODY);
    console.log(`手動推播已送出：${n} 個裝置`); return;
  }
  if (process.env.TEST_PUSH === '1') {
    let n = 0; for (const [uid, u] of users) n += await push(uid, u, 'Unfinished跟進系統', '這是一則測試推播，收到代表手機推播設定成功 🎉');
    console.log(`測試推播已送出：${n} 個裝置`); return;
  }
  const buysOf = c => c.buys || (c.d.items || []).map((i, k) => ({ id: 'm' + k, pid: i.id, name: i.name, qty: i.qty, date: c.base || c.d.purchaseDate, cycle: i.cycle }));
  const sentOf = b => { const h = (b.hist || []).slice(-1)[0]; return h && h.st === 'sent' ? h.at : null; };
  const dueOf = b => { if (b.stop || b.done) return null; const sa = sentOf(b); if (sa) return addDays(sa, 2); if (b.due) return b.due; const y = +(NM.get(b.pid)?.cycle ?? b.cycle); return y > 0 && b.date ? addDays(b.date, y) : null; };
  const underCat = (id, s) => { while (id) { if (s.has(id)) return 1; id = NM.get(id)?.parent; } return 0; };
  const pMatch = (p, c) => { const a = new Set(p.cats || []), b = new Set(p.prods || []), all = !a.size && !b.size; return buysOf(c).some(x => !x.stop && (all || b.has(x.pid) || underCat(x.pid, a))); };
  const occOf = (f, v) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return null; if (!f.yearly) return v; const y = +today.slice(0, 4), a = y + v.slice(4); return diff(a) >= -3 ? a : (y + 1) + v.slice(4); };

  const curPromos = pr.docs.filter(d => d.data().month === today.slice(0, 7));
  const newPromos = pr.docs.filter(d => !d.data().emailed && d.data().month === today.slice(0, 7));
  const mo = today.slice(5, 7), first = today.slice(8) === '01';
  const per = new Map();
  const get = u => per.get(u) || per.set(u, { rows: [], bd: [], promo: [], stk: [], pp: {} }).get(u);

  for (const doc of cs.docs) {
    const c = doc.data(), d = c.d || {}, u = c.ownerUid;
    if (!users.has(u)) continue;
    const BL = buysOf(c).map(b => ({ ...b })), lat = new Map(), auto = [];
    // 已發送跟進：第 2 天提醒更新進度；第 3 天仍未更新 → 自動轉為「再跟進」（7 天後）
    for (const b of BL) { const sa = sentOf(b); if (!sa || b.stop || b.done || diff(addDays(sa, 3)) > 0) continue; const at = addDays(sa, 3); b.st = 'again'; b.at = at; b.due = addDays(sa, 10); b.hist = [...(b.hist || []), { at, st: 'again', n: 7, auto: 1, note: '系統自動：已發送跟進後第 3 天仍未更新進度，轉入再跟進（7 天後）' }]; auto.push(b); }
    if (auto.length && c.buys) await doc.ref.update({ buys: BL });
    for (const b of auto) { const df = diff(b.due); if (df <= cfg.ahead) get(u).rows.push({ n: d.name, t: `產品跟進：${b.name}（系統已自動轉為再跟進）`, df }); }
    BL.forEach(b => { const k = b.pid || b.name; if (b.date && (!lat.has(k) || b.date > lat.get(k))) lat.set(k, b.date); });
    for (const b of BL) {
      if (b.date && lat.get(b.pid || b.name) > b.date) continue; // 已有較新的購買 = 自動判定已回購
      if (auto.includes(b)) continue;
      const date = dueOf(b); if (!date) continue; const df = diff(date);
      if (df <= cfg.ahead) get(u).rows.push({ n: d.name, t: `${sentOf(b) ? '已發送跟進，請更新進度' : '產品跟進'}：${b.name}（${b.date || ''} 購買）`, df });
    }
    if (d.member && d.member.is && d.member.join) {
      // 到期日＝加入月份最後一天（加入後第2年）；到期前1個月、當月、到期後第3/5/6個月提醒；到期後6個月月底為最後續約日
      const mc = memCycle(d.member, d.member.rn);
      if (today <= mc.Dl) {
        const cur = mc.st.filter(x => x <= today).pop();
        if (cur && !(c.renewAt && c.renewAt >= cur) && !(c.renewSkip && c.renewSkip > today))
          get(u).rows.push({ n: d.name, t: `會員續約（到期日 ${mc.E}，最後續約日 ${mc.Dl}）`, df: diff(mc.E) });
      }
    }
    for (const f of F) {
      const o = occOf(f, d[f.id]); if (!o) continue; const df = diff(o);
      if (df <= 0 && (!f.yearly || df === 0) && (c.fSent || {})[f.id] !== o)
        get(u).rows.push({ n: d.name, t: `${f.id === 'birthday' ? '🎂 ' : '🔔 '}${f.label}`, df });
      if (first && MORNING && f.monthly && (d[f.id] || '').slice(5, 7) === mo)
        get(u).bd.push({ n: d.name, day: +d[f.id].slice(8, 10), label: f.id === 'birthday' ? '生日顧客' : f.label + '的顧客' });
    }
    if (first && MORNING) {
      const m = new Map();
      const bids = new Set(buysOf(c).map(b => b.id));
      for (const e of (c.stock || []).filter(e => !e.buyId || bids.has(e.buyId))) { const k = e.pid || e.name, r = m.get(k) || { name: e.name, q: 0 }; r.q += e.type === 'out' ? -e.qty : e.qty; m.set(k, r); }
      const L = [...m.values()].filter(r => r.q > 0).map(r => `${r.name}×${r.q}`);
      if (L.length) get(u).stk.push(`${d.name}：${L.join('、')}`);
    }
    if (MORNING) for (const p of newPromos) if (pMatch(p.data(), c) && !(c.promoSent || {})[p.id]) get(u).promo.push(p.data().title);
    if (MORNING) for (const p of curPromos) if (pMatch(p.data(), c) && !(c.promoSent || {})[p.id] && !((c.promoSkip || {})[p.id] > today)) { const g = get(u), k = p.data().title; g.pp[k] = (g.pp[k] || 0) + 1; }
  }

  for (const doc of os.docs) {
    const o = doc.data(), u = o.ownerUid;
    if (!users.has(u)) continue;
    if (o.skipTo && o.skipTo > today) continue;
    if (o.stage === 'list') get(u).rows.push({ n: o.name, t: '🤝 Opp 待邀約', df: 0 });
    else if (o.stage === 'demo') { const dt = (o.demoAt || '').slice(0, 10); if (dt && diff(dt) <= cfg.ahead) get(u).rows.push({ n: o.name, t: `🤝 展示計劃 ${(o.demoAt || '').replace('T', ' ')}`, df: diff(dt) }); }
    else if (o.stage === 'invite' || o.stage === 'follow') { if (o.due && diff(o.due) <= 0) get(u).rows.push({ n: o.name, t: `🤝 Opp ${o.stage === 'invite' ? '需再邀約（可一鍵發送再邀約講稿）' : '需跟進'}`, df: diff(o.due) }); }
  }
  const tr = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  const td = 'padding:10px;border-bottom:1px solid #e9e2d2';
  let sent = 0, pushed = 0;
  for (const [uid, g] of per) {
    const u = users.get(uid);
    g.rows.sort((a, b) => a.df - b.df);
    const promos = [...new Set(g.promo)];
    if (!g.rows.length && !g.bd.length && !promos.length && !g.stk.length) continue;
    if (!MORNING && !g.rows.length) continue;
    let body = `<p>${esc(u.realName)} 你好：</p>`;
    if (g.bd.length) {
      g.bd.sort((a, b) => a.day - b.day);
      body += `<p><b>🎂 本月${+mo}月${esc(g.bd[0].label)}有</b><br>${g.bd.map(x => `${esc(x.n)}（${+mo}月${x.day}日）`).join('、')}</p>`;
    }
    if (g.rows.length) body += `<p>今天有 <b>${g.rows.length}</b> 項需要跟進：</p><table style="width:100%;border-collapse:collapse;font-size:14px">${g.rows.map(r => `<tr><td style="${td}"><b>${esc(r.n)}</b></td><td style="${td}">${esc(r.t)}</td><td style="${td};color:${r.df < 0 ? '#c0483f' : '#8a6a22'}">${when(r.df)}</td></tr>`).join('')}</table>`;
    if (g.stk.length) body += `<p><b>📦 目前寄存中（每月1號彙整）</b><br>${g.stk.map(esc).join('<br>')}</p>`;
    if (Object.keys(g.pp).length) body += `<p>🎁 本月促銷尚未發送：${Object.entries(g.pp).map(([k, v]) => `${esc(k)}（${v} 位顧客）`).join('、')}</p>`;
    if (promos.length) body += `<p>🎁 新促銷：${promos.map(esc).join('、')}，可到系統「提醒」頁發送給顧客。</p>`;
    const html = `<div style="font-family:'Noto Sans TC',sans-serif;max-width:560px;margin:auto;background:#f6f2ea;padding:24px"><div style="background:#1b2236;color:#e6d3a3;padding:16px 20px;border-radius:12px 12px 0 0;font-size:18px">◆ 顧客跟進提醒</div><div style="background:#fff;padding:20px;border-radius:0 0 12px 12px">${body}<p style="text-align:center;margin-top:22px"><a href="${esc(process.env.SITE_URL)}" style="background:#b08d4a;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none">進入系統跟進</a></p></div></div>`;
    if (MORNING) await tr.sendMail({ from: `Unfinished跟進系統 <${process.env.GMAIL_USER}>`, to: u.email, subject: `【跟進提醒】${g.bd.length ? '本月生日顧客＋' : ''}今天有 ${g.rows.length} 項需要處理`, html });
    if (MORNING) sent++;
    const extra = [promos.length && `${promos.length} 則新促銷`, g.bd.length && '本月有顧客生日'].filter(Boolean);
    pushed += await push(uid, u, 'Unfinished跟進系統', `${u.realName}，${MORNING ? '今天有' : '目前還有'} ${g.rows.length} 項待跟進${extra.length ? '、' + extra.join('、') : ''}，點擊進入系統`);
  }
  if (MORNING) for (const p of newPromos) await p.ref.update({ emailed: true });
  console.log(`完成：已寄出 ${sent} 封 Email、${pushed} 則手機推播`); // 不輸出顧客資料
})().catch(e => { console.error(e.message); process.exit(1); });
