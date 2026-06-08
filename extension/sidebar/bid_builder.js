// Converts the internal bid model into NavBlue XML
//
// Model schema:
// {
//   constants: {
//     avoid_employees: ["12345"],
//     avoid_pairings: [{ type, ...params }],
//     prefer_off: [
//       'Weekends' |
//       { dates: ['2026-07-04', ...] } |
//       { dateRange: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } } |
//       { daysOfWeek: ['Saturday', 'Sunday'] }
//       // append esn: true to any object form to add ElseStartNextBidGroup
//     ],
//     line_conditions: [{ type, ...params }]
//   },
//   bid_groups: [{
//     name: string,
//     waives: ['MinimumDaysOffTo2', '1DayOffIn7', ...],  // Waive lines, placed at top per PBS manual
//     avoid_pairings: [{ type, ...params }],
//     award_pairings: [{ type, ...params }],             // preference-based, ordered
//     specific_pairings: ['G3027', 'G3043'],             // cherry-picked pairing numbers
//     cssn: boolean                                      // ClearScheduleAndStartNext before catch-all
//   }],
//   reserve: {
//     prefer_off: ['Weekends']
//   }
// }
//
// Group build order per PBS manual:
//   StartBidGroup → Waives → LineConditions → PreferOff → AvoidPairings → AwardPairings → CSSN → SysGen catch-all

export function buildBidXml(model) {
  const lines = [];
  let lineNum = 1;

  // AvoidPairings / AwardPairings: content element before BidLineNumber/BidLineType
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

  // StartBidGroup / PreferOff / LineCondition / Waive / Instruction:
  // BidLineNumber first, then BidLineType, Editable, optional ShowAnalyzeDetails, then content
  const lineNumberFirst = (type, innerXml, extra = '') => {
    const num = lineNum++;
    return `    <BidLine>
      <BidLineNumber>${num}</BidLineNumber>
      <BidLineType>${type}</BidLineType>
      <Editable></Editable>
      ${extra ? extra + '\n      ' : ''}${innerXml.trim()}
    </BidLine>`;
  };

  // SysGen StartBidGroup (no Editable)
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
    // 1. StartBidGroup
    lines.push(lineNumberFirst('StartBidGroup',
      `<StartBidGroup>
        <BidGroupType>StartPairings</BidGroupType>
        <StartPairings></StartPairings>
      </StartBidGroup>`,
      '<ShowAnalyzeDetails>false</ShowAnalyzeDetails>'
    ));

    // 2. Waive lines — must be at top of group per PBS manual
    for (const waiveType of (group.waives || [])) {
      lines.push(lineNumberFirst('Waive',
        `<Waive>
          <WaiveType>${waiveType}</WaiveType>
          <${waiveType}></${waiveType}>
        </Waive>`
      ));
    }

    // 3. Set conditions (LineConditions) — min/max credit, days-on, time-between, etc.
    for (const cond of (model.constants?.line_conditions || [])) {
      const xml = buildLineCondition(cond);
      if (xml) lines.push(lineNumberFirst('LineCondition', xml));
    }

    // 4. PreferOff (constants apply to every group)
    for (const pref of (model.constants?.prefer_off || [])) {
      const xml = buildPreferOff(pref);
      if (xml) lines.push(lineNumberFirst('PreferOff', xml));
    }

    // 5. AvoidPairings — employees first, then property-based
    for (const empId of (model.constants?.avoid_employees || [])) {
      lines.push(lineContentFirst('AvoidPairings', buildAvoidEmployee(empId)));
    }
    for (const rule of (model.constants?.avoid_pairings || [])) {
      const xml = buildPairingProperty('AvoidPairings', rule);
      if (xml) lines.push(lineContentFirst('AvoidPairings', xml));
    }
    for (const rule of (group.avoid_pairings || [])) {
      const xml = buildPairingProperty('AvoidPairings', rule);
      if (xml) lines.push(lineContentFirst('AvoidPairings', xml));
    }

    // 6. AwardPairings — cherry-picks first, then property-based preference
    if (group.specific_pairings?.length) {
      lines.push(lineContentFirst('AwardPairings', buildSpecificPairings(group.specific_pairings)));
    }
    for (const rule of (group.award_pairings || [])) {
      const xml = buildPairingProperty('AwardPairings', rule);
      if (xml) lines.push(lineContentFirst('AwardPairings', xml));
    }

    // 7. CSSN instruction — ClearScheduleAndStartNext; placed before catch-all per PBS manual
    if (group.cssn) {
      lines.push(lineNumberFirst('Instruction',
        `<Instruction>
          <InstructionType>ClearScheduleAndStartNext</InstructionType>
          <ClearScheduleAndStartNext></ClearScheduleAndStartNext>
        </Instruction>`
      ));
    }

    // 8. SysGen catch-all award — required at end of every pairing group
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

  // SysGen fallback groups — NavBlue requires these at the end of every bid
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
    true
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

// pref can be:
//   'Weekends' (string)
//   { dates: [...] }
//   { dateRange: { start, end } }
//   { daysOfWeek: [...] }
//   any object form can include esn: true
function buildPreferOff(pref) {
  const isStr = typeof pref === 'string';
  const esn = !isStr && pref.esn
    ? '\n      <ElseStartNextBidGroup></ElseStartNextBidGroup>'
    : '';

  if (pref === 'Weekends' || (!isStr && pref.type === 'Weekends')) {
    return `<PreferOff>
      <PreferOffType>PreferOffWeekends</PreferOffType>
      <PreferOffWeekends><Weekends></Weekends></PreferOffWeekends>${esn}
    </PreferOff>`;
  }
  if (!isStr && pref.dates) {
    const datesXml = pref.dates.map(d => `<Date>${d}</Date>`).join('');
    return `<PreferOff>
      <PreferOffType>PreferOffDates</PreferOffType>
      <PreferOffDates><Dates>${datesXml}</Dates></PreferOffDates>${esn}
    </PreferOff>`;
  }
  if (!isStr && pref.dateRange) {
    return `<PreferOff>
      <PreferOffType>PreferOffDateRange</PreferOffType>
      <PreferOffDateRange>
        <StartDate>${pref.dateRange.start}</StartDate>
        <EndDate>${pref.dateRange.end}</EndDate>
      </PreferOffDateRange>${esn}
    </PreferOff>`;
  }
  if (!isStr && pref.daysOfWeek) {
    const dowXml = pref.daysOfWeek.map(d => `<DayOfWeek>${d}</DayOfWeek>`).join('');
    return `<PreferOff>
      <PreferOffType>PreferOffDaysOfWeek</PreferOffType>
      <PreferOffDaysOfWeek>
        <DaysOfWeek>${dowXml}</DaysOfWeek>
      </PreferOffDaysOfWeek>${esn}
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
    case 'MinimumCreditWindow': {
      const h = String(Math.floor(cond.hours)).padStart(3, '0');
      const m = String(cond.minutes || 0).padStart(2, '0');
      return `<LineCondition>
      <LineConditionType>MinimumCreditWindow</LineConditionType>
      <MinimumCreditWindow>
        <Time><Hour>${h}</Hour><Minute>${m}</Minute></Time>
      </MinimumCreditWindow>
    </LineCondition>`;
    }
    case 'MaximumCreditWindow': {
      const h = String(Math.floor(cond.hours)).padStart(3, '0');
      const m = String(cond.minutes || 0).padStart(2, '0');
      return `<LineCondition>
      <LineConditionType>MaximumCreditWindow</LineConditionType>
      <MaximumCreditWindow>
        <Time><Hour>${h}</Hour><Minute>${m}</Minute></Time>
      </MaximumCreditWindow>
    </LineCondition>`;
    }
    case 'Pattern': {
      const parts = [];
      if (cond.minDaysOn  != null) parts.push(`<MinDaysOn><Days>${cond.minDaysOn}</Days></MinDaysOn>`);
      if (cond.maxDaysOn  != null) parts.push(`<MaxDaysOn><Days>${cond.maxDaysOn}</Days></MaxDaysOn>`);
      if (cond.minDaysOff != null) parts.push(`<MinDaysOff><Days>${cond.minDaysOff}</Days></MinDaysOff>`);
      return `<LineCondition>
      <LineConditionType>Pattern</LineConditionType>
      <Pattern>${parts.join('')}</Pattern>
    </LineCondition>`;
    }
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
    case 'PairingCheckout': {
      const [h, m] = rule.time.split(':');
      return {
        content: `<PairingCheckout>
            <TimeCondition>
              <Operator>${rule.operator || 'GT'}</Operator>
              <Time><Hour>${h.padStart(2, '0')}</Hour><Minute>${m || '00'}</Minute></Time>
            </TimeCondition>
            <TimeType>TimeCondition</TimeType>
          </PairingCheckout>`,
        type: 'PairingCheckout'
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
    case 'PairingCredit': {
      const [h, m] = rule.time.split(':');
      return {
        content: `<PairingCredit>
            <TimeCondition>
              <Operator>${rule.operator || 'GT'}</Operator>
              <Time><Hour>${h.padStart(3, '0')}</Hour><Minute>${m || '00'}</Minute></Time>
            </TimeCondition>
            <TimeType>TimeCondition</TimeType>
          </PairingCredit>`,
        type: 'PairingCredit'
      };
    }
    case 'AverageDailyCredit': {
      const [h, m] = rule.time.split(':');
      return {
        content: `<AverageDailyCredit>
            <TimeCondition>
              <Operator>${rule.operator || 'GT'}</Operator>
              <Time><Hour>${h.padStart(2, '0')}</Hour><Minute>${m || '00'}</Minute></Time>
            </TimeCondition>
            <TimeType>TimeCondition</TimeType>
          </AverageDailyCredit>`,
        type: 'AverageDailyCredit'
      };
    }
    case 'DepartOnDayOfWeek': {
      const dowXml = rule.days.map(d => `<DayOfWeek>${d}</DayOfWeek>`).join('');
      return {
        content: `<DepartOnDayOfWeek>
            <DaysOfWeek>${dowXml}</DaysOfWeek>
          </DepartOnDayOfWeek>`,
        type: 'DepartOnDayOfWeek'
      };
    }
    case 'DepartOnTimeRange': {
      const [sh, sm] = rule.start.split(':');
      const [eh, em] = rule.end.split(':');
      return {
        content: `<DepartOnTimeRange>
            <StartTime><Hour>${sh.padStart(2, '0')}</Hour><Minute>${sm || '00'}</Minute></StartTime>
            <EndTime><Hour>${eh.padStart(2, '0')}</Hour><Minute>${em || '00'}</Minute></EndTime>
          </DepartOnTimeRange>`,
        type: 'DepartOnTimeRange'
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
