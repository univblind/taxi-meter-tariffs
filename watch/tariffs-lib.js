"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FALLBACK_TARIFF_ID = exports.BUNDLED_DATA = exports.SCHEMA_VERSION = void 0;
exports.localDay = localDay;
exports.applyUpcoming = applyUpcoming;
exports.nextUpcoming = nextUpcoming;
exports.getTariffData = getTariffData;
exports.setTariffData = setTariffData;
exports.getCountries = getCountries;
exports.getTariffs = getTariffs;
exports.getTariff = getTariff;
exports.getCountry = getCountry;
exports.tariffsOfCountry = tariffsOfCountry;
exports.validateTariffData = validateTariffData;
/**
 * 국가·지역별 택시 미터 요금표 저장소.
 *
 * 요금표 원본은 tariffs.json 이다. 앱에는 이 파일이 내장되어 오프라인에서도 동작하고,
 * 인터넷이 되면 같은 형식의 최신 파일을 내려받아(src/lib/tariffSync.ts) 교체한다.
 * 그래서 요금표는 상수가 아니라 "현재 데이터"를 읽는 함수로 접근한다.
 */
const tariffs_json_1 = __importDefault(require("../tariffs.json"));
/** 앱이 이해하는 요금표 파일 형식 버전. 형식이 바뀌어 옛 앱이 읽을 수 없게 되면 올린다. */
exports.SCHEMA_VERSION = 1;
/** 앱에 내장된 요금표 */
exports.BUNDLED_DATA = tariffs_json_1.default;
let current = exports.BUNDLED_DATA;
/** 오늘 날짜 기준으로 예정 변경까지 반영한 요금표 */
let effective = [];
let effectiveDay = '';
let tariffMap = new Map();
let countryMap = new Map();
/** 기기 시계 기준 오늘 날짜 (YYYY-MM-DD) */
function localDay(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/**
 * 시행일이 지난 예정 변경을 요금표에 반영한다.
 * 요금 인상이 미리 고시되면 upcoming 에 넣어 두기만 하면 되고, 그날이 되면 앱이 알아서 새 요금을 쓴다.
 */
function applyUpcoming(t, day) {
    if (!t.upcoming?.length)
        return t;
    let out = t;
    const due = t.upcoming.filter((c) => c.effective <= day).sort((a, b) => a.effective.localeCompare(b.effective));
    for (const c of due)
        out = { ...out, ...c.set, effective: c.effective };
    return out;
}
/** 아직 시행되지 않은 예정 변경 중 가장 가까운 것 */
function nextUpcoming(t, day = localDay()) {
    const later = (t.upcoming ?? []).filter((c) => c.effective > day).sort((a, b) => a.effective.localeCompare(b.effective));
    return later[0] ?? null;
}
function rebuildIndex(day = localDay()) {
    effectiveDay = day;
    effective = current.tariffs.map((t) => applyUpcoming(t, day));
    tariffMap = new Map(effective.map((t) => [t.id, t]));
    countryMap = new Map(current.countries.map((c) => [c.code, c]));
}
rebuildIndex();
/** 날짜가 바뀌었으면 예정 변경을 다시 반영한다 (앱을 켜 둔 채 시행일을 맞는 경우) */
function ensureToday() {
    const day = localDay();
    if (day !== effectiveDay)
        rebuildIndex(day);
}
function getTariffData() {
    return current;
}
/** 요금표 전체를 교체한다 (검증을 통과한 데이터만 넘길 것) */
function setTariffData(data) {
    current = data;
    rebuildIndex();
}
/** 인구가 많은 순서. 인구가 적히지 않은 것은 뒤로, 같으면 원래 순서 (Array.sort 는 안정 정렬) */
function byPopulation(list) {
    return [...list].sort((a, b) => (b.population ?? -1) - (a.population ?? -1));
}
function getCountries() {
    return byPopulation(current.countries);
}
function getTariffs() {
    ensureToday();
    return effective;
}
function getTariff(id) {
    ensureToday();
    return tariffMap.get(id);
}
function getCountry(code) {
    return countryMap.get(code.toUpperCase());
}
function tariffsOfCountry(code) {
    const c = code.toUpperCase();
    return byPopulation(getTariffs().filter((t) => t.country === c));
}
/** 앱이 어떤 정보도 얻지 못했을 때 쓰는 기본 요금표 */
exports.FALLBACK_TARIFF_ID = 'KR-SEOUL';
// ───────────────────────── 검증 ─────────────────────────
function isNum(x) {
    return typeof x === 'number' && Number.isFinite(x);
}
function isStr(x) {
    return typeof x === 'string' && x.length > 0;
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function validNames(x) {
    return x === undefined || (Array.isArray(x) && x.every(isStr));
}
function validBeyond(list) {
    if (list === undefined)
        return true;
    if (!Array.isArray(list))
        return false;
    for (const r of list) {
        if (!r || !isStr(r.name))
            return false;
        for (const k of ['percent', 'percentWhenSurcharged', 'flat'])
            if (r[k] !== undefined && (!isNum(r[k]) || r[k] < 0))
                return false;
        for (const k of ['where', 'outside']) {
            const w = r[k];
            if (w === undefined)
                continue;
            if (!w || typeof w !== 'object')
                return false;
            if (!validNames(w.regions) || !validNames(w.subregions) || !validNames(w.cities))
                return false;
        }
        if (r.bands !== undefined) {
            if (!Array.isArray(r.bands))
                return false;
            for (const b of r.bands)
                if (!b || !isNum(b.startHour) || !isNum(b.endHour) || !isNum(b.percent) || b.percent < 0)
                    return false;
        }
    }
    return true;
}
function validTariff(t) {
    if (!validTariffBody(t))
        return false;
    // 예정 변경은 반영한 뒤의 요금표도 올바라야 한다
    if (t.upcoming !== undefined) {
        if (!Array.isArray(t.upcoming))
            return false;
        for (const c of t.upcoming) {
            if (!c || !isStr(c.effective) || !DAY.test(c.effective) || !c.set || typeof c.set !== 'object')
                return false;
            if (!validTariffBody({ ...t, ...c.set }))
                return false;
        }
    }
    return true;
}
function validTariffBody(t) {
    if (!t || typeof t !== 'object')
        return false;
    if (!validBeyond(t.beyond))
        return false;
    if (!isStr(t.id) || !isStr(t.country) || !isStr(t.region) || !isStr(t.regionEn))
        return false;
    if (!isNum(t.lat) || !isNum(t.lng) || !isNum(t.radiusKm) || t.radiusKm <= 0)
        return false;
    if (!isStr(t.currency) || typeof t.symbol !== 'string')
        return false;
    if (!isNum(t.decimals) || t.decimals < 0 || t.decimals > 3)
        return false;
    if (!isNum(t.baseFare) || t.baseFare < 0 || !isNum(t.baseDistanceM) || t.baseDistanceM < 0)
        return false;
    if (!Array.isArray(t.distanceTiers) || t.distanceTiers.length === 0)
        return false;
    for (const d of t.distanceTiers) {
        if (!d || !isNum(d.unitM) || d.unitM <= 0 || !isNum(d.fare) || d.fare <= 0)
            return false;
        if (d.uptoM !== null && !isNum(d.uptoM))
            return false;
    }
    // 마지막 구간은 끝이 없어야 한다
    if (t.distanceTiers[t.distanceTiers.length - 1].uptoM !== null)
        return false;
    if (!isNum(t.timeUnitSec) || t.timeUnitSec < 0 || !isNum(t.timeFare) || t.timeFare < 0)
        return false;
    if (!isNum(t.slowSpeedKmh) || t.slowSpeedKmh < 0)
        return false;
    if (t.minFare !== undefined && (!isNum(t.minFare) || t.minFare < 0))
        return false;
    if (t.discountAbove !== undefined) {
        const d = t.discountAbove;
        if (!d || !isNum(d.fare) || d.fare <= 0 || !isNum(d.percent) || d.percent <= 0 || d.percent >= 100)
            return false;
    }
    if (!Array.isArray(t.surcharges))
        return false;
    for (const s of t.surcharges) {
        if (!s || !isStr(s.name) || !isNum(s.startHour) || !isNum(s.endHour))
            return false;
        if (s.startHour < 0 || s.startHour > 24 || s.endHour < 0 || s.endHour > 24)
            return false;
        if (s.days !== undefined && !(Array.isArray(s.days) && s.days.every((d) => isNum(d) && d >= 0 && d <= 6)))
            return false;
        if (s.percent !== undefined && !isNum(s.percent))
            return false;
        if (s.flat !== undefined && !isNum(s.flat))
            return false;
        if (s.baseFare !== undefined && !isNum(s.baseFare))
            return false;
    }
    if (t.extras !== undefined) {
        if (!Array.isArray(t.extras))
            return false;
        for (const e of t.extras)
            if (!e || !isStr(e.name) || !isNum(e.amount))
                return false;
    }
    return typeof t.note === 'string';
}
/**
 * 내려받은(또는 저장해 둔) 요금표가 앱이 쓸 수 있는 형식인지 확인한다.
 * 하나라도 이상하면 통째로 거부해 내장 요금표를 계속 쓰게 한다.
 */
function validateTariffData(x) {
    const d = x;
    if (!d || typeof d !== 'object')
        return null;
    if (d.schema !== exports.SCHEMA_VERSION)
        return null;
    if (!Number.isInteger(d.version) || d.version < 1)
        return null;
    if (!isStr(d.updated))
        return null;
    if (!Array.isArray(d.countries) || !Array.isArray(d.tariffs) || d.tariffs.length === 0)
        return null;
    if (!d.tariffs.every(validTariff))
        return null;
    const ids = new Set(d.tariffs.map((t) => t.id));
    if (ids.size !== d.tariffs.length)
        return null;
    for (const c of d.countries) {
        if (!c || !isStr(c.code) || !isStr(c.name) || typeof c.flag !== 'string')
            return null;
        if (!ids.has(c.defaultTariffId))
            return null;
    }
    // 모든 요금표의 국가가 국가 목록에 있어야 한다
    const codes = new Set(d.countries.map((c) => c.code));
    if (!d.tariffs.every((t) => codes.has(t.country)))
        return null;
    // 기본 요금표가 사라지면 안 된다
    if (!ids.has(exports.FALLBACK_TARIFF_ID))
        return null;
    return d;
}
