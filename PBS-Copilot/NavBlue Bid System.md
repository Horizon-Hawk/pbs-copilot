---
tags: [pbs, navblue, reference]
updated: 2026-07-03
---

# NavBlue Bid System — Reference

How the QXE (Horizon E175, GEG base) PBS bid works, and how the Copilot extension maps a
plain-English request into a real NavBlue bid. See also [[Copilot Bid Architecture]].

## Where the bid-option catalog lives

**`webapp/js/model/bidsconstants.js` → `BidsConstants.objPairingPrefDetailed`** — a clean,
unminified object with **177 bid options**. This is the master catalog; everything else
(`propertiesjsonutil.js`, the `partials/*.html`, the controllers) just consumes it. It is a
**public static file** — no auth, no live session needed.

Extracted to `navblue_bid_catalog.json` in the repo root (name → xml_type, value widget, inner
modifiers). Breakdown: **26 line-conditions**, **5 prefer-off types**, **91 pairing filters**,
plus value-widget types.

All partials/JS are fetchable with a plain GET:
`curl https://qxe.pbs.vmc.navblue.cloud/webapp/js/model/bidsconstants.js`

## The bid XML skeleton

A bid is `<BidLines>` containing bid groups. Group build order (matches NavBlue native):

```
StartBidGroup → Waive → LineCondition → PreferOff → AvoidPairings → AwardPairings
              → CSSN(ClearScheduleAndStartNext) → SysGen catch-all
```

Then a Reserve group, then trailing SysGen fallback groups (award-anything / go reserve).

> ⚠️ An **editable pairing group with zero editable bid lines → NavBlue 501.** Cherry-pick bids
> must be a SINGLE editable group; the trailing SysGen fallbacks already cover "award anything."

## "Set condition" (line condition) mappings — the important ones

| Plain English | XML `LineConditionType` | Value |
|---|---|---|
| minimum base layover 48hrs | **`TimeBetweenPairings`** | `<Time><Hour>048</Hour><Minute>00</Minute></Time>` |
| minimum credit window (no #) | **`MinimumCredit`** | simple — empty element |
| max 5 days on | `MaximumDaysOn` | `<Days>5</Days>` |
| min 2 days off | `MinimumDaysOff` | `<Days>2</Days>` |
| 14 days off in period | `TotalDaysOffInPeriod` | `<Days>14</Days>` |
| (any simple checkbox) | `<KEY>` verbatim | empty `<KEY></KEY>` |

Simple valueless conditions available (contract-specific): `OverSked, GDOCondition, MinimumGDO,
MaxAbove, MinimumThreshold, MidCredit, MaximumCredit, NoSameDayPairings, NoSameDayDutyStarts,
OneDayOffInSeven, BaseRest, MinimumTwoDaysOff, MinimumTwoDaysOn, MinimumConsecutiveDaysOff,
TwoConsecutiveDaysOffInSeven, TwentyFourHoursOffInSevenDays, FortyEightHoursOffInSevenDays,
FourDaysOffInFourteen, BlockOfThreeDaysOff, BlockOfFourDaysOff, MaxDaysOnFive, Max30In7,
MaxDutyDaysPerBidPeriod, TwelveHourRequiredRest, RequiredTenHourRest, CalendarDayFreeFromDuty`.

## Avoid / Award pairing filters (used ones)

- **Avoid landings in cities** ("avoid YYJ/YVR/BUR") → `AvoidPairings → LandingsIn` (Stations list)
- Prefer weekends off → `PreferOff → PreferOffWeekends`
- Cherry-pick specific trips → `AwardPairings → Pairing → PairingNumbers`
- Length / credit / redeyes / checkin windows → `PairingLength / PairingCredit / DutyIsRedeye /
  PairingCheckin` etc. (91 total in the catalog)

## Pairing data facts (parsing)

Pairing summary XML: attributes `OriginalNumber, Length, Credit (INTEGER MINUTES, e.g. "908"=15h08),
CheckinTime, Tafb, IsRedEye`. Dates/legs/layovers are in CHILD elements:
`<PairingOnDate Date=...>`, `<PairingLeg ArrLoc/DeptLoc>`, `<Layover Location=...>` — the parser
must descend into these (the old one only read flat attributes).

## Gotchas learned this session

- **Credit is integer minutes**, not `HH:MM` — mis-parsing broke all credit math.
- **Sonnet returns a `thinking` block first** — read the `text` content block, not `content[0]`.
- **Cache has no period stamp** — guard against building an August bid from July pairings.
- **Naked line conditions unverified live** — build, preview, and submit to **Default** target
  first before a real bid.
