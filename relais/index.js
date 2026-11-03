// =====================================================================
//  Relais « Situation du secteur » — Cloudflare Worker — version finale
//  Entrée :  ?cp=59140   ou   ?lat=51.03&lon=2.37  (centre de la carte)
//  Sortie :  JSON — commune, météo prévue + vigilance du jour J,
//            événements susceptibles de perturber la mission (presse filtrée), synthèse IA.
//
//  Secrets à créer dans Cloudflare (Settings → Variables and Secrets) :
//    METEOFRANCE_KEY    clé API « Données Publiques Vigilance » (portail-api.meteofrance.fr)
//    ANTHROPIC_API_KEY  facultatif — clé console.anthropic.com (meilleure analyse, payante)
//  Sans clé Anthropic, l'IA gratuite de Cloudflare (binding AI) fait le tri.
//    TEST_MODE          facultatif — "1" pour tester l'URL dans un navigateur
//  Chaque source est indépendante : sans sa clé, elle est simplement marquée
//  « non configuré » et le reste fonctionne.
// =====================================================================

const ALLOWED_ORIGINS = ['https://prkbrt362-lgtm.github.io'];
const MODEL = 'claude-haiku-5-5';
const AI_MODEL = '@cf/google/gemma-4-26b-a4b-it'; // modèle gratuit de Cloudflare (offre Workers Free)
const CACHE_SECONDS = 600; // 10 min : limite le coût et la charge sur les sources

// Familles d'événements pouvant nuire au déroulé d'une mission (requête presse + filtre sur le titre)
const CATEGORIES = [
  { label: 'Grève / transports', days: 14,
    q: '(grève OR préavis OR "mouvement social" OR "trafic perturbé" OR perturbations) (tram OR tramway OR bus OR métro OR transports OR réseau OR TER OR trains)',
    t: /gr[eè]v|pr[ée]avis|mouvement social|perturb|trafic|tram|bus|m[ée]tro|transport|r[ée]seau|ter\b|sncf/ },
  { label: 'Manifestation / ordre public', days: 14,
    q: 'manifestation OR manifestants OR rassemblement OR "appel à manifester" OR cortège OR blocage OR émeutes OR "violences urbaines" OR "interdiction de manifester"',
    t: /manif|rassembl|cort[èe]ge|blocage|bloqu|[ée]meute|violences urbaines|mobilisation|interdiction/ },
  { label: 'Événement majeur', days: 21,
    q: 'match OR concert OR festival OR salon OR foire OR braderie OR marathon OR "visite présidentielle" OR "visite du président" OR "visite ministérielle" OR "visite du ministre" OR "fan zone" OR sommet',
    t: /match|concert|festival|salon|foire|braderie|marathon|semi-marathon|course|visite|pr[ée]sident|ministre|fan zone|sommet|c[ée]r[ée]monie|spectacle|f[eê]te/ },
  { label: 'Circulation / fermeture', days: 14,
    q: '"route coupée" OR "circulation interdite" OR "stationnement interdit" OR fermeture OR déviation OR travaux OR "arrêté préfectoral" OR "périmètre de sécurité"',
    t: /coup[ée]|interdi|fermetur|ferm[ée]|d[ée]viation|travaux|arr[êe]t[ée] pr[ée]fectoral|p[ée]rim[èe]tre|bouchon|circulation|stationnement/ },
  { label: 'Sécurité', days: 3,
    q: 'attentat OR "alerte à la bombe" OR évacuation OR fusillade OR "coups de feu" OR "règlement de comptes" OR "colis suspect"',
    t: /attentat|bombe|[ée]vacu|fusillade|coups de feu|r[èe]glement de comptes|colis suspect|alerte/ }
];

// Réseaux de transport urbain : leur nom apparaît souvent seul dans les titres (« Grève TBM jeudi »)
const RESEAUX = {
  'Bordeaux': 'TBM', 'Toulouse': 'Tisséo', 'Lyon': 'TCL', 'Marseille': 'RTM', 'Lille': 'Ilévia', 'Nantes': 'Naolib',
  'Rennes': 'STAR', 'Strasbourg': 'CTS', 'Montpellier': 'TaM', 'Nice': "Lignes d'Azur", 'Paris': 'RATP',
  'Grenoble': 'M réso', 'Toulon': 'Réseau Mistral', 'Rouen': 'Astuce', 'Saint-Étienne': 'STAS', 'Dijon': 'Divia',
  'Angers': 'Irigo', 'Brest': 'Bibus', 'Reims': 'Citura', 'Le Havre': 'LiA', 'Tours': 'Fil Bleu', 'Orléans': 'TAO',
  'Clermont-Ferrand': 'T2C', 'Metz': 'Le Met', 'Nancy': 'Stan', 'Caen': 'Twisto', 'Limoges': 'STCL',
  'Amiens': 'Ametis', 'Perpignan': 'Sankéo', 'Besançon': 'Ginko', 'Mulhouse': 'Soléa', 'Avignon': 'Orizo',
  'Nîmes': 'Tango', 'Le Mans': 'Setram', 'Poitiers': 'Vitalis', 'Pau': 'Idelis', 'Bayonne': 'Txik Txak',
  'Dunkerque': 'DK Bus', 'Valenciennes': 'Transvilles', 'Annecy': 'Sibra', 'La Rochelle': 'Yélo'
};
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
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

    const [vigilance, presse, prevision] = await Promise.all([
      safe(() => getVigilance(dep, env)),
      safe(() => getPresse(c.nom, date)),
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
      vigilance,
      presse: articles,
      reseau: presse.reseau || ''
    };
    const synthese = await safe(() => getSynthese(base, env));

    const body = {
      ...base,
      synthese,
      sources: {
        'Prévisions': prevision.statut,
        'Vigilance': vigilance.statut,
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

// ---------- 5. Presse : événements pouvant perturber la mission, repérage du jour J ----------
function marqueJourJ(titre, pub, date) {
  const d = new Date(date + 'T12:00:00Z');
  const jour = d.getUTCDate(), mois = MOIS[d.getUTCMonth()], wd = JOURS[d.getUTCDay()];
  const t = ' ' + titre.toLowerCase().replace(/[’']/g, ' ') + ' ';
  if (new RegExp('[^0-9]' + jour + '(er)? ' + mois).test(t)) return true;          // « 5 novembre »
  const p = Date.parse(pub);
  const ecart = isNaN(p) ? 99 : (d.getTime() - p) / 86400000;                     // jours entre publication et jour J
  if (ecart >= -0.5 && ecart <= 6.5 && new RegExp('[^a-zé]' + wd + '[^a-zé]').test(t)) return true; // « jeudi » dans la semaine
  if (ecart >= 0.5 && ecart <= 1.5 && /demain/.test(t)) return true;
  if (ecart >= -0.5 && ecart <= 0.5 && /aujourd hui|ce matin|ce soir|en ce moment|actuellement/.test(t)) return true;
  return false;
}
async function getPresse(ville, date) {
  const diag = [];
  const reseau = RESEAUX[ville];
  const reqs = CATEGORIES.map(c => ({ c, q: '"' + ville + '" (' + c.q + ')' }));
  if (reseau) reqs.push({ c: CATEGORIES[0], q: '"' + reseau + '" (grève OR préavis OR perturbations OR "mouvement social" OR "trafic perturbé")', reseau: true });
  // 1) Google Actualités (cookie de consentement pour éviter la page RGPD en Europe)
  let lists = await Promise.all(reqs.map(r =>
    rss('https://news.google.com/rss/search?q=' + encodeURIComponent(r.q + ' when:' + r.c.days + 'd') + '&hl=fr&gl=FR&ceid=FR:fr', 'source')));
  let n = lists.reduce((a, l) => a + l.items.length, 0);
  diag.push('Google ' + (n ? n : (lists[0].err || '0')));
  // 2) Repli : Bing Actualités
  if (!n) {
    lists = await Promise.all(reqs.map(r =>
      rss('https://www.bing.com/news/search?format=rss&setlang=fr-FR&cc=FR&qft=interval%3d%229%22&q=' + encodeURIComponent(r.q), 'News:Source')));
    n = lists.reduce((a, l) => a + l.items.length, 0);
    diag.push('Bing ' + (n ? n : (lists[0].err || '0')));
  }
  const seen = new Set();
  const items = [];
  lists.forEach((l, i) => {
    const { c, reseau: viaReseau } = reqs[i];
    const limite = Date.now() - (c.days + 1) * 86400000;
    l.items.forEach(a => {
      if (!a.titre) return;
      const t = Date.parse(a.date);
      if (!isNaN(t) && t < limite) return;
      const tl = a.titre.toLowerCase();
      if (!c.t.test(tl)) return;                                     // titre hors sujet → écarté
      if (/nécrolog|obsèques|décès de|résultat du match|score|mercato|recette|horoscope/.test(tl)) return;
      const k = tl.replace(/[^a-z0-9àâçéèêëîïôûùüÿ]/g, '');
      if (seen.has(k)) return;
      seen.add(k);
      items.push({ ...a, cat: c.label, jourJ: marqueJourJ(a.titre, a.date, date), viaReseau: !!viaReseau });
    });
  });
  // Jour J d'abord, puis les plus récents
  items.sort((x, y) => (y.jourJ - x.jourJ) || ((Date.parse(y.date) || 0) - (Date.parse(x.date) || 0)));
  return { statut: items.length ? 'ok' : 'rien trouvé (' + diag.join(', ') + ')', items: items.slice(0, 30), reseau: reseau || '' };
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
  if (!env.ANTHROPIC_API_KEY && !env.AI) return { statut: 'non configuré' };
  const presse = d.presse.map((a, i) => '[' + (i + 1) + '] (' + a.cat + ') publié le ' + a.date + ' — ' + a.titre + ' — ' + a.source).join('\n') || 'aucun article';
  const per = d.vigilance.statut === 'ok' ? (d.vigilance.periodes || []).find(p => p.date === d.dateMission) : null;
  const vig = per
    ? per.phenomenes.filter(p => p.couleur >= 2).map(p => p.nom + ' niveau ' + ['', 'vert', 'jaune', 'orange', 'rouge'][p.couleur]).join(', ') || 'aucune'
    : 'pas encore publiée pour cette date (publication la veille)';
  const pv = d.prevision.statut === 'ok'
    ? d.prevision.temps + ', ' + d.prevision.tmin + ' à ' + d.prevision.tmax + ' °C, pluie ' + d.prevision.pluie_mm + ' mm' + (d.prevision.pluie_proba != null ? ' (' + d.prevision.pluie_proba + ' %)' : '') + ', rafales ' + d.prevision.rafales_kmh + ' km/h, lever ' + d.prevision.lever + ', coucher ' + d.prevision.coucher
    : 'indisponible';

  const prompt =
`Tu es analyste sûreté. Une équipe d'enquêteurs privés prépare une mission discrète d'observation sur la voie publique à ${d.ville} (${d.departement}) le ${d.dateMission} (${JOURS[new Date(d.dateMission + 'T12:00:00Z').getUTCDay()]}). Aujourd'hui : ${parisDate(new Date())}.${d.reseau ? ' Le réseau de transport urbain local s\'appelle ' + d.reseau + '.' : ''}

PRIORITÉ : ce qui est PRÉVU ou ATTENDU le jour de la mission (manifestations annoncées, préavis de grève, matchs, événements, travaux, visites officielles, arrêtés). Les articles décrivent souvent des événements à venir : déduis leur date à partir du texte et de la date de publication. Les faits passés ne servent que de contexte (tensions persistantes, dispositif policier en place).

Ne retiens QUE ce qui peut nuire au déroulé de la mission : grèves de transports (bus, tram, métro, trains), manifestations, blocages, foules (matchs, concerts, salons), visites officielles et dispositifs policiers, fermetures de routes, menaces, météo défavorable. Tout le reste est hors sujet.

Règles strictes :
- Utilise UNIQUEMENT les éléments ci-dessous. N'invente rien.
- Ignore les articles hors sujet (résultats sportifs, nécrologies, faits divers clos, homonymes d'autres villes, événements terminés avant le jour J).
- "garder" = numéros des seuls articles utiles à l'équipe pour le jour J.
- Ne place dans "a_venir" que des événements dont la date tombe le jour de la mission ou la veille, ou dont la date est incertaine mais plausible ; indique "date à confirmer" dans ce cas.
- Chaque point cite les numéros d'articles [n] qui le fondent.
- Si rien de significatif : niveau "vert" et précise que l'absence d'information ne garantit pas l'absence de risque.
- Niveau : "vert" (RAS), "orange" (à intégrer au dispositif), "rouge" (mission à reconsidérer ou à adapter fortement).

PRÉVISION MÉTÉO DU JOUR J : ${pv}
VIGILANCE MÉTÉO DU JOUR J : ${vig}
PRESSE (catégorie, date de publication, titre) :
${presse}

Réponds uniquement avec ce JSON, sans texte autour :
{"niveau":"vert|orange|rouge","synthese":"2 à 3 phrases centrées sur le jour J","garder":[1,3],"a_venir":[{"quand":"date/heure ou 'date à confirmer'","quoi":"...","impact":"conséquence pour l'équipe","refs":[1]}],"contexte":[{"categorie":"...","texte":"...","refs":[2]}]}`;

  let txt = '', moteur = '';
  if (env.ANTHROPIC_API_KEY) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1400, messages: [{ role: 'user', content: prompt }] })
    });
    if (r.ok) { const j = await r.json(); txt = (j.content || []).map(b => b.text || '').join(''); moteur = 'Claude'; }
  }
  if (!txt && env.AI) {                                   // IA gratuite Cloudflare (10 000 neurones/jour)
    const o = await env.AI.run(AI_MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 1400, temperature: 0.2 });
    txt = typeof o === 'string' ? o
      : (o && typeof o.response === 'string') ? o.response
      : (o && o.response && typeof o.response === 'object') ? JSON.stringify(o.response)
      : (o && o.choices && o.choices[0] && o.choices[0].message) ? (o.choices[0].message.content || '') : '';
    moteur = 'Cloudflare';
  }
  if (!txt) return { statut: 'indisponible' };
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { statut: 'réponse illisible' };
  const o = JSON.parse(m[0]);
  const niveau = ['vert', 'orange', 'rouge'].includes(o.niveau) ? o.niveau : 'orange';
  return {
    statut: 'ok', moteur, niveau, synthese: String(o.synthese || ''),
    garder: Array.isArray(o.garder) ? o.garder.map(Number).filter(x => x >= 1) : null,
    a_venir: Array.isArray(o.a_venir) ? o.a_venir.slice(0, 8) : [],
    points: Array.isArray(o.contexte) ? o.contexte.slice(0, 6) : []
  };
}
