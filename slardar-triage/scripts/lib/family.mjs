// 同一根因常带序号、logId 等易变后缀，分成多个 Issue；去掉后聚成一族，避免重复推荐。
const RULES = [
  [/_(\d+)(?=\s+timeout)/g, ''],
  [/logId=[0-9A-Za-z]+/g, 'logId=<id>'],
  [/ttLogId: Optional\("[^"]*"\)/g, 'ttLogId: <id>'],
  [/ttLogId: [0-9A-Za-z]+/g, 'ttLogId: <id>'],
  [/requestID: [^,]*/g, 'requestID: <id>'],
];

export function familyKey(message) {
  let key = String(message ?? '');
  for (const [re, rep] of RULES) key = key.replace(re, rep);
  return key.trim();
}
