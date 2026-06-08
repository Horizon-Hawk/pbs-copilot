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
//   specific_pairings: ["G3027", "G3043"]    // cherry-picked numbers
// }]
//
// reserve: {
//   prefer_off: ["Weekends"]
// }

export function buildBidXml(model) {
  const lines = [];
  let lineNum = 1;

  // AvoidPairings / AwardPairings: content element comes BEFORE BidLineNumber/BidLineType
  const lineContentFirst = (type, innerXml, sysGen = false) => {
    const num = lineNum++;
    const tail = sysGen ? '<SysGen></SysGen>' : '<Editable></Editable>';
    return `    <BidLine>
      ${innerXml.trim()}
      <BidLineNumber>${num}</BidLineNumber>
      <BidLineType>${type}</BidLineType>
      ${tail}
    </BidLine>`;
  };

  // StartBidGroup / PreferOff / LineCondition / Else:
  // Order: BidLineNumber, BidLineType, Editable, ShowAnalyzeDetails (optional), then content
  const lineNumberFirst = (type, innerXml, extra = '') => {
    const num = lineNum++;
    return `    <BidLine>
      <BidLineNumber>${num}</BidLineNumber>
      <BidLineType>${type}</BidLineType>
      <Editable></Editable>
      ${extra ? extra + '\n      ' : ''}${innerXml.trim()}
    </BidLine>`;
  };

  // SysGen StartBidGroup: Number, Type, ShowAnalyzeDetails, content, SysGen (no Editable)
  const lineNumberFirstSysGen = (groupType, startTagInner) => {
    const num = lineNum++;
    return `    <BidLine>
      <BidLineNumber>${num}</BidLineNumber>
      <BidLineType>StartBidGroup</BidLineType>
      <ShowAnalyzeDetails>false</ShowAnalyzeDetails>
      <StartBidGroup>
        <BidGroupType>${groupType}</BidGroupType>
        ${startTagInner}
      </StartBidGroup>
      <SysGen></SysGen>
    </BidLine>`;
  };

  for (const group of model.bid_groups) {
    lines.push(lineNumberFirst('StartBidGroup',
      `<StartBidGroup>
        <BidGroupType>StartPairings</BidGroupType>
        <StartPairings></StartPairings>
      </StartBidGroup>`,
      '<ShowAnalyzeDetails>false</ShowAnalyzeDetails>'
    ));

    // Constants: avoid employees
    for (const empId of (model.constants?.avoid_employees || [])) {
      lines.push(lineContentFirst('AvoidPairings', buildAvoidEmployee(empId)));
    }

    // Constants: avoid pairings (PairingCheckin, LandingsIn, etc.)
    for (const rule of (model.constants?.avoid_pairings || [])) {
      const xml = buildPairingProperty('AvoidPairings', rule);
      if (xml) lines.push(lineContentFirst('AvoidPairings', xml));
    }

    // Constants: prefer off
    for (const pref of (model.constants?.prefer_off || [])) {
      const xml = buildPreferOff(pref);
      if (xml) lines.push(lineNumberFirst('PreferOff', xml));
    }

    // Constants: line conditions — skip MaximumDaysOn (unconfirmed structure)
    for (const cond of (model.constants?.line_conditions || [])) {
      if (cond.type === 'MaximumDaysOn') continue;
      const xml = buildLineCondition(cond);
      if (xml) lines.push(lineNumberFirst('LineCondition', xml));
    }

    // Group-specific avoid pairings
    for (const rule of (group.avoid_pairings || [])) {
      const xml = buildPairingProperty('AvoidPairings', rule);
      if (xml) lines.push(lineContentFirst('AvoidPairings', xml));
    }

    // Cherry-picked specific pairings
    if (group.specific_pairings?.length) {
      lines.push(lineContentFirst('AwardPairings', buildSpecificPairings(group.specific_pairings)));
    }

    // Preference-based award pairings
    for (const rule of (group.award_pairings || [])) {
      const xml = buildPairingProperty('AwardPairings', rule);
      if (xml) lines.push(lineContentFirst('AwardPairings', xml));
    }

    // Catch-all SysGen award — required at end of every group
    lines.push(lineContentFirst('AwardPairings',
      `<AwardPairings>
        <PairingProperties>
          <PairingProperty>
            <Award></Award>
            <PairingPropertyType>Award</PairingPropertyType>
          </PairingProperty>
        </PairingProperties>
      </AwardPairings>`,
      true
    ));
  }

  // Reserve group
  lines.push(lineNumberFirst('StartBidGroup',
    `<StartBidGroup>
      <BidGroupType>StartReserve</BidGroupType>
      <StartReserve></StartReserve>
    </StartBidGroup>`,
    '<ShowAnalyzeDetails>false</ShowAnalyzeDetails>'
  ));

  for (const pref of (model.reserve?.prefer_off || [])) {
    const xml = buildPreferOff(pref);
    if (xml) lines.push(lineNumberFirst('PreferOff', xml));
  }

  // SysGen fallback groups — required by NavBlue at end of every bid
  lines.push(lineNumberFirstSysGen('StartPairings', '<StartPairings></StartPairings>'));
  lines.push(lineContentFirst('AwardPairings',
    `<AwardPairings>
        <PairingProperties>
          <PairingProperty>
            <Award></Award>
            <PairingPropertyType>Award</PairingPropertyType>
          </PairingProperty>
        </PairingProperties>
      </AwardPairings>`,
    true  // sysGen
  ));
  lines.push(lineNumberFirstSysGen('StartReserve', '<StartReserve></StartReserve>'));

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<BidLines>
${lines.join('\n')}
</BidLines>`;
}

function buildAvoidEmployee(empId) {
  return `<AvoidPairings>
      <PairingProperties>
        <PairingProperty>
          <LegWithEmployeeNumber>
            <EmployeeNumbers>
              <EmployeeNumber>${empId}</EmployeeNumber>
            </EmployeeNumbers>
          </LegWithEmployeeNumber>
          <PairingPropertyType>LegWithEmployeeNumber</PairingPropertyType>
        </PairingProperty>
      </PairingProperties>
    </AvoidPairings>`;
}

function buildSpecificPairings(numbers) {
  const numXml = numbers.map(n => `<PairingNumber>${n}</PairingNumber>`).join('');
  return `<AwardPairings>
      <PairingProperties>
        <PairingProperty>
          <Pairing>
            <PairingNumberType>PairingNumbers</PairingNumberType>
            <PairingNumbers>${numXml}</PairingNumbers>
          </Pairing>
          <PairingPropertyType>Pairing</PairingPropertyType>
        </PairingProperty>
      </PairingProperties>
    </AwardPairings>`;
}

function buildPreferOff(pref) {
  if (pref === 'Weekends') {
    return `<PreferOff>
      <PreferOffType>PreferOffWeekends</PreferOffType>
      <PreferOffWeekends><Weekends></Weekends></PreferOffWeekends>
    </PreferOff>`;
  }
  if (pref.dates) {
    const datesXml = pref.dates.map(d => `<Date>${d}</Date>`).join('');
    return `<PreferOff>
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
      return `<LineCondition>
      <LineConditionType>TimeBetweenPairings</LineConditionType>
      <TimeBetweenPairings>
        <Time><Hour>${h}</Hour><Minute>00</Minute></Time>
      </TimeBetweenPairings>
    </LineCondition>`;
    }
    case 'MaximumDaysOn':
      return `<LineCondition>
      <LineConditionType>MaximumDaysOn</LineConditionType>
      <MaximumDaysOn><Days>${cond.days}</Days></MaximumDaysOn>
    </LineCondition>`;
    case 'MinimumConsecutiveDaysOff':
      return `<LineCondition>
      <LineConditionType>MinimumConsecutiveDaysOff</LineConditionType>
      <MinimumConsecutiveDaysOff><Days>${cond.days}</Days></MinimumConsecutiveDaysOff>
    </LineCondition>`;
    case 'TotalDaysOffInPeriod':
      return `<LineCondition>
      <LineConditionType>TotalDaysOffInPeriod</LineConditionType>
      <TotalDaysOffInPeriod><Days>${cond.days}</Days></TotalDaysOffInPeriod>
    </LineCondition>`;
    default:
      return '';
  }
}

// PairingPropertyType is always LAST inside PairingProperty
function buildPairingProperty(wrapperType, rule) {
  const result = buildPairingPropertyContent(rule);
  if (!result) return '';
  const { content, type } = result;
  return `<${wrapperType}>
      <PairingProperties>
        <PairingProperty>
          ${content.trim()}
          <PairingPropertyType>${type}</PairingPropertyType>
        </PairingProperty>
      </PairingProperties>
    </${wrapperType}>`;
}

function buildPairingPropertyContent(rule) {
  switch (rule.type) {
    case 'PairingCheckin': {
      const [h, m] = rule.time.split(':');
      return {
        content: `<PairingCheckin>
            <TimeCondition>
              <Operator>${rule.operator || 'LT'}</Operator>
              <Time><Hour>${h.padStart(2, '0')}</Hour><Minute>${m || '00'}</Minute></Time>
            </TimeCondition>
            <TimeType>TimeCondition</TimeType>
          </PairingCheckin>`,
        type: 'PairingCheckin'
      };
    }
    case 'LayoverStations': {
      // AnyEvery lives at PairingProperty level, not inside LandingsIn
      const stXml = rule.stations.map(s => `<Station>${s}</Station>`).join('');
      return {
        content: `<AnyEvery>${rule.match || 'Any'}</AnyEvery>
          <LandingsIn>
            <Stations>${stXml}</Stations>
            <StringListWithOptionsType>Stations</StringListWithOptionsType>
          </LandingsIn>`,
        type: 'LandingsIn'
      };
    }
    case 'PairingLength':
      return {
        content: `<PairingLength>
            <NumberDaysCondition>
              <Operator>${rule.operator || 'EQ'}</Operator>
              <Value>${rule.days}</Value>
            </NumberDaysCondition>
            <NumberDaysType>NumberDaysCondition</NumberDaysType>
          </PairingLength>`,
        type: 'PairingLength'
      };
    case 'TimeAwayFromBase': {
      const [h, m] = (rule.time || '0:00').split(':');
      return {
        content: `<TimeAwayFromBase>
            <TimeCondition>
              <Operator>${rule.operator || 'GT'}</Operator>
              <Time><Hour>${String(h)}</Hour><Minute>${m || '00'}</Minute></Time>
            </TimeCondition>
          </TimeAwayFromBase>`,
        type: 'TimeAwayFromBase'
      };
    }
    case 'DutyIsRedeye':
      return {
        content: `<DutyIsRedeye></DutyIsRedeye>`,
        type: 'DutyIsRedeye'
      };
    default:
      return null;
  }
}
