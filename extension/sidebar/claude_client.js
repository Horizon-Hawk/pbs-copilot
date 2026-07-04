// Claude API client — parses plain English preferences into a flat preference object,
// then deterministic JS translates that into a NavBlue bid model.

const SYSTEM_PROMPT = `You are a PBS bid preference parser for Horizon Air (QXE) NavBlue.
Extract the pilot's plain English preferences into this exact JSON schema.
Return ONLY the JSON object — no markdown, no explanation.

{
  "trip_lengths": [],         // ordered preferred lengths e.g. [4,3]. Empty = no preference.
  "checkin_after": null,      // "HH:MM" string or null
  "checkin_before": null,     // "HH:MM" — avoid check-in before this time. null = no constraint.
  "avoid_redeyes": false,
  "layover_prefer": [],       // station codes e.g. ["SFO","LAX"]
  "layover_avoid": [],        // 3-letter station codes to avoid ENTIRELY — as a layover OR a
                              // landing/departure. "avoid landings in YVR, YYJ" -> ["YVR","YYJ"]
  "min_days_between": null,   // min days OFF required between trips e.g. "2 days off between
                              // trips" -> 2. null = no spacing requirement.
  "tafb_max_hours": null,     // number — max hours away from base. null = no limit.
  "high_daily_credit": false, // true = prefer trips with high credit per day worked
  "specific_pairings": [],    // explicitly named pairing numbers e.g. ["G3027","G3043"]
  "depart_days": [],          // ONLY if pilot explicitly says to START trips on specific days
                              // e.g. "start trips on Tuesdays" -> ["Tuesday"]
                              // "weekends off" does NOT go here — leave empty.
  "fallback_tiers": false,    // true ONLY if pilot says "if I can't get X, give me Y"
  "line_conditions": [],      // PBS "set condition" line rules. Each item = {"key": <EXACT key below>}
                              // plus value fields for VALUED keys. Use ONLY these exact keys:
                              //  VALUED (include the number):
                              //   {"key":"TimeBetweenPairings","hours":48}  = min base layover / rest between trips
                              //        ("minimum base layover 48hrs", "48h between pairings", "2 days between trips" -> hours:48)
                              //   {"key":"MaximumDaysOn","days":5}          ("max 5 days on")
                              //   {"key":"MinimumDaysOff","days":2}         ("min 2 days off")
                              //   {"key":"TotalDaysOffInPeriod","days":14}  ("14 days off this month")
                              //  SIMPLE (no value — use exact key, no number):
                              //   MinimumCredit  ("minimum credit window" with NO number), MaximumCredit, MidCredit,
                              //   MinimumThreshold, OverSked, GDOCondition, MinimumGDO, MaxAbove, NoSameDayPairings,
                              //   NoSameDayDutyStarts, OneDayOffInSeven, BaseRest, MinimumTwoDaysOff, MinimumTwoDaysOn,
                              //   MinimumConsecutiveDaysOff, TwoConsecutiveDaysOffInSeven, TwentyFourHoursOffInSevenDays,
                              //   FortyEightHoursOffInSevenDays, FourDaysOffInFourteen, BlockOfThreeDaysOff,
                              //   BlockOfFourDaysOff, MaxDaysOnFive, Max30In7, MaxDutyDaysPerBidPeriod,
                              //   TwelveHourRequiredRest, RequiredTenHourRest, CalendarDayFreeFromDuty
                              //        -> e.g. {"key":"FortyEightHoursOffInSevenDays"}
                              // If a requested condition is NOT one of these exact keys, DO NOT guess — put the
                              // pilot's phrase in "unsupported".
  "unsupported": []           // VERBATIM list of any request part you could NOT represent with a field
                              // above (including line conditions not in the list). NEVER silently drop.
}

Rules:
- "weekends off" / "home on weekends" / "prefer weekends off" -> leave depart_days empty. The system handles this automatically.
- depart_days is ONLY for explicit departure day requests like "I want to start trips on Tuesdays".
- Default fallback_tiers: false (one group) unless pilot explicitly asks for tiers or fallbacks.
- trip_lengths: order most preferred first e.g. "prefer 4-day, ok with 3-day" -> [4, 3]
- checkin_after: use the latest stated time e.g. "no early shows" -> "10:00", "afternoons only" -> "12:00"`;


function toMinutes(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':').map(Number);
  return parts[0] * 60 + (parts[1] || 0);
}

// NavBlue credit/TAFB values arrive as integer MINUTES ("908" = 15h08min), not "HH:MM".
// Accept both: a value containing ':' is HH:MM; otherwise it's whole minutes.
function creditMinutes(val) {
  if (val == null || val === '') return 0;
  const s = String(val).trim();
  if (s.includes(':')) {
    const [h, m] = s.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

// ── Date-aware trip selection ─────────────────────────────────────────────────
// All helpers are defensive: a missing/malformed date returns null/false, never throws
// "Invalid time value" (which happens when toISOString() runs on an unparseable Date).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isoAddDays(iso, n) {
  if (!ISO_DATE.test(iso)) return null;
  const t = Date.parse(iso + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}
function isoDiffDays(a, b) {
  const ta = Date.parse(a + 'T00:00:00Z'), tb = Date.parse(b + 'T00:00:00Z');
  return (Number.isNaN(ta) || Number.isNaN(tb)) ? NaN : Math.round((ta - tb) / 86400000);
}
function tripSpan(p) {
  // dates must be an ARRAY of ISO strings — guard against a string slipping through (p.dates[0]
  // on a string returns a single char and produces an invalid Date downstream).
  const rawStart = p.start || (Array.isArray(p.dates) ? p.dates[0] : null) || null;
  const start = ISO_DATE.test(rawStart || '') ? rawStart : null;
  const len = parseInt(p.length) || 1;
  const rawEnd = ISO_DATE.test(p.end || '') ? p.end : null;
  const end = rawEnd || (start ? isoAddDays(start, len - 1) : null);
  return { start, end, len };
}
function touchesWeekend(p) {
  const { start, len } = tripSpan(p);
  if (!start) return false;
  const t0 = Date.parse(start + 'T00:00:00Z');
  if (Number.isNaN(t0)) return false;
  for (let i = 0; i < len; i++) {
    const w = new Date(t0 + i * 86400000).getUTCDay();
    if (w === 0 || w === 6) return true;
  }
  return false;
}
function pairingCities(p) {
  return (p.stations && p.stations.length ? p.stations : [...(p.landings || []), ...(p.layovers || [])])
    .map(s => (s || '').toUpperCase());
}

// Hard filters that must NEVER be violated: trip length, avoided cities (landing or layover),
// and red-eyes when the pilot said to avoid them.
export function filterCandidates(pairings, { lengths = null, avoidCities = [], avoidRedeye = false } = {}) {
  const lens = lengths?.length ? lengths.map(Number) : null;
  const avoid = new Set((avoidCities || []).map(c => (c || '').toUpperCase()));
  return (pairings || []).filter(p => p.number)
    .filter(p => !lens || lens.includes(parseInt(p.length)))
    .filter(p => !avoidRedeye || !p.redeye)
    .filter(p => !avoid.size || !pairingCities(p).some(s => avoid.has(s)));
}

// Can `p` be added to already-chosen trips without overlapping and while keeping
// >= minGap days OFF between consecutive trips? (No date info -> allow.)
function fitsSpacing(p, chosen, minGap) {
  const a = tripSpan(p);
  if (!a.start) return true;
  for (const c of chosen) {
    const b = tripSpan(c);
    if (!b.start) continue;
    if (a.start <= b.end && b.start <= a.end) return false;                 // overlap
    const gap = a.start > b.end ? isoDiffDays(a.start, b.end) - 1 : isoDiffDays(b.start, a.end) - 1;
    if (gap < minGap) return false;                                          // too close
  }
  return true;
}

function isoDayNum(iso) { const t = Date.parse(iso + 'T00:00:00Z'); return Number.isNaN(t) ? null : Math.round(t / 86400000); }
function cmpScore(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

// Score a solution so higher is better. Reaching the credit floor wins first; among solutions
// that reach it, fewest days worked (max days off), then — if requested — fewest weekend trips,
// then credit as a buffer tiebreak. Shortfall solutions are ranked by how close they got.
function solScore(total, days, wknds, targetMinutes, preferWeekendsOff) {
  return total >= targetMinutes
    ? [1, -days, preferWeekendsOff ? -wknds : 0, total]
    : [0, total, -days, preferWeekendsOff ? -wknds : 0];
}

// Deterministic date-aware selection: maximize days off (fewest days worked) while reaching the
// credit target, keeping trips spaced >= minGap apart, non-overlapping, and (preferably) off
// weekends. Seeds with a greedy pass, then runs a hard-pruned exhaustive search (bounded by a node
// budget) to find the optimal spaced subset. Used as the validator / fallback for the API.
export function pickTripsForMaxDaysOff(candidates, { targetMinutes, minGap = 0, preferWeekendsOff = false } = {}) {
  const T = candidates.map(p => {
    const s = tripSpan(p);
    return { ref: p, _cMins: creditMinutes(p.credit), _days: parseInt(p.length) || 1,
             _wknd: touchesWeekend(p) ? 1 : 0, _s: s.start ? isoDayNum(s.start) : null, _e: s.end ? isoDayNum(s.end) : null };
  }).filter(p => p._cMins > 0 && p._s != null)
    .sort((a, b) => a._s - b._s || b._cMins - a._cMins);

  // Seed: greedy by credit-per-day to get an initial (usually target-reaching) solution fast.
  const seedOrder = [...T].sort((a, b) => (a._wknd - b._wknd) || (b._cMins / b._days - a._cMins / a._days));
  const seed = [];
  let seedTotal = 0;
  for (const p of seedOrder) {
    if (seedTotal >= targetMinutes) break;
    if (seed.every(c => !(p._s <= c._e && c._s <= p._e) && (p._s > c._e ? p._s - c._e - 1 : c._s - p._e - 1) >= minGap)) {
      seed.push(p); seedTotal += p._cMins;
    }
  }
  let best = { picks: seed.slice(), total: seedTotal,
               days: seed.reduce((s, p) => s + p._days, 0), wknds: seed.reduce((s, p) => s + p._wknd, 0) };
  let bestScore = solScore(best.total, best.days, best.wknds, targetMinutes, preferWeekendsOff);

  // Exhaustive spaced-subset search with pruning; bounded so it can never hang.
  let nodes = 0; const NODE_CAP = 300000;
  const cur = [];
  const dfs = (i, lastEnd, total, days, wknds) => {
    if (nodes++ > NODE_CAP) return;
    const score = solScore(total, days, wknds, targetMinutes, preferWeekendsOff);
    if (cmpScore(score, bestScore) > 0) { best = { picks: cur.slice(), total, days, wknds }; bestScore = score; }
    if (total >= targetMinutes) return;                       // reached: adding trips only worsens days
    if (bestScore[0] === 1 && days >= best.days) return;      // can't beat the min-days optimum
    for (let j = i; j < T.length; j++) {
      const p = T[j];
      if (lastEnd != null && p._s - lastEnd - 1 < minGap) continue;   // spacing vs latest end so far
      cur.push(p);
      dfs(j + 1, lastEnd == null ? p._e : Math.max(lastEnd, p._e), total + p._cMins, days + p._days, wknds + p._wknd);
      cur.pop();
    }
  };
  dfs(0, null, 0, 0, 0);

  const chosen = best.picks.slice().sort((a, b) => a._s - b._s);
  const h = Math.floor(best.total / 60), m = String(best.total % 60).padStart(2, '0');
  return {
    cherry_picks: chosen.map(p => p.ref.number),
    total_credit: `${h}:${m}`,
    trip_count: chosen.length,
    days_worked: best.days
  };
}

// Enforce hard spacing/overlap rules on an externally supplied pick list (e.g. the API's):
// keep only real candidates, in calendar order, dropping any that overlap or violate minGap.
export function enforcePicks(pickNumbers, candidates, { minGap = 0 } = {}) {
  const byNum = new Map(candidates.map(p => [p.number, p]));
  const inCal = pickNumbers.map(n => byNum.get(n)).filter(Boolean)
    .sort((a, b) => (tripSpan(a).start || '').localeCompare(tripSpan(b).start || ''));
  const kept = [];
  for (const p of inCal) if (fitsSpacing(p, kept, minGap)) kept.push(p);
  return kept.map(p => p.number);
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dowOf(iso) { const t = Date.parse(iso + 'T00:00:00Z'); return Number.isNaN(t) ? '?' : DOW[new Date(t).getUTCDay()]; }

// The intelligent bidder: give the model the full candidate table with the arithmetic it is bad
// at PRE-COMPUTED (day-of-week span, weekend flag, credit in H:MM), the credit floor, the hard
// rules, AND the pilot's raw request so it can honor soft preferences the schema can't capture.
// Returns { picks, reasoning }; the caller validates picks through enforcePicks + a credit check.
async function selectPicksViaApi(candidates, { targetHours, minGap, preferWeekendsOff, rawPreferences = '' }) {
  const rows = candidates.map(p => {
    const { start, end } = tripSpan(p);
    const cm = creditMinutes(p.credit);
    const ch = `${Math.floor(cm / 60)}:${String(cm % 60).padStart(2, '0')}`;
    const span = start && end ? `${start}→${end} (${dowOf(start)}–${dowOf(end)})` : '(no dates)';
    const wk = touchesWeekend(p) ? ' [WEEKEND]' : '';
    return `${p.number} | ${p.length}d | ${span}${wk} | credit ${ch}` +
           ` | lands ${(p.landings || []).join(',') || '-'} | layover ${(p.layovers || []).join(',') || '-'}`;
  }).join('\n');

  const sys = `You are an expert airline pilot building your monthly PBS bid. From the candidate pairings, choose the pairing NUMBERS to bid — a priority-ordered list — that best achieve the pilot's goals.

HARD RULES (never violate):
- Chosen trips must NOT overlap in dates.
- Leave at least ${minGap} day(s) OFF between the end of one chosen trip and the start of the next.
- Combined credit must reach at least ${targetHours} hours (each row shows credit as H:MM).

PRIMARY GOAL: maximize days off — work the FEWEST days while still clearing the credit floor.
${preferWeekendsOff ? 'STRONG PREFERENCE: avoid trips flagged [WEEKEND]; use one only if it is the only way to reach the credit floor.\n' : ''}Also honor any other preference in the pilot's request when choosing between otherwise-similar trips.

Reason briefly about spacing and credit, then output ONLY a JSON object as the final line:
{"picks":["G####",...],"reasoning":"<one sentence>"}`;

  const usr = `Pilot's request (honor soft preferences too): "${rawPreferences}"

Credit floor: at least ${targetHours}h.
Candidates — number | length | dates (day-of-week) | credit | landing cities | layover cities:
${rows}`;

  const result = await chrome.runtime.sendMessage({
    type: 'CLAUDE_REQUEST',
    payload: {
      model: 'claude-sonnet-5', max_tokens: 1500, system: sys,
      messages: [{ role: 'user', content: usr }]
    }
  });
  if (result?.error) throw new Error(result.error);
  const text = result.data.content?.[0]?.text || '';
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s === -1 || e === -1) return { picks: [], reasoning: '' };
  try {
    const obj = JSON.parse(text.slice(s, e + 1));
    return { picks: Array.isArray(obj.picks) ? obj.picks : [], reasoning: obj.reasoning || '' };
  } catch { return { picks: [], reasoning: '' }; }
}

// Deterministic translation: flat prefs object → bid model JSON for bid_builder.js
function buildBidModel(prefs, constants, creditContext) {
  function buildAvoids() {
    const avoids = [];
    if (prefs.avoid_redeyes) {
      avoids.push({ type: 'DutyIsRedeye' });
    }
    if (prefs.layover_avoid?.length) {
      avoids.push({ type: 'LayoverStations', stations: prefs.layover_avoid, match: 'Any' });
    }
    if (prefs.checkin_before) {
      avoids.push({ type: 'PairingCheckin', operator: 'LT', time: prefs.checkin_before });
    }
    return avoids;
  }

  function buildAwards(fixedLength) {
    const awards = [];
    if (fixedLength != null) {
      awards.push({ type: 'PairingLength', operator: 'EQ', days: fixedLength });
    } else if (prefs.trip_lengths?.length) {
      for (const len of prefs.trip_lengths) {
        awards.push({ type: 'PairingLength', operator: 'EQ', days: len });
      }
    }
    if (prefs.checkin_after) {
      awards.push({ type: 'PairingCheckin', operator: 'GT', time: prefs.checkin_after });
    }
    if (prefs.layover_prefer?.length) {
      awards.push({ type: 'LayoverStations', stations: prefs.layover_prefer, match: 'Any' });
    }
    if (prefs.tafb_max_hours != null) {
      const h = String(Math.floor(prefs.tafb_max_hours)).padStart(3, '0');
      awards.push({ type: 'TimeAwayFromBase', operator: 'LT', time: `${h}:00` });
    }
    if (prefs.high_daily_credit) {
      awards.push({ type: 'AverageDailyCredit', operator: 'GT', time: '5:30' });
    }
    if (prefs.depart_days?.length) {
      awards.push({ type: 'DepartOnDayOfWeek', days: prefs.depart_days });
    }
    return awards;
  }

  function makeGroup(name, fixedLength, specific, elseNext) {
    return {
      name,
      waives: [],
      avoid_pairings: buildAvoids(),
      award_pairings: buildAwards(fixedLength),
      specific_pairings: specific || [],
      cssn: false,
      else_start_next: elseNext
    };
  }

  const hasCherry = creditContext?.cherry_picks?.length > 0 || prefs.specific_pairings?.length > 0;
  const hasTiers = prefs.fallback_tiers && prefs.trip_lengths?.length > 1;
  const bid_groups = [];

  if (hasCherry) {
    const cherryNums = creditContext?.cherry_picks?.length
      ? creditContext.cherry_picks
      : (prefs.specific_pairings || []);
    const groupName = creditContext
      ? `Target ${creditContext.remaining_hours}h — Cherry-picks`
      : 'Cherry-picked pairings';
    // Single editable group only. Do NOT add a second empty "fallback" group — an
    // editable pairing group with no editable bid lines is rejected by NavBlue (501),
    // and the trailing built-in SysGen fallback groups already award-anything / go reserve.
    // This matches the proven-good single-group submission structure.
    bid_groups.push(makeGroup(groupName, null, cherryNums, false));
  } else if (hasTiers) {
    prefs.trip_lengths.forEach((len, i) => {
      bid_groups.push(makeGroup(`${len}-Day Trips`, len, [], i < prefs.trip_lengths.length - 1));
    });
  } else {
    // Single group — default
    const nameParts = [];
    if (prefs.trip_lengths?.length) nameParts.push(prefs.trip_lengths.map(l => `${l}-day`).join('/') + ' trips');
    if (prefs.checkin_after) nameParts.push(`CI after ${prefs.checkin_after}`);
    if (prefs.layover_prefer?.length) nameParts.push(prefs.layover_prefer.join('/') + ' layovers');
    if (prefs.avoid_redeyes) nameParts.push('no redeyes');
    if (prefs.depart_days?.length) nameParts.push('depart ' + prefs.depart_days.join('/'));
    if (prefs.high_daily_credit) nameParts.push('high credit/day');
    bid_groups.push(makeGroup(nameParts.join(', ') || 'My Bid', null, [], false));
  }

  return {
    bid_groups,
    reserve: { prefer_off: [] }
  };
}

export async function buildBidFromPreferences({ preferences, pairings, absences, period, preAwardCredit = 0, minCredit = 75, constants = null }) {
  const absenceContext = absences?.length
    ? `\nPre-awarded days off (system-blocked): ${absences.map(a => `${a.code}: ${a.start}→${a.end}`).join(', ')}`
    : '';

  const remainingCredit = Math.max(0, minCredit - preAwardCredit);

  // ── 1. Parse the pilot's plain-English preferences (the API extracts the constraints) ──
  const stationCodes = pairings?.length
    ? [...new Set(pairings.flatMap(p => p.stations || p.layovers || []))].filter(Boolean).sort().join(', ')
    : '';

  const userMessage = [
    period ? `Bid period: ${period}` : '',
    absenceContext,
    stationCodes ? `Stations appearing this period: ${stationCodes}` : '',
    '',
    `Pilot preferences: ${preferences}`
  ].filter(Boolean).join('\n');

  const result = await chrome.runtime.sendMessage({
    type: 'CLAUDE_REQUEST',
    payload: {
      // Sonnet, not Haiku: the parser now carries the whole bid (every city, every set-condition),
      // so reliability matters — Haiku dropped BUR from a 3-city list.
      model: 'claude-sonnet-5',
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    }
  });

  if (result.error) throw new Error(result.error);

  const text = result.data.content[0].text.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Claude did not return a valid preference object');
  const prefs = JSON.parse(text.slice(start, end + 1));

  // ── 2. Selection request? (cherry-pick / max-days-off / credit-target) ──
  const isDaysOffRequest = /\b(max(imum)?\s*(days?\s*off|time\s*(off|home))|most\s*(days?\s*(off|home)|time\s*(off|home))|fewest\s*days?\s*(work|away|on))\b/i.test(preferences);
  const isCherryPick = /\b(cherry[-\s]?pick|hand[-\s]?pick|pick\s+(out|specific|individual|the\s+best|only))\b/i.test(preferences);
  const isCreditRequest = preAwardCredit > 0 || isDaysOffRequest || isCherryPick ||
    /\b(min(imum)?\s*credit|fewest\s*trip|least\s*trip|hit\s*min|target.*credit|credit.*target|\b75\s*h|\bhours?\s*target)\b/i.test(preferences);
  const preferWeekendsOff = /\b(weekends?\s*off|off\s*(on\s*)?weekends?|home\s*(for\s*)?weekends?)\b/i.test(preferences);

  const lengths = prefs.trip_lengths?.length ? prefs.trip_lengths : null;
  const avoidCities = prefs.layover_avoid || [];
  const minGap = Number(prefs.min_days_between) || 0;

  let creditContext = null;
  let selection = null;

  if (isCreditRequest && pairings?.length) {
    // Hard filters (length, avoided landing/layover cities, red-eyes) — never violated.
    let candidates = filterCandidates(pairings, { lengths, avoidCities, avoidRedeye: prefs.avoid_redeyes });
    // Drop trips overlapping a pre-awarded absence (can't work those days).
    const blocked = (absences || []).filter(a => a.start && a.end);
    if (blocked.length) {
      candidates = candidates.filter(p => {
        const s = p.start || (p.dates && p.dates[0]); const e = p.end;
        if (!s || !e) return true;
        return !blocked.some(b => s <= b.end && b.start <= e);
      });
    }

    if (candidates.length) {
      const targetMinutes = remainingCredit * 60;
      const byNum = new Map(candidates.map(p => [p.number, p]));
      const creditOf = nums => nums.reduce((s, n) => s + (byNum.has(n) ? creditMinutes(byNum.get(n).credit) : 0), 0);

      let picks = [];
      let engine = 'optimizer';
      let reasoning = '';

      // PRIMARY: the LLM chooses the set (the intelligent bidder). We only accept its picks if,
      // after enforcing the hard spacing/overlap rules, they still form a VALID bid that clears
      // the credit floor — otherwise the optimizer backs it up (your chosen design).
      try {
        const api = await selectPicksViaApi(candidates, { targetHours: remainingCredit, minGap, preferWeekendsOff, rawPreferences: preferences });
        const enforced = enforcePicks(api.picks, candidates, { minGap });
        if (enforced.length && creditOf(enforced) >= targetMinutes) {
          picks = enforced; engine = 'api'; reasoning = api.reasoning || '';
        } else if (enforced.length) {
          console.warn(`[PBS] API picks cleared spacing but not the ${remainingCredit}h floor (${Math.round(creditOf(enforced)/60)}h) — backing up with optimizer.`);
        }
      } catch (e) {
        console.warn('[PBS] API selection unavailable, using optimizer:', e.message);
      }

      // BACKUP: deterministic optimal selection when the LLM's picks are missing/invalid/short.
      if (!picks.length) {
        picks = pickTripsForMaxDaysOff(candidates, { targetMinutes, minGap, preferWeekendsOff }).cherry_picks;
        engine = 'optimizer';
      }

      if (picks.length) {
        const chosen = picks.map(n => byNum.get(n)).filter(Boolean);
        const totalMins = chosen.reduce((s, p) => s + creditMinutes(p.credit), 0);
        creditContext = {
          cherry_picks: picks,
          total_credit: `${Math.floor(totalMins / 60)}:${String(totalMins % 60).padStart(2, '0')}`,
          trip_count: picks.length,
          days_worked: chosen.reduce((s, p) => s + (parseInt(p.length) || 0), 0),
          remaining_hours: remainingCredit
        };
        selection = { engine, reasoning, candidate_count: candidates.length, minGap, avoidCities, lengths, preferWeekendsOff };
      }
    }
  }

  // Explicit pick list => list those specific pairings, NOT a PairingLength property award.
  if (creditContext?.cherry_picks?.length) prefs.trip_lengths = [];

  const model = buildBidModel(prefs, constants, creditContext);
  model._meta = {
    creditContext,
    selection,
    line_conditions: translateLineConditions(prefs.line_conditions),
    unsupported: Array.isArray(prefs.unsupported) ? prefs.unsupported.filter(Boolean) : []
  };
  return model;
}

// Canonical NavBlue line-condition keys (from bidsconstants.js -> navblue_bid_catalog.json).
const LC_VALUED_TIME = new Set(['TimeBetweenPairings', 'MinimumCreditWindow', 'MaximumCreditWindow']);
const LC_VALUED_DAYS = new Set(['MaximumDaysOn', 'MinimumDaysOff', 'TotalDaysOffInPeriod']);
// Legacy custom names (older parser output) -> canonical key, for backward compatibility.
const LC_LEGACY = {
  min_base_layover: 'TimeBetweenPairings', time_between_pairings: 'TimeBetweenPairings',
  min_credit_window: 'MinimumCredit', max_days_on: 'MaximumDaysOn',
  min_days_off: 'MinimumDaysOff', min_consecutive_days_off: 'MinimumConsecutiveDaysOff',
  total_days_off: 'TotalDaysOffInPeriod'
};

// Translate the parser's line-condition intents into bid_builder specs. Valued keys carry a value;
// every other recognized key emits a simple (valueless) LineCondition via the builder's generic path.
function translateLineConditions(list) {
  const out = [];
  for (const c of (list || [])) {
    const key = c?.key || LC_LEGACY[c?.type] || c?.type;
    if (!key) continue;
    if (LC_VALUED_TIME.has(key) && c.hours != null) {
      out.push({ type: key, hours: Number(c.hours), minutes: Number(c.minutes) || 0 });
    } else if (LC_VALUED_DAYS.has(key) && c.days != null) {
      out.push({ type: key, days: Number(c.days) });
    } else {
      out.push({ type: key });   // simple / valueless line condition
    }
  }
  return out;
}

// Score each available pairing against the bid model for display
export function scorePairings(pairings, model) {
  return pairings.map(p => {
    const avoids = [
      ...(model.constants?.avoid_pairings || []),
      ...(model.bid_groups[0]?.avoid_pairings || [])
    ];
    const awards = model.bid_groups[0]?.award_pairings || [];
    const specific = [
      ...(model.bid_groups[0]?.specific_pairings || []),
      ...(model.bid_groups.flatMap(g => g.specific_pairings || []))
    ];

    if (specific.includes(p.number)) {
      return { ...p, score: 'picked', reason: 'Cherry-picked' };
    }
    for (const rule of avoids) {
      const hit = matchesRule(rule, p);
      if (hit) return { ...p, score: 'avoid', reason: hit };
    }
    for (const rule of awards) {
      const hit = matchesRule(rule, p);
      if (hit) return { ...p, score: 'match', reason: hit };
    }
    return { ...p, score: 'neutral', reason: '' };
  });
}

function parseMinutes(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':').map(Number);
  return parts[0] * 60 + (parts[1] || 0);
}

function matchesRule(rule, p) {
  switch (rule.type) {
    case 'PairingCheckin': {
      const rMins = parseMinutes(rule.time);
      const pMins = parseMinutes(p.checkin);
      if (rMins == null || pMins == null) return null;
      const op = rule.operator || 'LT';
      if (op === 'LT' && pMins < rMins) return `CI ${p.checkin} before ${rule.time}`;
      if (op === 'GT' && pMins > rMins) return `CI ${p.checkin} after ${rule.time}`;
      return null;
    }
    case 'PairingCheckout': {
      const rMins = parseMinutes(rule.time);
      const pMins = parseMinutes(p.checkout);
      if (rMins == null || pMins == null) return null;
      const op = rule.operator || 'LT';
      if (op === 'LT' && pMins < rMins) return `CO ${p.checkout} before ${rule.time}`;
      if (op === 'GT' && pMins > rMins) return `CO ${p.checkout} after ${rule.time}`;
      return null;
    }
    case 'LayoverStations': {
      const match = rule.match || 'Any';
      if (match === 'Any' && p.layovers.some(l => rule.stations.includes(l)))
        return `Layover: ${p.layovers.filter(l => rule.stations.includes(l)).join('/')}`;
      if (match === 'All' && rule.stations.every(s => p.layovers.includes(s)))
        return `All layovers: ${rule.stations.join('/')}`;
      return null;
    }
    case 'PairingLength': {
      const len = parseInt(p.length);
      const op = rule.operator || 'EQ';
      if (op === 'EQ' && len === rule.days) return `${rule.days}-day trip`;
      if (op === 'LT' && len < rule.days) return `Short trip (${len}d)`;
      if (op === 'GT' && len > rule.days) return `Long trip (${len}d)`;
      return null;
    }
    case 'TimeAwayFromBase': {
      const rMins = parseMinutes(rule.time);
      const pMins = parseMinutes(p.tafb);
      if (rMins == null || pMins == null) return null;
      const op = rule.operator || 'GT';
      if (op === 'GT' && pMins > rMins) return `TAFB ${p.tafb} > ${rule.time}`;
      if (op === 'LT' && pMins < rMins) return `TAFB ${p.tafb} < ${rule.time}`;
      return null;
    }
    case 'PairingCredit': {
      const rMins = parseMinutes(rule.time);
      const pMins = parseMinutes(p.credit);
      if (rMins == null || pMins == null) return null;
      const op = rule.operator || 'GT';
      if (op === 'GT' && pMins > rMins) return `Credit ${p.credit} > ${rule.time}`;
      if (op === 'LT' && pMins < rMins) return `Credit ${p.credit} < ${rule.time}`;
      return null;
    }
    case 'DutyIsRedeye':
      return null;
    default:
      return null;
  }
}
