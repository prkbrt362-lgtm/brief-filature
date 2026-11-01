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
  { label: 'À venir', days: 14, q: 'prévu OR prévue OR "appel à manifester" OR "appel à la grève" OR préavis OR "ce week-end" OR "la semaine prochaine" OR "aura lieu" OR "se tiendra" OR "se déroulera" OR programme OR annonce' },
  { label: 'Ordre public', days: 7, q: 'manifestation OR rassemblement OR grève OR blocage OR émeute OR "violences urbaines" OR "rodéo urbain"' },
  { label: 'Sécurité / menace', days: 7, q: 'attentat OR "alerte à la bombe" OR évacuation OR fusillade OR "règlement de comptes" OR "colis suspect" OR "coups de feu"' },
  { label: 'Risque industriel / accident', days: 7, q: 'explosion OR incendie OR "fuite de gaz" OR "accident industriel" OR Seveso OR confinement OR pollution' },
  { label: 'Événements / arrêtés', days: 7, q: 'match OR concert OR festival OR salon OR "visite présidentielle" OR "visite ministérielle" OR "arrêté préfectoral"' },
  { label: 'Circulation / travaux', days: 7, q: 'travaux OR "route coupée" OR "circulation perturbée" OR déviation OR fermeture OR bouchons' },
  { label: 'Actualité locale', days: 7, q: '' }
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
    const today = parisDate(new Date());
    const dParam = url.searchParams.get('date') || '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dParam) && dParam >= today ? dParam : today;
    const byCp = /^\d{5}$/.test(cp);
    const byLl = !isNaN(lat) && !isNaN(lon);
    if (!byCp && !byLl) return json({ error: 'Code postal (5 chiffres) ou position requis' }, 400, cors);

    // Cache partagé : même secteur dans les 10 min = pas de nouvel appel aux sources
    const cacheKey = new Request(url.origin + '/cache?' + (byCp ? 'cp=' + cp : 'll=' + lat.toFixed(3) + ',' + lon.toFixed(3)) + '&d=' + date);
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

    const [vigilance, georisques, sncf, presse, prevision] = await Promise.all([
      safe(() => getVigilance(dep, env)),
      safe(() => getGeorisques(c.code, env)),
      safe(() => getSncf(cLat, cLon, env)),
      safe(() => getPresse(c.nom)),
      safe(() => getPrevision(cLat, cLon, date))
    ]);
    const articles = Array.isArray(presse.items) ? presse.items : [];
    const base = {
      cp: byCp ? cp : ((c.codesPostaux || [])[0] || ''),
      ville: c.nom,
      insee: c.code,
      departement: c.departement ? c.departement.nom + ' (' + dep + ')' : '',
      autresCommunes: byCp ? communes.slice(1).map(x => x.nom) : [],
      maj: new Date().toISOString(),
      dateMission: date,
      prevision,
      vigilance, georisques, sncf,
      presse: articles
    };
    const synthese = await safe(() => getSynthese(base, env));

    const body = {
      ...base,
      synthese,
      sources: {
        'Prévisions': prevision.statut,
        'Vigilance': vigilance.statut,
        'Géorisques': georisques.statut,
        'Trains': sncf.statut,
        'Presse': presse.statut || 'indisponible',
        'IA': synthese.statut
      }
    };
    const resp = json(body, 200, cors);
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }
};

// ---------- utilitaires ----------
function parisDate(d) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); // AAAA-MM-JJ
}
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
    const deb = Date.parse(p.begin_validity_time), fin = Date.parse(p.end_validity_time);
    return {
      date: (!isNaN(deb) && !isNaN(fin)) ? parisDate(new Date((deb + fin) / 2)) : '',
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
  const diag = [];
  // 1) Google Actualités (avec cookie de consentement pour éviter la page RGPD en Europe)
  let lists = await Promise.all(CATEGORIES.map(c => {
    const q = '"' + ville + '"' + (c.q ? ' (' + c.q + ')' : '') + ' when:' + c.days + 'd';
    return rss('https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=fr&gl=FR&ceid=FR:fr', 'source');
  }));
  let n = lists.reduce((a, l) => a + l.items.length, 0);
  diag.push('Google ' + (n ? n : (lists[0].err || '0')));
  // 2) Repli : Bing Actualités (7 derniers jours)
  if (!n) {
    lists = await Promise.all(CATEGORIES.map(c => {
      const q = '"' + ville + '"' + (c.q ? ' (' + c.q + ')' : '');
      return rss('https://www.bing.com/news/search?format=rss&setlang=fr-FR&cc=FR&qft=interval%3d%22' + (c.days > 7 ? 9 : 8) + '%22&q=' + encodeURIComponent(q), 'News:Source');
    }));
    n = lists.reduce((a, l) => a + l.items.length, 0);
    diag.push('Bing ' + (n ? n : (lists[0].err || '0')));
  }
  const seen = new Set();
  const items = [];
  lists.forEach((l, i) => {
    const limite = Date.now() - (CATEGORIES[i].days + 1) * 86400000;
    l.items.filter(a => { const t = Date.parse(a.date); return isNaN(t) || t >= limite; })
      .slice(0, i === CATEGORIES.length - 1 ? 6 : 8).forEach(a => {
        const k = a.titre.toLowerCase();
        if (!a.titre || seen.has(k)) return;
        seen.add(k);
        items.push({ ...a, cat: CATEGORIES[i].label });
      });
  });
  return { statut: items.length ? 'ok' : 'vide (' + diag.join(', ') + ')', items };
}
async function rss(url, sourceTag) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Cookie': 'CONSENT=YES+cb; SOCS=CAI'
      }
    });
    if (!r.ok) return { items: [], err: 'HTTP ' + r.status };
    const xml = await r.text();
    if (xml.indexOf('<item') === -1) return { items: [], err: xml.indexOf('<rss') === -1 ? 'pas de flux' : '0' };
    const out = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml))) {
      const b = m[1];
      const get = t => {
        const x = b.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)<\\/' + t + '>'));
        return x ? decode(x[1]) : '';
      };
      const source = get(sourceTag);
      let titre = get('title');
      if (source && titre.endsWith(' - ' + source)) titre = titre.slice(0, -(source.length + 3));
      out.push({ titre, source, lien: get('link'), date: get('pubDate') });
    }
    return { items: out };
  } catch (e) {
    return { items: [], err: 'erreur réseau' };
  }
}

// ---------- 5 bis. Prévisions du jour de mission (Open-Meteo, sans clé, jusqu'à J+15) ----------
const TEMPS = c => c === 0 ? 'Ciel clair' : c <= 3 ? 'Nuageux' : c <= 48 ? 'Brouillard' : c <= 57 ? 'Bruine' : c <= 67 ? 'Pluie' : c <= 77 ? 'Neige' : c <= 82 ? 'Averses' : c <= 86 ? 'Averses de neige' : 'Orages';
async function getPrevision(lat, lon, date) {
  if (lat == null || lon == null) return { statut: 'position inconnue' };
  const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
    '&daily=weather_code,temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max,sunrise,sunset' +
    '&timezone=Europe%2FParis&start_date=' + date + '&end_date=' + date;
  const r = await fetch(u);
  if (r.status === 400) return { statut: 'hors période (max J+15)' };
  if (!r.ok) return { statut: 'indisponible (' + r.status + ')' };
  const j = await r.json();
  const d = j.daily;
  if (!d || !d.time || !d.time.length) return { statut: 'indisponible' };
  const hm = s => (s || '').slice(11, 16);
  return {
    statut: 'ok',
    date: d.time[0],
    temps: TEMPS(d.weather_code[0]),
    tmin: Math.round(d.temperature_2m_min[0]),
    tmax: Math.round(d.temperature_2m_max[0]),
    pluie_mm: d.precipitation_sum[0],
    pluie_proba: d.precipitation_probability_max ? d.precipitation_probability_max[0] : null,
    rafales_kmh: Math.round(d.wind_gusts_10m_max[0]),
    lever: hm(d.sunrise[0]),
    coucher: hm(d.sunset[0])
  };
}

// ---------- 6. Synthèse IA (Claude) ----------
async function getSynthese(d, env) {
  if (!env.ANTHROPIC_API_KEY) return { statut: 'non configuré' };
  const presse = d.presse.map((a, i) => '[' + (i + 1) + '] (' + a.cat + ') ' + a.date + ' — ' + a.titre + ' — ' + a.source).join('\n') || 'aucun article';
  const per = d.vigilance.statut === 'ok' ? (d.vigilance.periodes || []).find(p => p.date === d.dateMission) : null;
  const vig = per
    ? per.phenomenes.filter(p => p.couleur >= 2).map(p => p.nom + ' niveau ' + ['', 'vert', 'jaune', 'orange', 'rouge'][p.couleur]).join(', ') || 'aucune'
    : 'pas encore publiée pour cette date (publication la veille)';
  const pv = d.prevision.statut === 'ok'
    ? d.prevision.temps + ', ' + d.prevision.tmin + ' à ' + d.prevision.tmax + ' °C, pluie ' + d.prevision.pluie_mm + ' mm' + (d.prevision.pluie_proba != null ? ' (' + d.prevision.pluie_proba + ' %)' : '') + ', rafales ' + d.prevision.rafales_kmh + ' km/h, lever ' + d.prevision.lever + ', coucher ' + d.prevision.coucher
    : 'indisponible';
  const geo = d.georisques.statut && d.georisques.statut !== 'indisponible'
    ? 'Risques recensés : ' + (d.georisques.risques.join(', ') || 'aucun') + '. Sites Seveso : ' + (d.georisques.seveso.map(s => s.nom).join(', ') || 'aucun')
    : 'donnée indisponible';
  const trains = d.sncf.statut === 'ok'
    ? (d.sncf.perturbations.map(p => p.gare + ' : ' + (p.effet || p.gravite)).join(' ; ') || 'aucune perturbation')
    : 'donnée indisponible';

  const prompt =
`Tu es analyste sûreté. Une équipe d'enquêteurs privés prépare une mission discrète d'observation sur la voie publique à ${d.ville} (${d.departement}) le ${d.dateMission} (aujourd'hui : ${parisDate(new Date())}).

PRIORITÉ : ce qui est PRÉVU ou ATTENDU le jour de la mission (manifestations annoncées, préavis de grève, matchs, événements, travaux, visites officielles, arrêtés). Les articles décrivent souvent des événements à venir : déduis leur date à partir du texte et de la date de publication. Les faits passés ne servent que de contexte (tensions persistantes, dispositif policier en place).

Évalue l'impact sur la mission : foules, manifestations, présence policière renforcée, menaces, perturbations de circulation ou de transport, risques météo et technologiques, danger pour l'équipe.

Règles strictes :
- Utilise UNIQUEMENT les éléments ci-dessous. N'invente rien.
- Ignore les articles hors sujet (résultats sportifs, nécrologies, homonymes d'autres villes, faits clos sans conséquence actuelle).
- Ne place dans "a_venir" que des événements dont la date tombe le jour de la mission ou la veille, ou dont la date est incertaine mais plausible ; indique "date à confirmer" dans ce cas.
- Chaque point cite les numéros d'articles [n] qui le fondent.
- Si rien de significatif : niveau "vert" et précise que l'absence d'information ne garantit pas l'absence de risque.
- Niveau : "vert" (RAS), "orange" (à intégrer au dispositif), "rouge" (mission à reconsidérer ou à adapter fortement).

PRÉVISION MÉTÉO DU JOUR J : ${pv}
VIGILANCE MÉTÉO DU JOUR J : ${vig}
GÉORISQUES : ${geo}
TRAINS : ${trains}
PRESSE (catégorie, date de publication, titre) :
${presse}

Réponds uniquement avec ce JSON, sans texte autour :
{"niveau":"vert|orange|rouge","synthese":"2 à 3 phrases centrées sur le jour J","a_venir":[{"quand":"date/heure ou 'date à confirmer'","quoi":"...","impact":"conséquence pour l'équipe","refs":[1]}],"contexte":[{"categorie":"...","texte":"...","refs":[2]}]}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1400, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) return { statut: 'indisponible (' + r.status + ')' };
  const j = await r.json();
  const txt = (j.content || []).map(b => b.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { statut: 'réponse illisible' };
  const o = JSON.parse(m[0]);
  const niveau = ['vert', 'orange', 'rouge'].includes(o.niveau) ? o.niveau : 'orange';
  return {
    statut: 'ok', niveau, synthese: String(o.synthese || ''),
    a_venir: Array.isArray(o.a_venir) ? o.a_venir.slice(0, 8) : [],
    points: Array.isArray(o.contexte) ? o.contexte.slice(0, 6) : []
  };
}
