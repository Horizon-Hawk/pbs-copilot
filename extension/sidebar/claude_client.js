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
  "layover_avoid": [],        // station codes to avoid as layovers
  "tafb_max_hours": null,     // number — max hours away from base. null = no limit.
  "high_daily_credit": false, // true = prefer trips with high credit per day worked
  "specific_pairings": [],    // explicitly named pairing numbers e.g. ["G3027","G3043"]
  "depart_days": [],          // ONLY if pilot explicitly says to START trips on specific days
                              // e.g. "start trips on Tuesdays" -> ["Tuesday"]
                              // "weekends off" does NOT go here — leave empty.
  "fallback_tiers": false     // true ONLY if pilot says "if I can't get X, give me Y"
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

function selectCreditTargetPairings(pairings, remainingHours, mode = 'credit') {
  const targetMins = Math.round(remainingHours * 60);
  if (targetMins <= 0) return null;

  const candidates = pairings
    .filter(p => p.credit && toMinutes(p.credit) > 0)
    .map(p => {
      const creditMins = toMinutes(p.credit);
      const days = parseInt(p.length) || 1;
      return { ...p, creditMins, creditPerDay: creditMins / days };
    })
    .sort((a, b) => mode === 'days_off'
      ? b.creditPerDay - a.creditPerDay
      : b.creditMins - a.creditMins
    );

  if (!candidates.length) return null;

  // Greedily add trips that don't exceed the target
  const selected = [];
  let total = 0;
  for (const p of candidates) {
    if (total >= targetMins) break;
    if (total + p.creditMins <= targetMins) {
      selected.push(p);
      total += p.creditMins;
    }
  }

  // Add one trip closest to the remaining gap
  if (total < targetMins) {
    const gap = targetMins - total;
    const filler = candidates
      .filter(p => !selected.includes(p))
      .sort((a, b) => Math.abs(a.creditMins - gap) - Math.abs(b.creditMins - gap))[0];
    if (filler) {
      selected.push(filler);
      total += filler.creditMins;
    }
  }

  const h = Math.floor(total / 60);
  const m = String(total % 60).padStart(2, '0');
  return {
    cherry_picks: selected.map(p => p.number),
    total_credit: `${h}:${m}`,
    trip_count: selected.length,
    days_worked: selected.reduce((sum, p) => sum + (parseInt(p.length) || 0), 0),
    remaining_hours: remainingHours
  };
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
    bid_groups.push(makeGroup(groupName, null, cherryNums, true));
    bid_groups.push(makeGroup('Fallback — Any qualifying trip', null, [], false));
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

  const isDaysOffRequest = /\b(max(imum)?\s*(days?\s*off|time\s*(off|home))|most\s*(days?\s*(off|home)|time\s*(off|home))|fewest\s*days?\s*(work|away|on))\b/i.test(preferences);
  const isCreditRequest = preAwardCredit > 0 || isDaysOffRequest || /\b(min(imum)?\s*credit|fewest\s*trip|least\s*trip|hit\s*min|target.*credit|credit.*target|\b75\s*h|\bhours?\s*target)\b/i.test(preferences);

  const selectionMode = isDaysOffRequest ? 'days_off' : 'credit';
  const creditContext = isCreditRequest ? selectCreditTargetPairings(pairings || [], remainingCredit, selectionMode) : null;

  const creditNote = isCreditRequest
    ? `\nCredit target: need ${remainingCredit}h more (${preAwardCredit}h pre-awarded, ${minCredit}h minimum).` +
      (creditContext ? ` Pre-selected: ${creditContext.cherry_picks.join(', ')} = ${creditContext.total_credit}h in ${creditContext.trip_count} trips.` : '')
    : '';

  const stationCodes = pairings?.length
    ? [...new Set(pairings.flatMap(p => p.layovers || []))].filter(Boolean).sort().join(', ')
    : '';

  const userMessage = [
    period ? `Bid period: ${period}` : '',
    absenceContext,
    creditNote,
    stationCodes ? `Available layover stations this period: ${stationCodes}` : '',
    '',
    `Pilot preferences: ${preferences}`
  ].filter(Boolean).join('\n');

  const result = await chrome.runtime.sendMessage({
    type: 'CLAUDE_REQUEST',
    payload: {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
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

  const model = buildBidModel(prefs, constants, creditContext);
  model._meta = { creditContext, selectionMode };
  return model;
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
