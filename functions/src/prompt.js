// The free-tier quota that actually bit us (generate_content_free_tier_input_
// token_count) is 250K INPUT tokens/min specifically — separate from output,
// not a combined budget as originally assumed here. It's also a per-minute
// window, so a slow day of testing won't fix a prompt that's simply too big.
// Chat-transcript text (short lines, names, timestamps, punctuation) tokenizes
// less efficiently than prose, so a conservative ~2.5 chars/token is assumed
// rather than the ~4 chars/token typical of continuous text: 450K chars ≈
// 180K tokens even at that ratio, leaving real margin under 250K.
const MAX_PROMPT_CHARS = 450000;

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

A transcript this size almost always covers at least 15-20 genuinely distinct topics — treat that as a floor, not a target to stop at once reached. If your first pass produces noticeably fewer, that's a signal you've merged distinct sub-topics together rather than that the group only discussed a few things; go back through the transcript and split them out.

Do not merge two topics into one entry just because they're in the same general area — "how to get a SIM card" and "which SIM provider works in region X" and "data roaming costs" are three separate entries, not one "SIM cards" entry, unless the transcript itself treats them as a single ongoing exchange. When in doubt, prefer a separate entry over folding it into a broader one — a FAQ reader would rather scan one extra heading than have their specific question buried inside a broader answer that doesn't obviously mention it.

For each distinct topic, provide:
- "question": a clear, representative phrasing of the question.
- "count": an approximate number of times this topic came up in the transcript. This is a rough estimate for sorting purposes only — do not spend effort trying to count precisely.
- "mostRecentDate": the date (from the transcript's timestamps) of the most recent message discussing this topic.
- "answers": up to 3 of the most recent distinct answers or pieces of advice given for this topic, each with its own "text" and "date" (from the transcript), ordered most recent first. Advice on these topics can change over time (e.g. a SIM provider that used to work but got restricted, a rule that got stricter) — keep the different versions as separate answer entries rather than merging or picking one arbitrarily.

Keep each answer's text concise and grounded only in what's actually in the transcript — do not invent content. If the transcript doesn't contain enough substance for a meaningful FAQ, return an array with a single item explaining that (count: 1, one answer).

The point of a FAQ is to let someone act on it without having to dig through the original chat, so if the transcript contains a concrete artifact that directly answers the question — a link or form URL, a phone number, a specific person's name, a price or measurement — include it verbatim in the answer text rather than describing it abstractly. "Fill out the form at [exact link]" is a better answer than "fill out the form"; "contact Ajit for fencing work" is a better answer than "contact the recommended vendor." Only omit a specific if it genuinely isn't in the transcript.

This applies just as much when the transcript names several people, not just one — if it lists specific candidates, nominees, volunteers, or committee/association members by name, name them in the answer too, rather than summarizing the list away as "some owners have volunteered" or "a list of names was collected." A vague summary of a concrete list is exactly the kind of information loss to avoid.

Transcript:
${transcript}`;
}

module.exports = { buildFaqPrompt };
