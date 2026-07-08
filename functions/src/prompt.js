const MAX_PROMPT_CHARS = 60000; // keep prompt within a safe token budget for the free tier

function buildFaqPrompt(groupName, messages) {
  let transcript = messages
    .map(m => `[${m.timestamp}] ${m.name}: ${m.text}`)
    .join('\n');

  if (transcript.length > MAX_PROMPT_CHARS) {
    transcript = transcript.slice(transcript.length - MAX_PROMPT_CHARS);
  }

  return `You are generating a public FAQ from a WhatsApp group's recent chat history.

Group name: ${groupName || 'WhatsApp Group'}

Below is a transcript of the group's recent messages. Identify the most common questions, topics, or recurring themes discussed, and produce a FAQ as a JSON array of objects, each with a "question" and "answer" string field. Keep answers concise and grounded only in what's actually in the transcript — do not invent content. If the transcript doesn't contain enough substance for a meaningful FAQ, return an array with a single item explaining that.

Transcript:
${transcript}`;
}

module.exports = { buildFaqPrompt };
