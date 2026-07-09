// gemini-2.0-flash's free-tier quota dropped to 0 (deprecated); 3.1 Flash Lite
// currently has the best free-tier headroom (15 RPM / 250K TPM) of the
// available models. Verify this exact ID in AI Studio's model detail page if
// it 404s — the UI display name doesn't always match the API model string.
const MODEL = 'gemini-3.1-flash-lite';

const FAQ_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      question: { type: 'STRING' },
      // Approximate — LLMs aren't reliable exact counters over long
      // transcripts, this is only used as a rough sort signal, not a claimed
      // precise stat.
      count: { type: 'INTEGER' },
      mostRecentDate: { type: 'STRING' },
      answers: {
        type: 'ARRAY',
        maxItems: 3,
        items: {
          type: 'OBJECT',
          properties: {
            text: { type: 'STRING' },
            date: { type: 'STRING' }
          },
          required: ['text', 'date']
        }
      }
    },
    required: ['question', 'count', 'mostRecentDate', 'answers']
  }
};

// Requests structured JSON directly from Gemini (rather than parsing free-form
// text) so the caller gets a reliable array of clustered FAQ entries.
async function callGeminiForFaq(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: FAQ_RESPONSE_SCHEMA,
        // Each FAQ entry can carry up to 3 dated answers plus JSON structure
        // overhead — a handful of entries can easily run to a few thousand
        // output tokens. Without an explicit ceiling here, the model falls
        // back to its own default, which is very plausibly what was cutting
        // generation short at 8-9 entries rather than the prompt's
        // "be comprehensive" instruction losing out to the model's judgment.
        // Generous on purpose: this is a cap, not a target, and the API
        // clamps to the model's real max if this exceeds it — combined with
        // our ~50K-token input cap, even this stays well under the 250K TPM
        // free-tier ceiling.
        maxOutputTokens: 32768
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(p => p.text || '').join('');
  if (!text.trim()) {
    throw new Error('Gemini returned an empty response');
  }

  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    // Most commonly MAX_TOKENS — the response is likely truncated (fewer FAQ
    // entries than the transcript actually supports). Logged rather than
    // thrown since a truncated-but-valid JSON array is still usable.
    console.warn(`Gemini generation finished with reason "${candidate.finishReason}" — output may be truncated`);
  }

  let faq;
  try {
    faq = JSON.parse(text);
  } catch {
    throw new Error('Gemini returned malformed JSON');
  }

  if (!Array.isArray(faq) || !faq.length) {
    throw new Error('Gemini returned an empty FAQ');
  }

  return faq;
}

module.exports = { callGeminiForFaq };
