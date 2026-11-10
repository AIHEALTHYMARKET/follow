const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
const month = today.slice(0, 7);
const dn = s => Math.round(Date.parse(s + 'T00:00:00Z') / 864e5);
const addDays = (s, n) => new Date((dn(s) + n) * 864e5).toISOString().slice(0, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = n => n < 0 ? `逾期 ${-n} 天` : n === 0 ? '今天' : `還有 ${n} 天`;

(async () => {
  const [cat, set, us, cs, ps] = await Promise.all([
    db.doc('config/catalog').get(),
    db.doc('config/settings').get(),
    db.collection('users').where('status', '==', 'approved').get(),
    db.collection('customers').get(),
    db.collection('promos').where('month', '==', month).get()
  ]);
  const cfg = { ahead: 3, renewDays: 365, renewAhead: 30, ...(set.exists ? set.data() : {}) };
  const NM = new Map((cat.exists ? cat.data().nodes : []).map(n => [n.id, n]));
  const users = new Map(us.docs.map(d => [d.id, d.data()]));
  const promos = ps.docs.map(d => ({ id: d.id, ...d.data() }));

  // 與網頁 index.html 相同的計算方式
  const buysOf = c => c.buys || ((c.d || {}).items || []).map((i, k) => ({
    id: 'm' + k, pid: i.id, name: i.name, qty: i.qty, date: c.base || (c.d || {}).purchaseDate, cycle: i.cycle
  }));
  const cycleOf = b => NM.get(b.pid)?.cycle ?? b.cycle;
  const dueOf = b => {
    if (b.stop || b.done) return null;
    if (b.due) return b.due;
    const y = +cycleOf(b);
    return y > 0 && b.date ? addDays(b.date, y) : null;
  };
  const underCat = (id, set) => { while (id) { if (set.has(id)) return 1; id = NM.get(id)?.parent; } return 0; };
  const pMatch = (p, c) => {
    const cs2 = new Set(p.cats || []), ps2 = new Set(p.prods || []), all = !cs2.size && !ps2.size;
    return buysOf(c).filter(b => !b.stop && (all || ps2.has(b.pid) || underCat(b.pid, cs2))).length;
  };

  const byOwner = new Map();   // uid -> { rem: [], promo: Map(promoId -> {title, n}) }
  const get = uid => { if (!byOwner.has(uid)) byOwner.set(uid, { rem: [], promo: new Map() }); return byOwner.get(uid); };

  for (const doc of cs.docs) {
    const c = doc.data(), d = c.d || {};
    if (!users.has(c.ownerUid)) continue;

    // 產品跟進（每筆購買各自計算）
    const dates = buysOf(c).map(dueOf).filter(Boolean).sort();
    if (dates.length) {
      const df = dn(dates[0]) - dn(today);
      if (df <= cfg.ahead) get(c.ownerUid).rem.push({ name: d.name, kind: '產品跟進', df });
    }
    // 會員續約
    const m = d.member;
    if (m && m.is && m.join) {
      const df = dn(addDays(m.join, +cfg.renewDays)) - dn(today);
      if (df <= cfg.renewAhead) get(c.ownerUid).rem.push({ name: d.name, kind: '會員續約', df });
    }
    // 本月促銷：符合條件且尚未發送過的顧客
    for (const p of promos) {
      if ((c.promoSent || {})[p.id]) continue;
      if (!pMatch(p, c)) continue;
      const o = get(c.ownerUid);
      const e = o.promo.get(p.id) || { title: p.title, n: 0 };
      e.n++; o.promo.set(p.id, e);
    }
  }

  const tr = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });

  const td = 'padding:10px;border-bottom:1px solid #e9e2d2';
  let sent = 0;
  for (const [uid, o] of byOwner) {
    const u = users.get(uid);
    if (!o.rem.length && !o.promo.size) continue;
    o.rem.sort((a, b) => a.df - b.df);

    const remRows = o.rem.map(r => `<tr>
      <td style="${td}"><b>${esc(r.name)}</b></td><td style="${td}">${r.kind}</td>
      <td style="${td};color:${r.df < 0 ? '#c0483f' : '#8a6a22'}">${when(r.df)}</td></tr>`).join('');
    const promoRows = [...o.promo.values()].map(p => `<tr>
      <td style="${td}"><b>🎁 ${esc(p.title)}</b></td><td style="${td}" colspan="2">${p.n} 位顧客可發送</td></tr>`).join('');

    const html = `<div style="font-family:'Noto Sans TC',sans-serif;max-width:560px;margin:auto;background:#f6f2ea;padding:24px">
      <div style="background:#1b2236;color:#e6d3a3;padding:16px 20px;border-radius:12px 12px 0 0;font-size:18px">◆ 顧客跟進提醒</div>
      <div style="background:#fff;padding:20px;border-radius:0 0 12px 12px">
      <p>${esc(u.realName)} 你好：</p>
      ${o.rem.length ? `<p>今天有 <b>${o.rem.length}</b> 項需要跟進：</p><table style="width:100%;border-collapse:collapse;font-size:14px">${remRows}</table>` : ''}
      ${o.promo.size ? `<p style="margin-top:18px">本月促銷可發送：</p><table style="width:100%;border-collapse:collapse;font-size:14px">${promoRows}</table>` : ''}
      <p style="text-align:center;margin-top:22px"><a href="${esc(process.env.SITE_URL)}" style="background:#b08d4a;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none">進入系統</a></p>
      </div></div>`;

    const subject = [o.rem.length && `${o.rem.length} 位顧客需要跟進`, o.promo.size && `${o.promo.size} 則本月促銷`].filter(Boolean).join('、');
    await tr.sendMail({
      from: `顧客跟進系統 <${process.env.GMAIL_USER}>`,
      to: u.email,
      subject: `【提醒】${subject}`,
      html
    });
    sent++;
  }

  // 標記本月促銷已隨提醒信通知（網頁「已發布」清單會顯示狀態）
  for (const p of promos) if (!p.emailed) await db.doc('promos/' + p.id).update({ emailed: true });

  console.log(`完成：已寄出 ${sent} 封`); // 不輸出顧客資料
})().catch(e => { console.error(e.message); process.exit(1); });
