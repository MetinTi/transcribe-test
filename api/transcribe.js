export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const backendUrl = process.env.TRANSCRIBE_BACKEND_URL;
    if (!backendUrl) {
      return json(
        {
          error:
            'TRANSCRIBE_BACKEND_URL tanimli degil. Bu endpoint dis backend proxysi icin ayar bekliyor.',
        },
        500
      );
    }

    const form = await request.formData();
    const audio = form.get('audio');
    if (!audio || typeof audio === 'string') {
      return json({ error: 'audio dosyasi gerekli' }, 400);
    }

    const upstreamForm = new FormData();
    upstreamForm.append('audio', audio);

    const resp = await fetch(backendUrl, {
      method: 'POST',
      body: upstreamForm,
    });

    const responseText = await resp.text();
    let data = null;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = null;
    }

    if (!resp.ok) {
      return json(
        {
          error:
            data?.error ||
            data?.message ||
            responseText ||
            'Dis transcribe backend hatasi',
        },
        resp.status
      );
    }

    if (typeof data?.text !== 'string') {
      return json(
        { error: 'Dis backend gecersiz yanit dondu. JSON icinde text alani bekleniyor.' },
        502
      );
    }

    return json({ text: data.text }, 200);
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
