'use strict';

// Listing detail inspection (keywords, BER, heating text) + vision photo
// analysis for heating cues (gas boiler, plumbed wet radiators vs electric
// storage/panel heaters) and visible property condition.

const { crm, now } = require('../db');
const { enqueueModelJob } = require('../../model');
const { imageMime } = require('../../subscription-agent');
const daft = require('./daft');

const FEATURE = 'crm_house_photos';
const VERSION = 1;
const MAX_PHOTOS = 8;
const MAX_TOTAL_BYTES = 2_400_000;

const PHOTO_PROMPT = `You inspect Irish residential property listing photos for Douglas McLellan.
Douglas strongly prefers gas central heating (or properly plumbed wet radiators) and wants honest, grounded visual observations — never guess what you cannot see.

Look carefully across ALL provided photos (numbered 1..N in order) for:
1. Heating clues:
   - Wall-mounted gas boiler (often in kitchen, utility room, hot press, or hallway — white box with flue/pipes beneath).
   - Plumbed wet central-heating radiators (steel panel radiators with copper/white pipes entering at bottom corners and a thermostatic radiator valve / TRV) vs electric storage heaters (thick boxy off-white units with top vents/dials, plugged into a fused wall spur, no pipes) vs slim electric panel heaters (flat white wall panels plugged into a spur).
   - Gas hob or gas fire (helpful secondary clue that mains gas is connected, though not proof of gas central heating on its own).
   - Underfloor heating manifolds or heat pump outdoor units.
2. Condition & price-relevant visual cues:
   - Overall condition: "turnkey", "good", "dated", or "needs_work".
   - Specific visible observations that affect price (modern vs dated kitchen/bathrooms, double/triple glazing vs old single glazing, visible damp/mould/cracks, floor finish, natural light, garden/balcony state).

Return JSON only:
{
  "heating_verdict": "gas_likely" | "wet_radiators_visible" | "electric_visible" | "heat_pump_or_underfloor" | "unclear",
  "heating_confidence": "high" | "medium" | "low",
  "heating_summary": "One plain sentence summarising what the photos show about heating.",
  "heating_evidence": [{"photo": 1, "room": "Kitchen", "observation": "White wall-mounted gas boiler visible beside upper cabinets"}],
  "condition": "turnkey" | "good" | "dated" | "needs_work" | "unclear",
  "condition_summary": "One or two plain sentences on visible condition and finish.",
  "notes": ["Short factual observation relevant to price or viewing"]
}`;

function parseJson(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

function extractJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Photo reader returned non-JSON output');
  return JSON.parse(s.slice(start, end + 1));
}

function normalisePhotoResult(raw) {
  const verdicts = new Set(['gas_likely', 'wet_radiators_visible', 'electric_visible', 'heat_pump_or_underfloor', 'unclear']);
  const confs = new Set(['high', 'medium', 'low']);
  const conds = new Set(['turnkey', 'good', 'dated', 'needs_work', 'unclear']);
  const verdict = verdicts.has(raw?.heating_verdict) ? raw.heating_verdict : 'unclear';
  const confidence = confs.has(raw?.heating_confidence) ? raw.heating_confidence : 'low';
  const condition = conds.has(raw?.condition) ? raw.condition : 'unclear';
  const evidence = Array.isArray(raw?.heating_evidence)
    ? raw.heating_evidence.slice(0, 10).map(e => ({
      photo: Number.isInteger(Number(e?.photo)) ? Number(e.photo) : null,
      room: String(e?.room || '').trim().slice(0, 80),
      observation: String(e?.observation || '').trim().slice(0, 260),
    })).filter(e => e.observation)
    : [];
  const notes = Array.isArray(raw?.notes)
    ? raw.notes.slice(0, 8).map(n => String(n || '').trim().slice(0, 260)).filter(Boolean)
    : [];
  return {
    heating_verdict: verdict,
    heating_confidence: confidence,
    heating_summary: String(raw?.heating_summary || '').trim().slice(0, 400),
    heating_evidence: evidence,
    condition,
    condition_summary: String(raw?.condition_summary || '').trim().slice(0, 500),
    notes,
  };
}

function hydrate(row) {
  if (!row) return null;
  const heating = parseJson(row.heating_text, null) || { kind: 'unlisted', label: 'Heating not stated in listing text', quote: '' };
  return {
    property_id: row.property_id,
    url: row.url,
    fetched_at: row.fetched_at,
    property_type: row.property_type,
    ber: row.ber,
    baths: row.baths,
    selling_type: row.selling_type,
    date_of_construction: row.date_of_construction,
    description: row.description,
    features: parseJson(row.features_json, []),
    facilities: parseJson(row.facilities_json, []),
    signals: parseJson(row.signals_json, []),
    heating,
    images: parseJson(row.images_json, []),
    photo_status: row.photo_status,
    photo_job_id: row.photo_job_id,
    photo_queued_at: row.photo_queued_at,
    photo_result: row.photo_result_json ? parseJson(row.photo_result_json, null) : null,
    photo_error: row.photo_error,
    photo_model: row.photo_model,
    updated_at: row.updated_at,
  };
}

function collect(propertyId, { jobs = require('../../subscription-agent-jobs'), t = now() } = {}) {
  const db = crm();
  const row = db.prepare('SELECT * FROM house_listing_analysis WHERE property_id = ?').get(propertyId);
  if (!row) return null;
  if (row.photo_status === 'waiting' && row.photo_job_id) {
    const job = jobs.getJob(row.photo_job_id);
    if (job?.status === 'completed') {
      try {
        const parsed = normalisePhotoResult(extractJsonObject(job.result?.output));
        const model = [job.result?.meta?.runner, job.result?.meta?.model].filter(Boolean).join('/');
        db.prepare(`UPDATE house_listing_analysis
          SET photo_status = 'done', photo_result_json = ?, photo_error = '', photo_model = ?, updated_at = ?
          WHERE property_id = ?`).run(JSON.stringify(parsed), model, t, propertyId);
      } catch (err) {
        db.prepare(`UPDATE house_listing_analysis
          SET photo_status = 'failed', photo_error = ?, updated_at = ?
          WHERE property_id = ?`).run(`Photo reader returned an unusable reply: ${err.message}`.slice(0, 300), t, propertyId);
      }
    } else if (!job || job.status === 'failed') {
      const err = job?.error || 'The photo analysis job did not complete.';
      db.prepare(`UPDATE house_listing_analysis
        SET photo_status = 'failed', photo_error = ?, updated_at = ?
        WHERE property_id = ?`).run(String(err).slice(0, 300), t, propertyId);
    }
    return hydrate(db.prepare('SELECT * FROM house_listing_analysis WHERE property_id = ?').get(propertyId));
  }
  return hydrate(row);
}

function get(property, opts = {}) {
  if (!property?.id) return null;
  return collect(property.id, opts);
}

// Pick evenly spaced photos across the listing (interior rooms, kitchen,
// living room, bedrooms, utility) rather than only the first few exteriors.
function pickPhotos(images, max = MAX_PHOTOS) {
  if (!Array.isArray(images) || !images.length) return [];
  if (images.length <= max) return images;
  const picked = [];
  const step = (images.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    picked.push(images[Math.round(i * step)]);
  }
  return picked;
}

function queuePhotoAnalysis(property, documents, { context = '', jobs = require('../../subscription-agent-jobs'), t = now() } = {}) {
  const db = crm();
  const prompt = [
    `Property: ${property.title}${property.address && property.address !== property.title ? ` (${property.address})` : ''}`,
    context,
    `Inspect all ${documents.length} attached photos (numbered 1 to ${documents.length}) for heating clues (gas boiler, plumbed wet radiators/pipes/TRVs vs electric storage/panel heaters) and visible condition.`,
  ].filter(Boolean).join('\n');

  const { jobId } = enqueueModelJob({
    feature: FEATURE,
    dedupeKey: `house-photos:v${VERSION}:${property.id}:${t}`,
    systemPrompt: PHOTO_PROMPT,
    userPrompt: prompt,
    documents,
    meta: { housePhotos: property.id },
  }, jobs);

  db.prepare(`INSERT INTO house_listing_analysis (property_id, url, photo_status, photo_job_id, photo_queued_at, photo_error, updated_at)
    VALUES (?, ?, 'waiting', ?, ?, '', ?)
    ON CONFLICT(property_id) DO UPDATE SET
      photo_status = 'waiting', photo_job_id = excluded.photo_job_id, photo_queued_at = excluded.photo_queued_at,
      photo_error = '', updated_at = excluded.updated_at`).run(property.id, property.url || '', jobId, t, t);

  return hydrate(db.prepare('SELECT * FROM house_listing_analysis WHERE property_id = ?').get(property.id));
}

async function inspect(property, {
  analyzePhotos = true,
  fetchListing = daft.fetchListing,
  fetchImage = daft.fetchImageBuffer,
  jobs = require('../../subscription-agent-jobs'),
  t = now(),
} = {}) {
  if (!property?.url || !/^https:\/\/(?:www\.)?daft\.ie\/for-sale\//i.test(property.url)) {
    throw new Error('Add a Daft.ie for-sale link on this property first, or upload listing photos below.');
  }
  const listing = await fetchListing(property.url);
  const { signals, heating } = daft.extractSignals(listing);

  const db = crm();
  // Also fill blank beds/area/asking_price on the property if missing.
  const updates = [];
  const params = [];
  if (property.asking_price == null && listing.asking_price != null) { updates.push('asking_price = ?'); params.push(listing.asking_price); }
  if (property.beds == null && listing.beds != null) { updates.push('beds = ?'); params.push(listing.beds); }
  if (property.area == null && listing.area != null) { updates.push('area = ?'); params.push(listing.area); }
  if (updates.length) {
    params.push(t, property.id);
    db.prepare(`UPDATE house_properties SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);
  }

  const prev = db.prepare('SELECT photo_status, photo_job_id, photo_queued_at, photo_result_json, photo_error, photo_model FROM house_listing_analysis WHERE property_id = ?').get(property.id);
  db.prepare(`INSERT INTO house_listing_analysis (
      property_id, url, fetched_at, property_type, ber, baths, selling_type, date_of_construction,
      description, features_json, facilities_json, signals_json, heating_text, images_json,
      photo_status, photo_job_id, photo_queued_at, photo_result_json, photo_error, photo_model, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(property_id) DO UPDATE SET
      url=excluded.url, fetched_at=excluded.fetched_at, property_type=excluded.property_type,
      ber=excluded.ber, baths=excluded.baths, selling_type=excluded.selling_type,
      date_of_construction=excluded.date_of_construction, description=excluded.description,
      features_json=excluded.features_json, facilities_json=excluded.facilities_json,
      signals_json=excluded.signals_json, heating_text=excluded.heating_text,
      images_json=excluded.images_json, updated_at=excluded.updated_at`).run(
    property.id, listing.url || property.url, t, listing.property_type, listing.ber, listing.baths,
    listing.selling_type, listing.date_of_construction, listing.description.slice(0, 12000),
    JSON.stringify(listing.features), JSON.stringify(listing.facilities),
    JSON.stringify(signals), JSON.stringify(heating), JSON.stringify(listing.images.slice(0, 24)),
    prev?.photo_status || 'idle', prev?.photo_job_id || null, prev?.photo_queued_at || null,
    prev?.photo_result_json || null, prev?.photo_error || '', prev?.photo_model || '', t,
  );

  if (analyzePhotos) {
    const selected = pickPhotos(listing.images, MAX_PHOTOS);
    const docs = [];
    let totalBytes = 0;
    for (const img of selected) {
      // Prefer size1200x1200 for boiler/radiator clarity; fall back to thumb if large.
      for (const candidateUrl of [img.url, img.thumb].filter((v, i, a) => v && a.indexOf(v) === i)) {
        try {
          const buf = await fetchImage(candidateUrl);
          const mime = imageMime(buf);
          if (!mime) continue;
          if (totalBytes + buf.length > MAX_TOTAL_BYTES) continue;
          docs.push({ type: 'image', mime, data: buf.toString('base64') });
          totalBytes += buf.length;
          break;
        } catch {
          // Try next image size or continue to remaining photos.
        }
      }
    }
    if (!docs.length) {
      db.prepare(`UPDATE house_listing_analysis SET photo_status = 'no_photos', photo_error = 'No readable listing photos could be downloaded.', updated_at = ? WHERE property_id = ?`)
        .run(t, property.id);
    } else {
      const ctx = [
        listing.property_type && `Type: ${listing.property_type}`,
        listing.ber && `BER: ${listing.ber}`,
        `Heating in listing text: ${heating.label}`,
      ].filter(Boolean).join(' · ');
      return queuePhotoAnalysis(property, docs, { context: ctx, jobs, t });
    }
  }

  return hydrate(db.prepare('SELECT * FROM house_listing_analysis WHERE property_id = ?').get(property.id));
}

function analyzeUploadedPhotos(property, files, { jobs = require('../../subscription-agent-jobs'), t = now() } = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error('Choose at least one photo (JPEG, PNG or WebP).');
  const docs = [];
  let totalBytes = 0;
  for (const f of files.slice(0, MAX_PHOTOS)) {
    const buf = f?.buffer;
    if (!Buffer.isBuffer(buf) || !buf.length) continue;
    const mime = imageMime(buf);
    if (!mime) throw new Error(`${f.originalname || 'File'} is not a PNG, JPEG or WebP photo.`);
    if (totalBytes + buf.length > MAX_TOTAL_BYTES) throw new Error('Selected photos exceed the 2.4 MB total upload limit. Choose fewer or smaller photos.');
    docs.push({ type: 'image', mime, data: buf.toString('base64') });
    totalBytes += buf.length;
  }
  if (!docs.length) throw new Error('Choose at least one valid photo.');
  return queuePhotoAnalysis(property, docs, { context: 'Photos uploaded by Douglas for heating & condition inspection.', jobs, t });
}

module.exports = {
  FEATURE,
  PHOTO_PROMPT,
  get,
  collect,
  inspect,
  analyzeUploadedPhotos,
  normalisePhotoResult,
  pickPhotos,
};
