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
        responseSchema: FAQ_RESPONSE_SCHEMA
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text.trim()) {
    throw new Error('Gemini returned an empty response');
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
