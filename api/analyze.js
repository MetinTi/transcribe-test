export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return json({ error: 'OPENAI_API_KEY tanimli degil' }, 500);
    }

    const body = await request.json();
    const transcript = (body?.transcript || '').trim();
    if (!transcript) {
      return json({ error: 'transcript gerekli' }, 400);
    }

    const prompt = [
      'Asagidaki toplanti metnini analiz et.',
      'Cikti formati:',
      '1) Kisa Ozet',
      '2) Alinan Kararlar (madde madde)',
      '3) Aksiyonlar (Sorumlu + Son tarih varsa ekle)',
      '',
      transcript,
    ].join('\n');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'Sen toplanti notlarini net ve kisa ozetleyen bir asistansin. Turkce yaz.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return json({ error: data?.error?.message || 'OpenAI analiz hatasi' }, resp.status);
    }

    const analysis = data?.choices?.[0]?.message?.content || '';
    return json({ analysis }, 200);
  } catch (error) {
    return json({ error: error?.message || 'Bilinmeyen hata' }, 500);
  }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
