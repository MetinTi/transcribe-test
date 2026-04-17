const transcribeBtn = document.getElementById('transcribeBtn');
const analyzeBtn = document.getElementById('analyzeBtn');
const fileInput = document.getElementById('fileInput');
const recordStatus = document.getElementById('recordStatus');
const transcribeStatus = document.getElementById('transcribeStatus');
const analyzeStatus = document.getElementById('analyzeStatus');
const transcriptOutput = document.getElementById('transcriptOutput');
const analysisOutput = document.getElementById('analysisOutput');

// Public test icin backend endpointlerini canli domain uzerinden kullan.
const BACKEND_BASE_URL = 'https://YOUR-BACKEND.onrender.com';
const DIRECT_TRANSCRIBE_URL = `${BACKEND_BASE_URL}/transcribe`;
const DIRECT_ANALYZE_URL = `${BACKEND_BASE_URL}/analyze`;

let currentAudioFile = null;

function setRecordStatus(text) {
  recordStatus.textContent = text;
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0] || null;
  if (!file) return;
  currentAudioFile = file;
  setRecordStatus(`Dosya secildi: ${file.name}`);
  await runTranscription();
});

transcribeBtn.addEventListener('click', runTranscription);

async function runTranscription() {
  if (!currentAudioFile) return;
  transcribeStatus.textContent = 'Transcribe islemi basladi...';
  transcribeBtn.disabled = true;
  analyzeBtn.disabled = true;
  try {
    const formData = new FormData();
    formData.append('audio', currentAudioFile);
    const res = await fetch(DIRECT_TRANSCRIBE_URL, {
      method: 'POST',
      body: formData,
    });
    const responseText = await res.text();
    let data = null;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new Error(data?.error || responseText || 'Transcribe hatasi');
    }
    if (typeof data?.text !== 'string') {
      throw new Error('Gecersiz yanit: text alani bulunamadi');
    }
    transcriptOutput.value = data.text;
    analyzeBtn.disabled = transcriptOutput.value.trim().length === 0;
    transcribeStatus.textContent = 'Transcribe tamamlandi.';
  } catch (error) {
    transcribeStatus.textContent = `Hata: ${error.message}`;
  } finally {
    transcribeBtn.disabled = false;
  }
}

analyzeBtn.addEventListener('click', async () => {
  const transcript = transcriptOutput.value.trim();
  if (!transcript) return;
  analyzeStatus.textContent = 'Ozet cikariliyor...';
  analyzeBtn.disabled = true;
  try {
    const res = await fetch(DIRECT_ANALYZE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analiz hatasi');
    analysisOutput.value = data.analysis || '';
    analyzeStatus.textContent = 'Analiz tamamlandi.';
  } catch (error) {
    analyzeStatus.textContent = `Hata: ${error.message}`;
  } finally {
    analyzeBtn.disabled = false;
  }
});
