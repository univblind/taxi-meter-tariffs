# Task — where does each taxi tariff legally apply?

Today is 2026-11-21. A taxi-meter app holds one fare table ("tariff") per city. The app must decide,
from the phone's reverse-geocoded address, whether the user is INSIDE the area where that tariff
applies. Today it only uses "within N km of the city centre", which wrongly applies e.g. Tokyo's
tariff in Yokohama or New York City's in Jersey City. Your job: for each tariff in your list, state
the administrative area in which that tariff is the regulated/applicable one for a street-hail trip
that STARTS there.

Useful background you should read first (do not modify):
- `C:\taxi-meter\docs\verification\2026-11-21\g01.json` … `g10.json` — last week's fare research;
  each entry's `note` / `caveats` / `sources` often already says which authority set the fare and
  for which area.
- `C:\taxi-meter\src\data\tariffs.json` — the tariffs (id, regionEn, lat/lng of the centre).

## What to produce

Write ONE JSON file at the path given in your task: an array with one object per tariff id:

```json
{
  "id": "JP-TOKYO",
  "scope": "part-of-city | municipality | metro | state | country",
  "regions": ["Tokyo", "東京都"],
  "cities": ["Chiyoda", "千代田区", "Musashino", "武蔵野市"],
  "citiesAreExhaustive": true,
  "adjacentDifferent": ["Yokohama", "Kawasaki", "Saitama", "Chiba"],
  "confidence": "high | medium | low",
  "source": "https://…",
  "notes": "한국어 한두 문장: 이 요금이 적용되는 구역과, 가까이 있지만 요금이 다른 지역."
}
```

Field meaning — these names will be compared with what Android's Geocoder returns
(`adminArea` → region, `locality` → city, `subAdminArea`, `subLocality`):

- `regions`: first-level administrative area(s) (state / province / prefecture / 道 / Land / région /
  emirate …) that contain the tariff area. Give BOTH the common English name and the name in the
  local language/script, as Google Maps would show them. Leave `[]` only if the country has no such
  level or the tariff is country-wide.
- `cities`: the municipalities (or wards/boroughs, where the address's "city" field would be a ward
  or borough, as in Tokyo's special wards) in which the tariff applies — English and local-script
  names. If the tariff covers the WHOLE of every region listed in `regions`, give `[]` and set
  `citiesAreExhaustive` to true.
- `citiesAreExhaustive`: true if the list is complete (or the whole region is covered); false if
  you listed only the main ones and more exist.
- `scope`: `country` = one national tariff (or national maximum) valid everywhere in the country;
  `state` = whole first-level region; `metro` = a multi-municipality licensing area;
  `municipality` = one city; `part-of-city` = only part of a city.
- `adjacentDifferent`: up to 8 nearby well-known places (within ~60 km) where a DIFFERENT taxi
  tariff applies, English names. This is the most valuable field — think of suburbs, neighbouring
  cities, airports in another jurisdiction.
- `confidence`: high = you are sure of the licensing/tariff area (well-documented, or confirmed on an
  official page); medium = reasonably sure; low = unsure.
- `notes` must be in Korean.

## Rules

- This is mostly geography/administration knowledge; use web search ONLY where you are genuinely
  unsure which area a tariff covers. The whole team shares a small search budget: at most 2 searches
  per city and about 50 in total for your list. Prefer reading the verification files above.
- Never invent a list of municipalities you are not sure about: set `citiesAreExhaustive` to false,
  list what you know, lower `confidence`, and say so in `notes`.
- Deregulated markets (company tariffs, e.g. Stockholm, Oslo, Helsinki, Auckland, Moscow): give the
  area in which the company whose tariff was used operates as a normal street-hail taxi (usually the
  city/metro area), `confidence` medium at most.
- Valid JSON only (no comments, no trailing commas). Read the file back once to check, and check
  every id in your list appears exactly once.

Final message: 5–10 lines in Korean — which tariffs are country/state-wide, which have notable
adjacent areas with different fares, and anything you could not determine.
