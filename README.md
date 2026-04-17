# Transcribe Test (Uygulamadan bagimsiz)

Tek bir Render servisi uzerinden hem web sayfasi hem API calisir. Dosya attach et, otomatik transcribe et, tek tikla ozet cikar. Vercel gerekmez.

## Local calistirma

1. `cd backend`
2. `npm install`
3. `.env` olustur:
   ```
   OPENAI_API_KEY=sk-...
   MAX_UPLOAD_MB=500
   CORS_ORIGIN=*
   ```
4. `npm start`
5. Tarayicidan ac: `http://localhost:8787`

## Canliya alma (Render, 5 dakika)

1. GitHub'a bu klasoru push et (ister kendi repo ister CepNot icinde subdir).
2. https://dashboard.render.com/ adresinden giris yap.
3. **New +** > **Blueprint** > repo sec (Render `render.yaml` dosyasini otomatik bulur).
4. Degiskenleri iste: `OPENAI_API_KEY` degerini yapistir.
5. Deploy bitince Render sana `https://transcribe-test-xxxx.onrender.com` gibi bir URL verir.
6. O URL'yi kim acarsa dosya yukleyip transcribe edebilir.

## Alternatif: Blueprint kullanmadan manuel

1. Render Dashboard > **New +** > **Web Service**.
2. Repo sec, **Root Directory** = `web-transcribe-test/backend`.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Environment:
   - `OPENAI_API_KEY=sk-...`
   - `MAX_UPLOAD_MB=500`
   - `CORS_ORIGIN=*`
6. Create Web Service.

## Endpoint'ler

- `GET /` : web arayuz (statik)
- `GET /health` : saglik kontrolu
- `POST /transcribe` (multipart/form-data, `audio` alani) : OpenAI transcribe
- `POST /analyze` (JSON `{ "transcript": "..." }`) : ozet + aksiyonlar

## Notlar

- Upload limiti `MAX_UPLOAD_MB` ile ayarlanabilir (default: 500 MB).
- OpenAI Whisper/transcribe endpoint'i tek request'te ~25 MB'a kadar kabul eder; cok buyuk dosyalar icin parcalama gerekebilir (ileride eklenebilir).
- Render free plan uzun aralikli cagrida uyuyabilir; ilk istek yavas olabilir.
