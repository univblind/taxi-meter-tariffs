// 요금표 검증기 (앱과 같은 규칙). 사용: node watch/validate.js tariffs.json
const fs = require('fs');
const lib = require('./tariffs-lib.js');
const file = process.argv[2] || 'tariffs.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!lib.validateTariffData(data)) {
  console.error('검증 실패: 앱이 이 요금표를 거부합니다. 형식(필드 이름, 숫자, 마지막 거리 구간 uptoM null 등)을 확인하세요.');
  process.exit(1);
}
console.log('검증 통과: v' + data.version + ' (' + data.updated + '), 요금표 ' + data.tariffs.length + '개');
