# NavBlue PBS Bid Command Reference (QXE / GEG-E75-CA)

Reverse-engineered from NavBlue's own webapp source (public, no-auth):
`webapp/js/services/bidlineservice.js`, `pairingfilterservice.js`, `pairingprefservice.js`,
`propertiesjsonutil.js`, `js/utils/parseuserpref.js`, `js/directives/biddirective.js`,
`partials/bidlinepairingmatchingfilterdetails.html`.

Goal: give the bid builder the full vocabulary so the LLM can COMPILE a plain-English request
into real NavBlue primitives instead of a narrow flat schema.

---

## 1. UI condition key → XML `LineConditionType` (confirmed remaps)

NavBlue's `bidlineservice.js` maps the editor's condition KEY to the XML `LineConditionType`:

| UI condition ("set condition …") | XML `LineConditionType` | Value shape |
|---|---|---|
| **Minimum Base Layover** | **`TimeBetweenPairings`** | `<Time><Hour>048</Hour><Minute>00</Minute></Time>` |
| **Minimum Credit (Window)** | **`MinimumCredit`** | **simple — no value** (empty element / checkmark) |
| Maximum GDO | `GDOCondition` | number |
| Over Schedule | `OverSked` | simple |
| Minimum Consecutive Days Off | `MinimumConsecutiveDaysOff` | `<Days>N</Days>` |
| Minimum Two Days Off | `MinimumTwoDaysOff` | simple |
| (default) any other key | key used verbatim as `LineConditionType` | per type |

> KEY FINDING: **"minimum base layover 48hrs" is NOT a new primitive — it serializes to
> `TimeBetweenPairings` (48:00), which `bid_builder.js` ALREADY builds.** And **"minimum credit
> window" is a simple valueless `MinimumCredit` line condition** — one small addition to the builder.

---

## 2. `LineConditionType` values (XML) already supported by bid_builder.js

`TimeBetweenPairings`, `MaximumDaysOn`, `MinimumConsecutiveDaysOff`, `TotalDaysOffInPeriod`,
`MinimumCreditWindow`, `MaximumCreditWindow`, `Pattern` (MinDaysOn/MaxDaysOn/MinDaysOff).

### To ADD (seen in NavBlue, not yet in builder)
- `MinimumCredit` — simple, no value (the "minimum credit window" checkmark).
- `GDOCondition` (Maximum GDO), `OverSked` (Over Schedule), `MinimumTwoDaysOff` — simple/number.

---

## 3. "Set condition" UI keys (from `key === '…'` in bidlineservice.js)

`MinimumBaseLayover`, `MaximumGDO`, `OverSchedule`, `Redeyes`, `StandUp`, `Charters`,
`PremiumRotation`, `DepartOn`, `PreferOff`, `AllowanceAmount`, `WOCLTurn`,
`VacationInviolateDaysOff`, `IfSOR`, `IfTOA`, `WithUDO`, `PureSplitDuty`, `MixedLine`,
`ReducedCreditLine`, `ReducedRegularLine`, `ReducedReserveLine`,
`StartBlankLine`, `StartFolo`, `StartPairings`, `StartReserve`, `StartSimpleReserve`.

---

## 4. Value/input types (`bidtype === '…'`) — how a condition's value is entered

Time/credit: `CreditIntervalType`, `TimeIntervalType`, `TimeRange`, `TimeOnlyType`, `TimeType`,
`TimeToDateRange`, `TimeToDates`, `TimeToEachDOW`.
Layover: `LayoverDateTimeRange`, `LayoverDayTimeRange`, `LayoverNumberType`.
Days/DOW: `NumberDays`, `NumberDaysType`, `DaysCondition`, `DaysOff`, `DOWs`, `Weekends`,
`WeekEnds`, `PreferOffWeekends`, plus DOW combos (`DOWListAndTime`, `DOWRangeTimeRange`, …).
Dates: `Dates`, `DateRange`, `DateTimeRange`, `DateRangeTimeList`, `ListOfDateTimeRange`, …
Pairing: `PairingNumberType`, `FlightNumberType`, `NumberLegsType`, `PercentType`, `Positions`,
`LeftToRightPairingPositions`.
Reserve/line: `MaxAbove`, `MaxAboveReserve`, `ReducedLowerLimit`, `ReducedCreditLine`,
`ReducedRegularLine`, `ReducedReserveLine`, `ReserveGeneralDay`, `AllOrNothing`, `Ordered`.
First/last out: `AMFirstOut`, `AMLastOut`, `PMFirstOut`, `PMLastOut`, `REFirstOut`, `RELastOut`,
`LongCallFirstOut`, `LongCallLastOut`.
Structural: `StartPairings`, `StartReserve`, `StartBlankLine`, `StartFolo`, `StartSimpleReserve`,
`Vacations`, `ElseStartNext`, `MixedLine`, `PureSplitDuty`, `WithUDO`.

---

## 5. Pairing property types (Avoid / Award / PreferOff filters) — bid_builder.js

`PairingCheckin`, `PairingCheckout`, `PairingLength`, `PairingCredit`, `AverageDailyCredit`,
`TimeAwayFromBase`, `LandingsIn` (from `LayoverStations` — this is the **avoid-landings-in-city**
rule), `DepartOnDayOfWeek`, `DepartOnTimeRange`, `DutyIsRedeye`, `Pairing`(PairingNumbers cherry-pick).
Seen in NavBlue and available to add: `Layovers` / `LayoversIncludeAllOf`, `LayoverDateTimeRange`.

`PreferOffType`: `PreferOffWeekends`, `PreferOffDates`, `PreferOffDateRange`, `PreferOffDaysOfWeek`.

---

## 6. Group build order (bid_builder.js, matches NavBlue native)

`StartBidGroup → Waive → LineCondition → PreferOff → AvoidPairings → AwardPairings → CSSN(ClearScheduleAndStartNext) → SysGen catch-all`.

---

## 7. WHERE THE FULL CATALOG LIVES (definitive)

**Authoritative source: `webapp/js/model/bidsconstants.js` → `BidsConstants.objPairingPrefDetailed`**
— a clean (unminified) object with **177 options**, each with `type` (XML: `LineConditionType` /
`PreferOffType` / boolean pairing property), `bidtype` (value widget: `TimeType`, `NumberDays`,
`CreditIntervalType`, `(simple)`, …), and `innerTypes` (`ElseStartNext`, `AllOrNothing`, …).
Extracted to **`navblue_bid_catalog.json`** in this repo — the compile target for the parser.
`propertiesjsonutil.js` only consumes this. NOT behind auth — public static file.

Validated against it: `TimeBetweenPairings` (LineConditionType, TimeType) = min base layover;
`MinimumCredit` (LineConditionType, simple) = min credit window. 26 line-conditions, 5 prefer-off
types, 91 pairing filters total.

(Earlier note also true: `propertiesjsonutil.js` holds `objLinePropertyDetailed` /
`objPairingPropertyDetailed` menus — but bidsconstants.js is the clean master.)

- **`objLinePropertyDetailed`** — the 10 "set condition" (line) types:
  `BlockTime, Credit, NumberOfLayovers, LayoverTime, LayoverStations, PreferOff, ListOfDates,
   RangeOfDates, DOWList, Weekends`
  (LayoverTime = base-layover duration; Credit = credit window.)

- **`objPairingPropertyDetailed`** — 101 pairing-filter types for Avoid/Award/PreferOff:
  ElseStartNext, Limit, AllowInterveningActivities, AircraftType, AverageDailyBlockTime,
  AverageDailyCredit, TotalPay, AllowanceAmount, CarryOut, CarryOutBlockTime, CarryOutCredit,
  Charters, CreditPerTAFB, BlockTimePerTAFBAsPercent, CreditPerTAFBAsPercent, DeadheadDays,
  DeadheadLegs, DepartOn, StartOnDateRange, StartOnDates, StartOnDOW, StartOnTimeRange,
  DutyDuration, DutyLegs, DutyOn, DutyDateList, DutyDateRange, DutyDayList, NumDuties, Employee,
  EnrouteCheckinTime, EnrouteCheckoutTime, FlightNumber, InChargeOnly, InPeriodBlockTime,
  InPeriodCredit, Junior, LandingIn, Language, Layover, Stations, LayoverDateList, LayoverDateRange,
  LayoverDayList, IncludesAllOf, LineCheckAirmen, PairingCheckInStation, PairingCheckinTime,
  CheckInDOWTimeRange, CheckInDateTimeRange, CheckInTime, PairingCheckoutTime, CheckOutTime,
  PairingBlockTime, PairingCredit, PairingInternational, PairingLength, PairingNumber,
  PairingStartStation, PairingEndStation, Position, DOWRange, DOWList, Redeyes, Senior, SitLength,
  StandUp, TimeAwayFromBase, TimeOffBeforeAfter, TotalLegsInPairing, TotalLegsInFirstDuty,
  TotalLegsInLastDuty, IfSOR, IfTOA, WOCLTurn, PremiumRotation, TotalCreditVsTotalPay,
  TotalPayVsTotalCredit, … (101 total).

To wire the full "architect," feed these two object literals (with their sub-field/value-type
structure) to the LLM as the compile target. They're already downloaded; no auth needed.
