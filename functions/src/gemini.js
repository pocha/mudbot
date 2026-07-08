const MODEL = 'gemini-2.0-flash';

const FAQ_RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      question: { type: 'STRING' },
      answer: { type: 'STRING' }
    },
    required: ['question', 'answer']
  }
};

// Requests structured JSON directly from Gemini (rather than parsing free-form
// text) so the caller gets a reliable array of {question, answer} objects.
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
