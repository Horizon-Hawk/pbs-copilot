// Converts the internal bid model into NavBlue XML

// --- Internal bid model schema ---
//
// constants: {
//   avoid_employees: ["12345"],
//   avoid_pairings: [{ type, ...params }],
//   prefer_off: ["Weekends"] | [{ dates: [...] }] | [{ days_of_week: [...] }],
//   line_conditions: [{ type, ...params }]
// }
//
// bid_groups: [{
//   name: string,
//   avoid_pairings: [{ type, ...params }],
//   award_pairings: [{ type, ...params }],   // ordered by preference
//   specific_pairings: ["G3027", "G3043"],   // cherry-picked numbers
//   else_start_next: bool
// }]
//
// reserve: {
//   prefer_off: ["Weekends"]
// }

export function buildBidXml(model) {
  const lines = [];
  let lineNum = 1;

  const line = (type, innerXml) => {
    const num = lineNum++;
    return `    <BidLine>
      <BidLineNumber>${num}</BidLineNumber>
      <BidLineType>${type}</BidLineType>
      ${innerXml}
    </BidLine>`;
  };

  for (const group of model.bid_groups) {
    // Start bid group
    lines.push(line('StartBidGroup', `
      <StartBidGroup>
        <BidGroupType>StartPairings</BidGroupType>
        <StartPairings></StartPairings>
      </StartBidGroup>`));

    // Inject constants: avoid employees
    for (const empId of (model.constants?.avoid_employees || [])) {
      lines.push(line('AvoidPairings', buildAvoidEmployee(empId)));
    }

    // Inject constants: avoid pairings
    for (const rule of (model.constants?.avoid_pairings || [])) {
      lines.push(line('AvoidPairings', buildPairingProperty('AvoidPairings', rule)));
    }

    // Inject constants: prefer off
    for (const pref of (model.constants?.prefer_off || [])) {
      lines.push(line('PreferOff', buildPreferOff(pref)));
    }

    // Inject constants: line conditions
    for (const cond of (model.constants?.line_conditions || [])) {
      lines.push(line('LineCondition', buildLineCondition(cond)));
    }

    // Group-specific avoid pairings
    for (const rule of (group.avoid_pairings || [])) {
      lines.push(line('AvoidPairings', buildPairingProperty('AvoidPairings', rule)));
    }

    // Cherry-picked specific pairings (award if pairing numbers match)
    if (group.specific_pairings?.length) {
      lines.push(line('AwardPairings', buildSpecificPairings(group.specific_pairings)));
    }

    // Preference-based award pairings
    for (const rule of (group.award_pairings || [])) {
      lines.push(line('AwardPairings', buildPairingProperty('AwardPairings', rule)));
    }

    // Catch-all award
    lines.push(line('AwardPairings', `
      <AwardPairings>
        <PairingProperties>
          <PairingProperty>
            <Award></Award>
            <PairingPropertyType>Award</PairingPropertyType>
          </PairingProperty>
        </PairingProperties>
      </AwardPairings>`));

    // Else start next (if not the terminal group)
    if (group.else_start_next) {
      lines.push(line('ElseStartNextBidGroup', '<ElseStartNextBidGroup></ElseStartNextBidGroup>'));
    }
  }

  // Reserve group
  lines.push(line('StartBidGroup', `
    <StartBidGroup>
      <BidGroupType>StartReserve</BidGroupType>
      <StartReserve></StartReserve>
    </StartBidGroup>`));

  for (const pref of (model.reserve?.prefer_off || [])) {
    lines.push(line('PreferOff', buildPreferOff(pref)));
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<BidLines>
${lines.join('\n')}
</BidLines>`;
}

function buildAvoidEmployee(empId) {
  return `
    <AvoidPairings>
      <PairingProperties>
        <PairingProperty>
          <PairingPropertyType>LegWithEmployeeNumber</PairingPropertyType>
          <LegWithEmployeeNumber>
            <EmployeeNumbers>
              <EmployeeNumber>${empId}</EmployeeNumber>
            </EmployeeNumbers>
          </LegWithEmployeeNumber>
        </PairingProperty>
      </PairingProperties>
    </AvoidPairings>`;
}

function buildSpecificPairings(numbers) {
  const numXml = numbers.map(n => `<PairingNumber>${n}</PairingNumber>`).join('\n              ');
  return `
    <AwardPairings>
      <PairingProperties>
        <PairingProperty>
          <PairingPropertyType>PairingNumbers</PairingPropertyType>
          <PairingNumbers>
            <Numbers>${numXml}</Numbers>
          </PairingNumbers>
        </PairingProperty>
      </PairingProperties>
    </AwardPairings>`;
}

function buildPreferOff(pref) {
  if (pref === 'Weekends') {
    return `
    <PreferOff>
      <PreferOffType>PreferOffWeekends</PreferOffType>
      <PreferOffWeekends><Weekends></Weekends></PreferOffWeekends>
    </PreferOff>`;
  }
  if (pref.dates) {
    const datesXml = pref.dates.map(d => `<Date>${d}</Date>`).join('');
    return `
    <PreferOff>
      <PreferOffType>PreferOffDates</PreferOffType>
      <PreferOffDates><Dates>${datesXml}</Dates></PreferOffDates>
    </PreferOff>`;
  }
  return '';
}

function buildLineCondition(cond) {
  switch (cond.type) {
    case 'TimeBetweenPairings': {
      const h = String(Math.floor(cond.hours)).padStart(3, '0');
      return `
    <LineCondition>
      <LineConditionType>TimeBetweenPairings</LineConditionType>
      <TimeBetweenPairings>
        <Time><Hour>${h}</Hour><Minute>00</Minute></Time>
      </TimeBetweenPairings>
    </LineCondition>`;
    }
    case 'MaximumDaysOn':
      return `
    <LineCondition>
      <LineConditionType>MaximumDaysOn</LineConditionType>
      <MaximumDaysOn><Days>${cond.days}</Days></MaximumDaysOn>
    </LineCondition>`;
    case 'MinimumConsecutiveDaysOff':
      return `
    <LineCondition>
      <LineConditionType>MinimumConsecutiveDaysOff</LineConditionType>
      <MinimumConsecutiveDaysOff><Days>${cond.days}</Days></MinimumConsecutiveDaysOff>
    </LineCondition>`;
    case 'TotalDaysOffInPeriod':
      return `
    <LineCondition>
      <LineConditionType>TotalDaysOffInPeriod</LineConditionType>
      <TotalDaysOffInPeriod><Days>${cond.days}</Days></TotalDaysOffInPeriod>
    </LineCondition>`;
    default:
      return '';
  }
}

function buildPairingProperty(wrapperType, rule) {
  const inner = buildPairingPropertyInner(rule);
  if (!inner) return '';
  return `
    <${wrapperType}>
      <PairingProperties>
        <PairingProperty>
          ${inner}
        </PairingProperty>
      </PairingProperties>
    </${wrapperType}>`;
}

function buildPairingPropertyInner(rule) {
  switch (rule.type) {
    case 'PairingCheckin': {
      const [h, m] = rule.time.split(':');
      return `
          <PairingPropertyType>PairingCheckin</PairingPropertyType>
          <PairingCheckin>
            <TimeType>TimeCondition</TimeType>
            <TimeCondition>
              <Operator>${rule.operator || 'LT'}</Operator>
              <Time><Hour>${h.padStart(2,'0')}</Hour><Minute>${m || '00'}</Minute></Time>
            </TimeCondition>
          </PairingCheckin>`;
    }
    case 'LayoverStations': {
      const stXml = rule.stations.map(s => `<Station>${s}</Station>`).join('');
      return `
          <PairingPropertyType>LandingsIn</PairingPropertyType>
          <LandingsIn>
            <AnyEvery>${rule.match || 'Any'}</AnyEvery>
            <Stations>${stXml}</Stations>
            <StringListWithOptionsType>Stations</StringListWithOptionsType>
          </LandingsIn>`;
    }
    case 'PairingLength': {
      return `
          <PairingPropertyType>PairingLength</PairingPropertyType>
          <PairingLength>
            <Length>${rule.days}</Length>
          </PairingLength>`;
    }
    case 'TimeAwayFromBase': {
      const [h, m] = (rule.time || '0:00').split(':');
      return `
          <PairingPropertyType>TimeAwayFromBase</PairingPropertyType>
          <TimeAwayFromBase>
            <TimeCondition>
              <Operator>${rule.operator || 'GT'}</Operator>
              <Time><Hour>${String(h).padStart(3,'0')}</Hour><Minute>${m || '00'}</Minute></Time>
            </TimeCondition>
          </TimeAwayFromBase>`;
    }
    case 'DutyIsRedeye':
      return `
          <PairingPropertyType>DutyIsRedeye</PairingPropertyType>
          <DutyIsRedeye></DutyIsRedeye>`;
    default:
      return '';
  }
}
