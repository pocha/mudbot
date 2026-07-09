// Free-tier headroom for gemini-3.1-flash-lite is 250K tokens/min; ~4 chars/token
// gives comfortable margin for prompt + output within a single request.
const MAX_PROMPT_CHARS = 200000;

function buildFaqPrompt(groupName, messages) {
  let transcript = messages
    .map(m => `[${m.timestamp}] ${m.name}: ${m.text}`)
    .join('\n');

  if (transcript.length > MAX_PROMPT_CHARS) {
    transcript = transcript.slice(transcript.length - MAX_PROMPT_CHARS);
  }

  return `You are generating a public FAQ from a WhatsApp group's chat history.

Group name: ${groupName || 'WhatsApp Group'}

Below is a transcript of the group's most recent messages. The same underlying question is often asked multiple times, in different words, by different people, at different points in time — cluster these into one FAQ entry per distinct topic rather than one entry per literal message. Extract every distinct recurring topic you can identify — this group likely covers many separate concerns (logistics, documentation, connectivity, safety, costs, etc). Comprehensiveness matters more than brevity; do not artificially limit the number of entries.

For each distinct topic, provide:
- "question": a clear, representative phrasing of the question.
- "count": an approximate number of times this topic came up in the transcript. This is a rough estimate for sorting purposes only — do not spend effort trying to count precisely.
- "mostRecentDate": the date (from the transcript's timestamps) of the most recent message discussing this topic.
- "answers": up to 3 of the most recent distinct answers or pieces of advice given for this topic, each with its own "text" and "date" (from the transcript), ordered most recent first. Advice on these topics can change over time (e.g. a SIM provider that used to work but got restricted, a rule that got stricter) — keep the different versions as separate answer entries rather than merging or picking one arbitrarily.

Keep each answer's text concise and grounded only in what's actually in the transcript — do not invent content. If the transcript doesn't contain enough substance for a meaningful FAQ, return an array with a single item explaining that (count: 1, one answer).

Transcript:
${transcript}`;
}

module.exports = { buildFaqPrompt };
