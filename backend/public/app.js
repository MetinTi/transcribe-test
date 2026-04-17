const transcribeBtn = document.getElementById('transcribeBtn');
const analyzeBtn = document.getElementById('analyzeBtn');
const copyTranscriptBtn = document.getElementById('copyTranscriptBtn');
const copyAnalysisBtn = document.getElementById('copyAnalysisBtn');
const fileInput = document.getElementById('fileInput');
const recordStatus = document.getElementById('recordStatus');
const transcribeStatus = document.getElementById('transcribeStatus');
const analyzeStatus = document.getElementById('analyzeStatus');
const transcriptOutput = document.getElementById('transcriptOutput');
const analysisOutput = document.getElementById('analysisOutput');

const TRANSCRIBE_URL = '/transcribe';
const ANALYZE_URL = '/analyze';

let currentAudioFile = null;

function setRecordStatus(text) {
  recordStatus.textContent = text;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0] || null;
  if (!file) return;
  currentAudioFile = file;
  setRecordStatus(`Dosya secildi: ${file.name} (${formatBytes(file.size)})`);
  await runTranscription();
});

transcribeBtn.addEventListener('click', runTranscription);

copyTranscriptBtn.addEventListener('click', async () => {
  const value = transcriptOutput.value.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    transcribeStatus.textContent = 'Transkript kopyalandi.';
  } catch (error) {
    transcribeStatus.textContent = `Kopyalanamadi: ${error.message}`;
  }
});

copyAnalysisBtn.addEventListener('click', async () => {
  const value = analysisOutput.value.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    analyzeStatus.textContent = 'Ozet kopyalandi.';
  } catch (error) {
    analyzeStatus.textContent = `Kopyalanamadi: ${error.message}`;
  }
});

async function runTranscription() {
  if (!currentAudioFile) return;
  const startedAt = Date.now();
  transcribeStatus.textContent = `Transcribe basladi. ${formatBytes(currentAudioFile.size)} dosya isleniyor, buyuk dosyalar parcalanarak islenir, lutfen bekleyin...`;
  transcribeBtn.disabled = true;
  analyzeBtn.disabled = true;
  try {
    const formData = new FormData();
    formData.append('audio', currentAudioFile);
    const res = await fetch(TRANSCRIBE_URL, {
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
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const chunkInfo = data.chunks && data.chunks > 1 ? ` - ${data.chunks} parcada islendi` : '';
    transcribeStatus.textContent = `Transcribe tamamlandi (${elapsed} sn)${chunkInfo}.`;
  } catch (error) {
    transcribeStatus.textContent = `Hata: ${error.message}`;
  } finally {
    transcribeBtn.disabled = !currentAudioFile;
  }
}

analyzeBtn.addEventListener('click', async () => {
  const transcript = transcriptOutput.value.trim();
  if (!transcript) return;
  const startedAt = Date.now();
  analyzeStatus.textContent = 'Ozet cikariliyor...';
  analyzeBtn.disabled = true;
  try {
    const res = await fetch(ANALYZE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analiz hatasi');
    analysisOutput.value = data.analysis || '';
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    analyzeStatus.textContent = `Analiz tamamlandi (${elapsed} sn).`;
  } catch (error) {
    analyzeStatus.textContent = `Hata: ${error.message}`;
  } finally {
    analyzeBtn.disabled = false;
  }
});
