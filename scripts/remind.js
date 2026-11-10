const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
const dn = s => Math.round(Date.parse(s + 'T00:00:00Z') / 864e5);
const addDays = (s, n) => new Date((dn(s) + n) * 864e5).toISOString().slice(0, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = n => n < 0 ? `逾期 ${-n} 天` : n === 0 ? '今天' : `還有 ${n} 天`;

(async () => {
  const [cat, set, us, cs] = await Promise.all([
    db.doc('config/catalog').get(),
    db.doc('config/settings').get(),
    db.collection('users').where('status', '==', 'approved').get(),
    db.collection('customers').get()
  ]);
  const cfg = { ahead: 3, renewDays: 365, renewAhead: 30, ...(set.exists ? set.data() : {}) };
  const NM = new Map((cat.exists ? cat.data().nodes : []).map(n => [n.id, n]));
  const users = new Map(us.docs.map(d => [d.id, d.data()]));
  const cycleOf = i => NM.get(i.id)?.cycle ?? i.cycle;

  const byOwner = new Map();
  for (const doc of cs.docs) {
    const c = doc.data(), d = c.d || {};
    if (!users.has(c.ownerUid)) continue;
    const list = byOwner.get(c.ownerUid) || [];
    const base = c.base || d.purchaseDate;
    const its = (d.items || []).filter(i => cycleOf(i) > 0);
    if (its.length && base) {
      const date = its.map(i => addDays(base, +cycleOf(i))).sort()[0];
      const df = dn(date) - dn(today);
      if (df <= cfg.ahead) list.push({ name: d.name, kind: '產品跟進', date, df });
    }
    const m = d.member;
    if (m && m.is && m.join) {
      const date = addDays(m.join, +cfg.renewDays), df = dn(date) - dn(today);
      if (df <= cfg.renewAhead) list.push({ name: d.name, kind: '會員續約', date, df });
    }
    if (list.length) byOwner.set(c.ownerUid, list);
  }

  const tr = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });

  let sent = 0;
  for (const [uid, list] of byOwner) {
    const u = users.get(uid);
    list.sort((a, b) => a.df - b.df);
    const rows = list.map(r => `<tr>
      <td style="padding:10px;border-bottom:1px solid #e9e2d2"><b>${esc(r.name)}</b></td>
      <td style="padding:10px;border-bottom:1px solid #e9e2d2">${r.kind}</td>
      <td style="padding:10px;border-bottom:1px solid #e9e2d2;color:${r.df < 0 ? '#c0483f' : '#8a6a22'}">${when(r.df)}</td></tr>`).join('');
    const html = `<div style="font-family:'Noto Sans TC',sans-serif;max-width:560px;margin:auto;background:#f6f2ea;padding:24px">
      <div style="background:#1b2236;color:#e6d3a3;padding:16px 20px;border-radius:12px 12px 0 0;font-size:18px">◆ 顧客跟進提醒</div>
      <div style="background:#fff;padding:20px;border-radius:0 0 12px 12px">
      <p>${esc(u.realName)} 你好，今天有 <b>${list.length}</b> 項需要跟進：</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
      <p style="text-align:center;margin-top:22px"><a href="${esc(process.env.SITE_URL)}" style="background:#b08d4a;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none">進入系統跟進</a></p>
      </div></div>`;
    await tr.sendMail({
      from: `顧客跟進系統 <${process.env.GMAIL_USER}>`,
      to: u.email,
      subject: `【跟進提醒】今天有 ${list.length} 位顧客需要跟進`,
      html
    });
    sent++;
  }
  console.log(`完成：已寄出 ${sent} 封`); // 不輸出顧客資料
})().catch(e => { console.error(e.message); process.exit(1); });
