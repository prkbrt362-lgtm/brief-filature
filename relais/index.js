// =====================================================================
//  Relais « Situation du secteur » — Cloudflare Worker — version finale
//  Entrée :  ?cp=59140   ou   ?lat=51.03&lon=2.37  (centre de la carte)
//  Sortie :  JSON — commune, vigilance météo, risques majeurs (Géorisques),
//            perturbations trains, presse classée par risque, synthèse IA.
//
//  Secrets à créer dans Cloudflare (Settings → Variables and Secrets) :
//    METEOFRANCE_KEY    clé API « Données Publiques Vigilance » (portail-api.meteofrance.fr)
//    SNCF_KEY           clé api.sncf.com (gratuite)
//    ANTHROPIC_API_KEY  clé console.anthropic.com (synthèse IA, payante à l'usage)
//    GEORISQUES_TOKEN   facultatif — jeton Géorisques si l'API l'exige
//    TEST_MODE          facultatif — "1" pour tester l'URL dans un navigateur
//  Chaque source est indépendante : sans sa clé, elle est simplement marquée
//  « non configuré » et le reste fonctionne.
// =====================================================================

const ALLOWED_ORIGINS = ['https://prkbrt362-lgtm.github.io'];
const MODEL = 'claude-haiku-5-5';
const CACHE_SECONDS = 600; // 10 min : limite le coût et la charge sur les sources

// Requêtes presse par famille de risque (ordre = priorité de classement)
const CATEGORIES = [
  { label: 'Ordre public', q: 'manifestation OR rassemblement OR grève OR blocage OR émeute OR "violences urbaines" OR "rodéo urbain"' },
  { label: 'Sécurité / menace', q: 'attentat OR "alerte à la bombe" OR évacuation OR fusillade OR "règlement de comptes" OR "colis suspect" OR "coups de feu"' },
  { label: 'Risque industriel / accident', q: 'explosion OR incendie OR "fuite de gaz" OR "accident industriel" OR Seveso OR confinement OR pollution' },
  { label: 'Événements / arrêtés', q: 'match OR concert OR festival OR salon OR "visite présidentielle" OR "visite ministérielle" OR "arrêté préfectoral"' },
  { label: 'Circulation / travaux', q: 'travaux OR "route coupée" OR "circulation perturbée" OR déviation OR fermeture OR bouchons' },
  { label: 'Actualité locale', q: '' }
];

const EFFETS = { NO_SERVICE: 'Trafic interrompu', REDUCED_SERVICE: 'Service réduit', SIGNIFICANT_DELAYS: 'Retards importants', DETOUR: 'Itinéraire modifié', MODIFIED_SERVICE: 'Service modifié', ADDITIONAL_SERVICE: 'Service supplémentaire', STOP_MOVED: 'Arrêt déplacé', OTHER_EFFECT: 'Perturbation', UNKNOWN_EFFECT: 'Perturbation' };
const PHENOMENES = { 1: 'Vent violent', 2: 'Pluie-inondation', 3: 'Orages', 4: 'Crues', 5: 'Neige-verglas', 6: 'Canicule', 7: 'Grand froid', 8: 'Avalanches', 9: 'Vagues-submersion' };

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : (env.TEST_MODE === '1' ? '*' : ALLOWED_ORIGINS[0]), // TEST_MODE : accepte aussi le fichier ouvert en local
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    // Seule ta page peut appeler le relais (protège ta facture IA). TEST_MODE=1 pour tester à la main.
    if (!allowed && env.TEST_MODE !== '1') return json({ error: 'Origine non autorisée' }, 403, cors);

    const url = new URL(request.url);
    const cp = (url.searchParams.get('cp') || '').trim();
    const lat = parseFloat(url.searchParams.get('lat'));
    const lon = parseFloat(url.searchParams.get('lon'));
    const byCp = /^\d{5}$/.test(cp);
    const byLl = !isNaN(lat) && !isNaN(lon);
    if (!byCp && !byLl) return json({ error: 'Code postal (5 chiffres) ou position requis' }, 400, cors);

    // Cache partagé : même secteur dans les 10 min = pas de nouvel appel aux sources
    const cacheKey = new Request(url.origin + '/cache?' + (byCp ? 'cp=' + cp : 'll=' + lat.toFixed(3) + ',' + lon.toFixed(3)));
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { status: 200, headers: { ...Object.fromEntries(hit.headers), ...cors } });

    let communes;
    try { communes = await resolveCommune(byCp ? { cp } : { lat, lon }); }
    catch (e) { return json({ error: e.message }, 404, cors); }

    const c = communes[0];
    const dep = c.departement ? c.departement.code : '';
    const centre = c.centre && c.centre.coordinates ? c.centre.coordinates : null; // [lon, lat]
    const cLat = byLl ? lat : (centre ? centre[1] : null);
    const cLon = byLl ? lon : (centre ? centre[0] : null);

    const [vigilance, georisques, sncf, presse] = await Promise.all([
      safe(() => getVigilance(dep, env)),
      safe(() => getGeorisques(c.code, env)),
      safe(() => getSncf(cLat, cLon, env)),
      safe(() => getPresse(c.nom))
    ]);
    const articles = Array.isArray(presse.items) ? presse.items : [];
    const base = {
      cp: byCp ? cp : ((c.codesPostaux || [])[0] || ''),
      ville: c.nom,
      insee: c.code,
      departement: c.departement ? c.departement.nom + ' (' + dep + ')' : '',
      autresCommunes: byCp ? communes.slice(1).map(x => x.nom) : [],
      maj: new Date().toISOString(),
      vigilance, georisques, sncf,
      presse: articles
    };
    const synthese = await safe(() => getSynthese(base, env));

    const body = {
      ...base,
      synthese,
      sources: {
        'Météo': vigilance.statut,
        'Géorisques': georisques.statut,
        'Trains': sncf.statut,
        'Presse': presse.statut || 'ok',
        'IA': synthese.statut
      }
    };
    const resp = json(body, 200, cors);
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }
};

// ---------- utilitaires ----------
async function safe(fn) {
  try { return await fn(); } catch (e) { return { statut: 'indisponible' }; }
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + CACHE_SECONDS }
  });
}
function decode(s) {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

// ---------- 1. Commune (geo.api.gouv.fr, sans clé) ----------
async function resolveCommune(p) {
  const f = 'fields=nom,code,codesPostaux,departement,centre&format=json';
  const u = p.cp
    ? 'https://geo.api.gouv.fr/communes?codePostal=' + p.cp + '&' + f
    : 'https://geo.api.gouv.fr/communes?lat=' + p.lat + '&lon=' + p.lon + '&' + f;
  const r = await fetch(u);
  const a = await r.json();
  if (!Array.isArray(a) || !a.length) throw new Error('Commune introuvable');
  return a;
}

// ---------- 2. Vigilance Météo-France (crues incluses) ----------
async function getVigilance(dep, env) {
  if (!env.METEOFRANCE_KEY) return { statut: 'non configuré' };
  if (!dep) return { statut: 'département inconnu' };
  const r = await fetch('https://public-api.meteofrance.fr/public/DPVigilance/v1/cartevigilance/encours', {
    headers: { apikey: env.METEOFRANCE_KEY, accept: 'application/json' }
  });
  if (!r.ok) return { statut: 'indisponible (' + r.status + ')' };
  const j = await r.json();
  const periods = (j.product && j.product.periods) || [];
  const periodes = periods.map(p => {
    const doms = ((p.timelaps && p.timelaps.domain_ids) || [])
      .filter(d => d.domain_id === dep || d.domain_id === dep + '10'); // département + son littoral
    const max = {};
    doms.forEach(d => (d.phenomenon_items || []).forEach(ph => {
      const id = String(ph.phenomenon_id);
      const col = +ph.phenomenon_max_color_id || 1;
      if (!max[id] || col > max[id]) max[id] = col;
    }));
    return {
      echeance: p.echeance || '',
      debut: p.begin_validity_time || '',
      fin: p.end_validity_time || '',
      phenomenes: Object.keys(max).map(id => ({ id, nom: PHENOMENES[id] || 'Phénomène ' + id, couleur: max[id] }))
        .sort((a, b) => b.couleur - a.couleur)
    };
  });
  return { statut: 'ok', periodes };
}

// ---------- 3. Risques majeurs (Géorisques) ----------
async function getGeorisques(insee, env) {
  const h = env.GEORISQUES_TOKEN ? { 'X-API-Key': env.GEORISQUES_TOKEN } : {};
  const base = 'https://georisques.gouv.fr/api/v1/';
  const res = { statut: 'ok', risques: [], seveso: [] };
  try {
    const r = await fetch(base + 'gaspar/risques?code_insee=' + insee, { headers: h });
    if (r.ok) {
      const j = await r.json();
      const d = (j.data && j.data[0]) || {};
      res.risques = (d.risques_detail || []).map(x => x.libelle_risque_long).filter(Boolean);
    } else res.statut = 'partiel (' + r.status + ')';
  } catch (e) { res.statut = 'partiel'; }
  try {
    const r = await fetch(base + 'installations_classees?code_insee=' + insee + '&page_size=100', { headers: h });
    if (r.ok) {
      const j = await r.json();
      (j.data || []).forEach(x => {
        const s = x.statutSeveso || x.statut_seveso || '';
        if (/seveso/i.test(s) && !/non/i.test(s)) {
          res.seveso.push({ nom: x.raisonSociale || x.raison_sociale || x.nom || 'Site', statut: s, lat: x.latitude || null, lon: x.longitude || null });
        }
      });
    }
  } catch (e) { /* liste Seveso facultative */ }
  if (!res.risques.length && !res.seveso.length && res.statut !== 'ok') res.statut = 'indisponible';
  return res;
}

// ---------- 4. Trains (api.sncf.com) ----------
async function getSncf(lat, lon, env) {
  if (!env.SNCF_KEY) return { statut: 'non configuré' };
  if (lat == null || lon == null) return { statut: 'position inconnue' };
  const h = { Authorization: 'Basic ' + btoa(env.SNCF_KEY + ':') };
  const base = 'https://api.sncf.com/v1/coverage/sncf/';
  const r = await fetch(base + 'coords/' + lon + ';' + lat + '/stop_areas?distance=10000&count=3', { headers: h });
  if (!r.ok) return { statut: 'indisponible (' + r.status + ')' };
  const j = await r.json();
  const gares = (j.stop_areas || []).slice(0, 3);
  const perturbations = [];
  const seen = new Set();
  for (const g of gares) {
    try {
      const d = await fetch(base + 'stop_areas/' + encodeURIComponent(g.id) + '/disruptions?count=10', { headers: h });
      if (!d.ok) continue;
      const dj = await d.json();
      (dj.disruptions || []).forEach(x => {
        if (seen.has(x.id) || (x.status && x.status !== 'active')) return;
        seen.add(x.id);
        const msg = (x.messages && x.messages[0] && x.messages[0].text) || '';
        perturbations.push({
          gare: g.name,
          gravite: (x.severity && x.severity.name) || '',
          effet: EFFETS[(x.severity && x.severity.effect) || ''] || (x.severity && x.severity.effect) || '',
          message: msg.replace(/<[^>]+>/g, '').slice(0, 240)
        });
      });
    } catch (e) { /* gare suivante */ }
  }
  return { statut: 'ok', gares: gares.map(g => g.name), perturbations: perturbations.slice(0, 8) };
}

// ---------- 5. Presse locale classée par risque (Google Actualités, 7 jours) ----------
async function getPresse(ville) {
  const lists = await Promise.all(CATEGORIES.map(c => {
    const q = '"' + ville + '"' + (c.q ? ' (' + c.q + ')' : '') + ' when:7d';
    return gnews(q).catch(() => []);
  }));
  const seen = new Set();
  const items = [];
  lists.forEach((arr, i) => {
    arr.slice(0, i === CATEGORIES.length - 1 ? 6 : 8).forEach(a => {
      const k = a.titre.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      items.push({ ...a, cat: CATEGORIES[i].label });
    });
  });
  return { statut: 'ok', items };
}
async function gnews(q) {
  const r = await fetch('https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=fr&gl=FR&ceid=FR:fr', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const xml = await r.text();
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const get = t => {
      const x = b.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)<\\/' + t + '>'));
      return x ? decode(x[1]) : '';
    };
    const source = get('source');
    let titre = get('title');
    if (source && titre.endsWith(' - ' + source)) titre = titre.slice(0, -(source.length + 3));
    out.push({ titre, source, lien: get('link'), date: get('pubDate') });
  }
  return out;
}

// ---------- 6. Synthèse IA (Claude) ----------
async function getSynthese(d, env) {
  if (!env.ANTHROPIC_API_KEY) return { statut: 'non configuré' };
  const presse = d.presse.map((a, i) => '[' + (i + 1) + '] (' + a.cat + ') ' + a.date + ' — ' + a.titre + ' — ' + a.source).join('\n') || 'aucun article';
  const vig = d.vigilance.statut === 'ok' && d.vigilance.periodes[0]
    ? d.vigilance.periodes[0].phenomenes.filter(p => p.couleur >= 2).map(p => p.nom + ' niveau ' + ['', 'vert', 'jaune', 'orange', 'rouge'][p.couleur]).join(', ') || 'aucune'
    : 'donnée indisponible';
  const geo = d.georisques.statut && d.georisques.statut !== 'indisponible'
    ? 'Risques recensés : ' + (d.georisques.risques.join(', ') || 'aucun') + '. Sites Seveso : ' + (d.georisques.seveso.map(s => s.nom).join(', ') || 'aucun')
    : 'donnée indisponible';
  const trains = d.sncf.statut === 'ok'
    ? (d.sncf.perturbations.map(p => p.gare + ' : ' + (p.effet || p.gravite)).join(' ; ') || 'aucune perturbation')
    : 'donnée indisponible';

  const prompt =
`Tu es analyste sûreté. Une équipe d'enquêteurs privés prépare une mission discrète d'observation sur la voie publique à ${d.ville} (${d.departement}), dans les 24 à 48 h.

Évalue la situation du secteur pour cette mission : foules, manifestations, présence policière renforcée, menaces, perturbations de circulation ou de transport, risques météo et technologiques, danger pour l'équipe.

Règles strictes :
- Utilise UNIQUEMENT les éléments ci-dessous. N'invente rien.
- Ignore les articles hors sujet (résultats sportifs, nécrologies, homonymes d'autres villes, faits clos sans conséquence actuelle).
- Chaque point cite les numéros d'articles [n] qui le fondent.
- Si rien de significatif : niveau "vert" et précise que l'absence d'information ne garantit pas l'absence de risque.
- Niveau : "vert" (RAS), "orange" (à intégrer au dispositif), "rouge" (mission à reconsidérer ou à adapter fortement).

VIGILANCE MÉTÉO : ${vig}
GÉORISQUES : ${geo}
TRAINS : ${trains}
PRESSE (7 jours) :
${presse}

Réponds uniquement avec ce JSON, sans texte autour :
{"niveau":"vert|orange|rouge","synthese":"2 à 3 phrases","points":[{"categorie":"...","texte":"...","refs":[1,2]}]}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) return { statut: 'indisponible (' + r.status + ')' };
  const j = await r.json();
  const txt = (j.content || []).map(b => b.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { statut: 'réponse illisible' };
  const o = JSON.parse(m[0]);
  const niveau = ['vert', 'orange', 'rouge'].includes(o.niveau) ? o.niveau : 'orange';
  return { statut: 'ok', niveau, synthese: String(o.synthese || ''), points: Array.isArray(o.points) ? o.points.slice(0, 8) : [] };
}
