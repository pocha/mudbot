const { isDuplicateMessage } = require('../services/helpers/messageSimilarity');

test('exact match', () => {
  expect(isDuplicateMessage('Hello world', 'Hello world')).toBe(true);
});

test('case and whitespace normalization', () => {
  expect(isDuplicateMessage('Hello World', 'hello   world')).toBe(true);
});

test('small edit distance (templated variable) counts as duplicate at default threshold', () => {
  expect(isDuplicateMessage('Your order #4521 has shipped', 'Your order #4522 has shipped')).toBe(true);
});

test('clearly different messages are not duplicates', () => {
  expect(isDuplicateMessage('Hi there, how are you?', 'Reminder: your appointment is tomorrow at 5pm')).toBe(false);
});

test('threshold override changes the result for a borderline pair', () => {
  const a = 'Please confirm your seat for the workshop on Friday';
  const b = 'Please confirm your seat for the meetup on Friday';
  expect(isDuplicateMessage(a, b, 0.7)).toBe(true);
  expect(isDuplicateMessage(a, b, 0.98)).toBe(false);
});

test('oversized input falls back to exact-match semantics', () => {
  const long = 'a'.repeat(5000);
  expect(isDuplicateMessage(long, long)).toBe(true);
  expect(isDuplicateMessage(long, long + 'b')).toBe(false);
});

test('date/time masking catches a short message differing only in an embedded date', () => {
  expect(isDuplicateMessage('See you on 23/09/2026', 'See you on 24/09/2026')).toBe(true);
});

test('date/time masking catches a time-only difference', () => {
  expect(isDuplicateMessage('Meeting at 5:00pm', 'Meeting at 6:30pm')).toBe(true);
});

test('date/time masking catches relative/natural phrasing via chrono-node', () => {
  expect(isDuplicateMessage('See you tomorrow', 'See you next Monday')).toBe(true);
});

test('generic numbers (e.g. an OTP) are deliberately not masked', () => {
  expect(isDuplicateMessage('Your OTP is 4521', 'Your OTP is 8892')).toBe(false);
});

test('real sample: Zabbix-style monitoring alert differing only in its Time line', () => {
  const alert = (time) => `🚨 Switch DOWN ALERT

*Host:* TEST Switch
*Issue:* ICMP Ping: Unavailable by ICMP ping
*Time:* ${time}
*Severity:* High
*Status:* PROBLEM
*Host IP*: 192.168.91.158

⚠️ Immediate action required!
Check device connectivity immediately.

────────────────────────────────
⚡ Automated alert from Zabbix Monitoring System
                           IYC Network Team`;

  expect(isDuplicateMessage(alert('2026.09.07 12:40:38'), alert('2026.09.08 09:15:02'))).toBe(true);
});
