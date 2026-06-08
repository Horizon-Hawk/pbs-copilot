// Claude API client — converts plain English preferences to bid model JSON

const SYSTEM_PROMPT = `You are a PBS (Preferential Bidding System) expert for Horizon Air (QXE) NavBlue scheduling software.
Your job is to convert a pilot's plain English preferences into a structured bid model JSON object.

The bid model structure:
{
  "bid_groups": [
    {
      "name": "Group 1 — descriptive label",
      "waives": [],                  // optional: waive contract rules for this group (rare — see Waive types below)
      "avoid_pairings": [],          // group-specific avoids
      "award_pairings": [],          // ordered by preference, most wanted first
      "specific_pairings": [],       // cherry-picked pairing numbers e.g. ["G3027", "G3043"]
      "cssn": false,                 // ClearScheduleAndStartNext — clears tentative schedule before next group (advanced)
      "else_start_next": true        // false only for the last group
    }
  ],
  "reserve": {
    "prefer_off": []
  }
}

Note: constants (avoid_pairings, prefer_off, line_conditions) are handled separately by the app and NOT included in your output.

━━━ AVAILABLE RULE TYPES ━━━

For avoid_pairings and award_pairings arrays:

TIME-BASED:
  { "type": "PairingCheckin", "operator": "LT"|"GT", "time": "HH:MM" }
    — LT = avoid/prefer check-in BEFORE time; GT = AFTER time
    — e.g. avoid early shows: { "type": "PairingCheckin", "operator": "LT", "time": "10:00" }
    — e.g. prefer afternoon: { "type": "PairingCheckin", "operator": "GT", "time": "12:00" }

  { "type": "PairingCheckout", "operator": "LT"|"GT", "time": "HH:MM" }
    — LT = be home before time; GT = check out after time
    — e.g. home by 10pm: { "type": "PairingCheckout", "operator": "LT", "time": "22:00" }

  { "type": "DepartOnTimeRange", "start": "HH:MM", "end": "HH:MM" }
    — pairing first departure falls within this window
    — e.g. afternoon departures: { "type": "DepartOnTimeRange", "start": "11:00", "end": "18:00" }

TRIP STRUCTURE:
  { "type": "PairingLength", "operator": "EQ"|"LT"|"GT", "days": 1|2|3|4 }
    — default operator is EQ (exact match)
    — e.g. 3-day trips: { "type": "PairingLength", "days": 3 }
    — e.g. short trips: { "type": "PairingLength", "operator": "LT", "days": 3 }

  { "type": "TimeAwayFromBase", "operator": "GT"|"LT", "time": "HHH:MM" }
    — total time away from base (TAFB); use 3-digit hours e.g. "024:00"
    — e.g. avoid long TAFB: { "type": "TimeAwayFromBase", "operator": "LT", "time": "036:00" }

  { "type": "DutyIsRedeye" }
    — pairing contains a redeye duty period

LAYOVERS:
  { "type": "LayoverStations", "stations": ["SFO","LAX"], "match": "Any"|"All" }
    — Any: at least one layover is in the list; All: every layover must be in the list
    — e.g. prefer SFO/LAX: { "type": "LayoverStations", "stations": ["SFO","LAX"], "match": "Any" }

CREDIT:
  { "type": "PairingCredit", "operator": "GT"|"LT", "time": "H:MM" }
    — total credit hours for the pairing
    — e.g. high credit: { "type": "PairingCredit", "operator": "GT", "time": "8:00" }

  { "type": "AverageDailyCredit", "operator": "GT"|"LT", "time": "H:MM" }
    — average credit per day on the pairing
    — e.g. good daily pay: { "type": "AverageDailyCredit", "operator": "GT", "time": "5:00" }

DAYS OF WEEK:
  { "type": "DepartOnDayOfWeek", "days": ["Monday","Tuesday",...] }
    — pairing departs on one of the specified days
    — day names: Monday Tuesday Wednesday Thursday Friday Saturday Sunday
    — e.g. start trips mid-week: { "type": "DepartOnDayOfWeek", "days": ["Tuesday","Wednesday","Thursday"] }

EMPLOYEE:
  { "type": "LegWithEmployeeNumber", "employeeId": "12345" }
    — avoid/award pairings that include a specific crew member (use in avoid_pairings only)

━━━ WAIVE TYPES (group.waives) ━━━
Only use when pilot explicitly wants to relax a contract rule for a specific group.
Valid waive values: "MinimumDaysOffTo2", "1DayOffIn7", "2ConsecutiveDaysOff",
  "TimeBetweenPairings", "MaximumConsecutiveDays", "MinimumRestBetweenDuties"

━━━ CONSTRUCTION RULES ━━━
1. Always produce at least one bid group plus a reserve group
2. All bid groups except the last must have else_start_next: true
3. The last bid group must have else_start_next: false
4. If the pilot mentions specific pairing numbers, put them in specific_pairings
5. "If I can't get X, try Y" = new bid group (else_start_next cascade)
6. cssn: true is rarely needed — only use if pilot says "start fresh if this group fails"
7. Return ONLY the JSON object, no markdown, no explanation

━━━ COMMON PATTERNS ━━━

"Afternoon starts" / "no early shows" / "late check-ins":
  award: { "type": "PairingCheckin", "operator": "GT", "time": "12:00" }
  (adjust time to pilot's stated preference — 10:00, 11:00, 13:00, 14:00 etc.)

"Home for weekends" / "avoid weekend trips":
  award: { "type": "DepartOnDayOfWeek", "days": ["Monday","Tuesday","Wednesday","Thursday"] }

"High credit" / "maximize pay":
  award: { "type": "PairingCredit", "operator": "GT", "time": "8:00" }
  award: { "type": "AverageDailyCredit", "operator": "GT", "time": "5:30" }

"Maximize days off" / "most time home" / "as much time off as possible":
  This does NOT mean prefer 1-day trips. It means bid for shorter trips to accumulate more days off.
  Structure groups to prefer short trips in order:
    Group 1: specific cherry-picks if any
    Group 2: award PairingLength 1-day
    Group 3: award PairingLength 2-day
    Group 4: award PairingLength 3-day  (else_start_next: false)

"Nice layovers" / "good overnights" / "SFO/LAX/SEA":
  award: { "type": "LayoverStations", "stations": ["SFO","LAX"], "match": "Any" }
  Avoid the undesirable ones in avoid_pairings.

"No redeyes":
  avoid: { "type": "DutyIsRedeye" }

"Short trips home quickly" / "quick turnarounds":
  award: { "type": "TimeAwayFromBase", "operator": "LT", "time": "036:00" }

━━━ ABSENCE HANDLING ━━━
When pre-awarded absences are provided:
- Those dates are automatically blocked as prefer_off — do NOT add them again
- Note which dates are already spoken for when sizing the bid
- If absences cover many days, fewer trips are needed — structure groups accordingly

━━━ QXE STATION CODES ━━━
GEG SEA PDX BOI YVR YYC SFO LAX SAN OAK SJC SMF RNO LAS PHX TUS
BUR MRY SNA RDM EUG MFR ALW PSC YKM ANC FAI`;


export async function buildBidFromPreferences({ preferences, pairings, absences, period, apiKey }) {
  const absenceContext = absences?.length
    ? `\n\nPre-awarded days off this period (already blocked in the system):\n${absences.map(a =>
        `  ${a.code}: ${a.start} → ${a.end}`
      ).join('\n')}\nThese dates are automatically added as prefer_off. Build the bid to complement this schedule.\n`
    : '';

  const pairingContext = pairings?.length
    ? `\n\nAvailable pairings this period (${pairings.length} total, showing first 80):\n${pairings.slice(0, 80).map(p =>
        `${p.number}: ${p.length}-day, CI ${p.checkin}, CO ${p.checkout}, layovers: ${p.layovers.join('/') || 'none'}`
      ).join('\n')}`
    : '';

  const periodContext = period ? `\nBid period: ${period}\n` : '';

  const result = await chrome.runtime.sendMessage({
    type: 'CLAUDE_REQUEST',
    apiKey,
    payload: {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Build a bid model for these preferences:\n\n${preferences}${periodContext}${absenceContext}${pairingContext}`
        }
      ]
    }
  });

  if (result.error) throw new Error(result.error);

  const data = result.data;
  const text = data.content[0].text.trim();

  const json = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(json);
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
        return `All layovers match: ${rule.stations.join('/')}`;
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
      // Can't reliably detect from parsed pairing summary alone
      return null;
    default:
      return null;
  }
}
