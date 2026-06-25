/* =========================================================
   Meta Conversions API (CAPI) — server-side
   ---------------------------------------------------------
   Recebe um POST do navegador (/api/capi) e reenvia o evento
   para a Graph API do Meta com o máximo de parâmetros possível.

   IMPORTANTE: o Access Token NUNCA fica no código.
   Ele é lido de process.env.META_CAPI_TOKEN (variável de
   ambiente configurada no painel da Vercel).

   Dedup: o navegador manda o mesmo event_id usado no Pixel,
   então Pixel + CAPI são contados como UM evento só.
   ========================================================= */

const crypto = require('crypto');

const PIXEL_ID = '993342428094789';        // público — pode ficar aqui
const API_VERSION = 'v21.0';

// SHA-256 (lowercase + trim) — padrão exigido pelo Meta para dados de usuário
function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

// Lê o corpo da requisição de forma robusta (Vercel pode ou não pré-parsear)
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (e) { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const token = process.env.META_CAPI_TOKEN;
  if (!token) {
    // Pixel continua funcionando no navegador; só a CAPI fica inativa
    res.status(500).json({ ok: false, error: 'META_CAPI_TOKEN não configurado' });
    return;
  }

  const body = await readJsonBody(req);

  // ---- Dados que só o servidor consegue capturar com confiança ----
  const fwd = (req.headers['x-forwarded-for'] || '').toString();
  const ip = fwd.split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const ua = (req.headers['user-agent'] || '').toString();

  // ---- user_data: o máximo de parâmetros disponíveis nesta página ----
  const userData = {
    client_ip_address: ip,
    client_user_agent: ua,
  };
  if (body.fbp) userData.fbp = body.fbp;                          // cookie _fbp
  if (body.fbc) userData.fbc = body.fbc;                          // cookie _fbc / fbclid
  if (body.external_id) userData.external_id = sha256(body.external_id); // id anônimo persistente

  // ---- monta o evento ----
  const event = {
    event_name: body.event_name,
    event_time: Math.floor(Date.now() / 1000),
    event_id: body.event_id,                 // <- mesmo do Pixel (dedup)
    event_source_url: body.event_source_url,
    action_source: 'website',
    user_data: userData,
  };
  if (body.custom_data && typeof body.custom_data === 'object') {
    event.custom_data = body.custom_data;
  }

  const payload = { data: [event] };
  // Opcional: para ver os eventos em "Testar eventos" no Gerenciador de Eventos
  if (process.env.META_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  }

  try {
    const url = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`;
    const fbRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await fbRes.json();
    res.status(fbRes.ok ? 200 : 502).json({ ok: fbRes.ok, fb: data });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err) });
  }
};
