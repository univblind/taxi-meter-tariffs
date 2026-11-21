# Taxi fare verification — instructions for research agents

Today is 2026-11-21. You are verifying the CURRENT regulated meter fare of the standard
street-hail taxi (the ordinary licensed metered cab a tourist would flag down) for a list of
cities. The data feeds a taxi-meter app, so wrong numbers are worse than missing numbers.

## Research rules

- Do NOT rely on memory. Fares change often; find what is in force today.
- Search in the local language as well as English. Prefer official sources: city / transport
  authority / regulator pages, official gazettes and fare ordinances. Corroborate with a second
  source (a recent news article about the latest revision, or the taxi association's fare page).
- For every city explicitly check whether there was a revision in 2024, 2025 or 2026.
- Beware of undated aggregator sites (numbeo, taxi-calculator, travel blogs) and of news pages
  that show today's date above an old article. Use them only as a cross-check.
- If sources conflict, prefer the newest official one and say so in `caveats`.
- If you cannot verify a city to at least medium confidence, still write an entry with
  `"confidence": "low"` and put what you found in `caveats`. Never invent numbers.
- Where a city has no single regulated tariff (fares set by each company, or a legal maximum),
  use the legal maximum if one exists, otherwise the published tariff of the largest company,
  and say which in `note`.

## How the app's meter engine works (so you can map the tariff onto it)

- The flag-fall `baseFare` covers the first `baseDistanceM` metres (0 if none is included).
- After that the fare rises by `fare` for every `unitM` metres. `distanceTiers` is a list ordered
  by cumulative trip distance: a tier applies while cumulative distance < `uptoM`; the last tier
  has `"uptoM": null`. Use several tiers when the per-km rate changes with distance.
- When speed is at or below `slowSpeedKmh`, distance charging stops and instead the fare rises
  by `timeFare` every `timeUnitSec` seconds (waiting / slow traffic). It is EITHER distance OR
  time at any moment. If the real tariff charges both simultaneously, pick the closest mapping
  and explain in `caveats`.
- If the ordinance gives no crossover speed, compute it: `unitM / timeUnitSec * 3.6` (km/h),
  rounded to 2 decimals, using the first distance tier.
- Converting "X per km" to a tick: choose the meter's real increment if published (e.g. 0.10 EUR,
  100 JPY); otherwise the smallest natural unit of the currency. Then
  `unitM = increment / ratePerKm * 1000` (2 decimals). Same for "Y per hour":
  `timeUnitSec = increment / ratePerHour * 3600` (2 decimals).
- `minFare`: minimum total charge, or null.
- `extras`: fixed amounts ALWAYS added at pick-up on every ordinary trip (state surcharges, taxes,
  fuel levy). Not airport fees, tolls, luggage or booking fees.
- `surcharges`: time-of-day / day-of-week rules.
  - `startHour`, `endHour`: local clock hours 0–24, decimals allowed (21.5 = 21:30). If start >
    end the band crosses midnight.
  - `days`: optional array, 0 = Sunday … 6 = Saturday. For a band crossing midnight the day is
    the day the band STARTS. Omit for every day. Public holidays cannot be expressed: map them to
    Sunday if the tariff treats them alike, and mention it in `caveats`.
  - `percent`: percentage added to flag-fall, distance and time charges. If several active bands
    have `percent`, only the largest is applied (they are not added together).
  - `flat`: fixed amount added once at pick-up while the band is active (these DO add up).
  - `baseFare`: the flag-fall to use instead of the normal one while the band is active (then
    `percent` is not applied on top of the flag-fall, only to distance/time ticks).
  - A night/weekend tariff with its own per-km rate: express it as `percent` = how much higher
    the per-km rate is, plus `baseFare` if the flag-fall differs.
- Not modelled (mention in `note` if relevant, do not try to encode): airport fees, tolls,
  out-of-city surcharges, luggage, extra passengers, booking fees, congestion charges that apply
  only in a zone.

## Output

Write ONE JSON file at the path given in your task: a JSON array, one object per city, using
exactly these keys:

```json
{
  "id": "JP-TOKYO",
  "confidence": "high",
  "effectiveDate": "2022-11-14",
  "source": "https://… (the main page you actually read)",
  "sources": ["https://…", "https://…"],
  "baseFare": 500,
  "baseDistanceM": 1096,
  "distanceTiers": [{ "uptoM": null, "unitM": 255, "fare": 100 }],
  "timeUnitSec": 95,
  "timeFare": 100,
  "slowSpeedKmh": 10,
  "minFare": null,
  "extras": [],
  "surcharges": [{ "name": "深夜", "startHour": 22, "endHour": 5, "percent": 20 }],
  "note": "한국어 한두 문장: 어떤 택시의 요금인지, 시행일, 반영하지 못한 추가금.",
  "caveats": "Free text: approximations made, conflicts between sources, anything unverified."
}
```

- `confidence`: "high" = an official page (or the ordinance) read directly AND consistent with a
  second source; "medium" = two independent reliable non-official sources agree, or one official
  source that is clearly current; "low" = anything weaker.
- `effectiveDate`: when the current schedule took effect (YYYY-MM-DD, or YYYY-MM if the day is
  unknown, or null).
- `note` MUST be written in Korean (it is shown to Korean users). `extras[].name` in Korean.
  `surcharges[].name` is a short label in the local language or English (e.g. "NIGHT", "深夜").
- Numbers are plain JSON numbers in the local currency (no strings, no thousands separators).
- The file must be valid JSON (no comments, no trailing commas). Read it back once to check.

Your final message: a short Korean summary, one line per city: confidence, effective date, and
anything notable (recent or upcoming revision, things you could not verify). No long tables.
