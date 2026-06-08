// Claude API client — converts plain English preferences to bid model JSON

const SYSTEM_PROMPT = `You are a PBS (Preferential Bidding System) expert for NavBlue airline scheduling software.
Your job is to convert a pilot's plain English preferences into a structured bid model JSON object.

The bid model structure:
{
  "bid_groups": [
    {
      "name": "Group 1",
      "avoid_pairings": [],          // group-specific avoids
      "award_pairings": [],          // ordered by preference (most wanted first)
      "specific_pairings": [],       // cherry-picked pairing numbers e.g. ["G3027"]
      "else_start_next": true        // false only for the last group
    }
  ],
  "reserve": {
    "prefer_off": []
  }
}

Note: constants (avoid_pairings, prefer_off, line_conditions) are handled separately — do NOT include them in your output.

Available rule types for avoid_pairings / award_pairings:
  { "type": "PairingCheckin", "operator": "LT"|"GT", "time": "HH:MM" }
  { "type": "LayoverStations", "stations": ["SFO","LAX"], "match": "Any"|"All" }
  { "type": "PairingLength", "days": 1|2|3|4 }
  { "type": "TimeAwayFromBase", "operator": "GT"|"LT", "time": "HHH:MM" }
  { "type": "DutyIsRedeye" }

Rules:
1. Always produce at least one bid group plus a reserve group
2. All bid groups except the last must have else_start_next: true
3. The last bid group must have else_start_next: false
4. If the pilot mentions specific pairing numbers, put them in specific_pairings
5. If the pilot mentions "if I can't get X, try Y" — that is a new bid group
6. Return ONLY the JSON object, no explanation

IMPORTANT — "maximize days off" / "max days off" / "as much time off as possible":
This does NOT mean prefer 1-day trips. It means:
- Award pairings with fewer total days (PairingLength 1, then 2, then 3)
- The bid builds a schedule with many small trips to accumulate days off between them
- Combined with TotalDaysOffInPeriod and MinimumConsecutiveDaysOff line conditions (handled separately)

When the pilot says "max days off" or "most time home", structure bid groups to prefer:
  Group 1: specific cherry-picked short pairings if any are identified
  Group 2: PairingLength 1-day trips
  Group 3: PairingLength 2-day trips
  Group 4: PairingLength 3-day trips (else_start_next: false)

When pre-awarded absences are provided, the bid should work AROUND those dates:
- The absence dates are already added to prefer_off automatically
- You should note which dates are blocked and structure groups to complement them
- If absences cover many days, fewer additional trips are needed — account for this in group structure

Station codes used at Horizon Air:
GEG SEA PDX BOI FAI ANC YVR YYC SFO LAX SAN OAK SJC SMF RNO LAS PHX TUS
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
    const specific = model.bid_groups[0]?.specific_pairings || [];

    if (specific.includes(p.number)) {
      return { ...p, score: 'picked', reason: 'Cherry-picked' };
    }

    for (const rule of avoids) {
      if (rule.type === 'PairingCheckin' && rule.operator === 'LT') {
        const [rh, rm] = rule.time.split(':').map(Number);
        const [ph, pm] = (p.checkin || '00:00').split(':').map(Number);
        if (ph * 60 + pm < rh * 60 + rm) {
          return { ...p, score: 'avoid', reason: `CI ${p.checkin} before ${rule.time}` };
        }
      }
      if (rule.type === 'LayoverStations') {
        if (p.layovers.some(l => rule.stations.includes(l))) {
          return { ...p, score: 'avoid', reason: `Avoided layover (${p.layovers.join(',')})` };
        }
      }
      if (rule.type === 'PairingLength') {
        if (parseInt(p.length) === rule.days) {
          return { ...p, score: 'avoid', reason: `${rule.days}-day trips avoided` };
        }
      }
    }

    for (const rule of awards) {
      if (rule.type === 'LayoverStations') {
        if (p.layovers.some(l => rule.stations.includes(l))) {
          return { ...p, score: 'match', reason: `Preferred layover (${p.layovers.join(',')})` };
        }
      }
      if (rule.type === 'PairingLength') {
        if (parseInt(p.length) === rule.days) {
          return { ...p, score: 'match', reason: `Preferred ${rule.days}-day trip` };
        }
      }
    }

    return { ...p, score: 'neutral', reason: '' };
  });
}
