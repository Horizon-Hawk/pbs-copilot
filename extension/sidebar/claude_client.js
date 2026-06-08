// Claude API client — converts plain English preferences to bid model JSON

const SYSTEM_PROMPT = `You are a PBS (Preferential Bidding System) expert for NavBlue airline scheduling software.
Your job is to convert a pilot's plain English preferences into a structured bid model JSON object.

The bid model has this structure:
{
  "constants": {
    "avoid_employees": [],           // employee numbers to always avoid flying with
    "avoid_pairings": [],            // always-on pairing avoidance rules
    "prefer_off": [],                // always prefer off (e.g. "Weekends")
    "line_conditions": []            // always-on line conditions
  },
  "bid_groups": [
    {
      "name": "Group 1",
      "avoid_pairings": [],          // group-specific avoids
      "award_pairings": [],          // group-specific awards (ordered by preference)
      "specific_pairings": [],       // cherry-picked pairing numbers e.g. ["G3027"]
      "else_start_next": true        // false only for the last group
    }
  ],
  "reserve": {
    "prefer_off": ["Weekends"]
  }
}

Available rule types:
- avoid_pairings/award_pairings rules:
  { "type": "PairingCheckin", "operator": "LT"|"GT", "time": "HH:MM" }
  { "type": "LayoverStations", "stations": ["SFO","LAX"], "match": "Any"|"All" }
  { "type": "PairingLength", "days": 1|2|3|4 }
  { "type": "TimeAwayFromBase", "operator": "GT"|"LT", "time": "HHH:MM" }
  { "type": "DutyIsRedeye" }

- line_conditions:
  { "type": "TimeBetweenPairings", "hours": 48 }
  { "type": "MaximumDaysOn", "days": 5 }
  { "type": "MinimumConsecutiveDaysOff", "days": 2 }
  { "type": "TotalDaysOffInPeriod", "days": 12 }

- prefer_off:
  "Weekends"
  { "dates": ["2026-07-18", "2026-07-19"] }

Rules:
1. Always produce at least one bid group plus a reserve group
2. All bid groups except the last must have else_start_next: true
3. The last bid group must have else_start_next: false
4. Constants are injected into every group automatically — do not repeat them inside groups
5. If the pilot mentions specific pairing numbers, put them in specific_pairings
6. If the pilot mentions "if I can't get X, try Y" — that is a new bid group
7. Return ONLY the JSON object, no explanation

Station codes used at Horizon Air:
GEG SEA PDX BOI FAI ANC YVR YYC SFO LAX SAN OAK SJC SMF RNO LAS PHX TUS
BUR MRY SNA SJC RDM EUG MFR ALW PSC YKM ANC FAI`;

export async function buildBidFromPreferences({ preferences, pairings, apiKey }) {
  const pairingContext = pairings?.length
    ? `\n\nAvailable pairings this period:\n${pairings.slice(0, 50).map(p =>
        `${p.number}: ${p.length}-day, check-in ${p.checkin}, layovers: ${p.layovers.join('/')}`
      ).join('\n')}`
    : '';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Build a bid model for these preferences:\n\n${preferences}${pairingContext}`
        }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.content[0].text.trim();

  // Strip markdown code fences if present
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

    let score = 'neutral';
    let reason = '';

    // Check if explicitly cherry-picked
    if (specific.includes(p.number)) {
      return { ...p, score: 'picked', reason: 'Cherry-picked' };
    }

    // Check avoids
    for (const rule of avoids) {
      if (rule.type === 'PairingCheckin' && rule.operator === 'LT') {
        const [rh, rm] = rule.time.split(':').map(Number);
        const [ph, pm] = (p.checkin || '00:00').split(':').map(Number);
        if (ph * 60 + pm < rh * 60 + rm) {
          return { ...p, score: 'avoid', reason: `Check-in ${p.checkin} is before ${rule.time}` };
        }
      }
      if (rule.type === 'LayoverStations') {
        const hit = p.layovers.some(l => rule.stations.includes(l));
        if (hit) {
          return { ...p, score: 'avoid', reason: `Layover in avoided station (${p.layovers.join(',')})` };
        }
      }
      if (rule.type === 'PairingLength') {
        if (parseInt(p.length) === rule.days) {
          return { ...p, score: 'avoid', reason: `${rule.days}-day trips avoided` };
        }
      }
    }

    // Check awards
    for (const rule of awards) {
      if (rule.type === 'LayoverStations') {
        const hit = p.layovers.some(l => rule.stations.includes(l));
        if (hit) return { ...p, score: 'match', reason: `Preferred layover (${p.layovers.join(',')})` };
      }
      if (rule.type === 'PairingLength') {
        if (parseInt(p.length) === rule.days) {
          return { ...p, score: 'match', reason: `Preferred ${rule.days}-day trip` };
        }
      }
    }

    return { ...p, score, reason };
  });
}
