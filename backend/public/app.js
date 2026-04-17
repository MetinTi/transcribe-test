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
  transcribeStatus.textContent = `Yukleniyor... ${formatBytes(currentAudioFile.size)}`;
  transcribeBtn.disabled = true;
  analyzeBtn.disabled = true;
  transcriptOutput.value = '';
  try {
    const formData = new FormData();
    formData.append('audio', currentAudioFile);
    const res = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok && !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const accumulatedChunks = [];
    let finalText = null;
    let totalChunks = 0;
    let lastError = null;

    const handleEvent = (evt) => {
      if (!evt || !evt.type) return;
      if (evt.type === 'status') {
        transcribeStatus.textContent = evt.message || 'Isleniyor...';
      } else if (evt.type === 'chunk') {
        accumulatedChunks[evt.index - 1] = evt.text || '';
        totalChunks = evt.total || totalChunks;
        transcriptOutput.value = accumulatedChunks.filter(Boolean).join('\n\n');
        transcribeStatus.textContent = `Parca ${evt.index}/${evt.total} tamamlandi (canli akis)`;
      } else if (evt.type === 'done') {
        finalText = evt.text || accumulatedChunks.filter(Boolean).join('\n\n');
        totalChunks = evt.chunks || totalChunks;
      } else if (evt.type === 'error') {
        lastError = evt.error || 'Bilinmeyen hata';
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {}
      }
    }
    if (buffer.trim()) {
      try { handleEvent(JSON.parse(buffer.trim())); } catch {}
    }

    if (lastError) throw new Error(lastError);
    if (finalText == null) throw new Error('Akis beklenmedik sekilde sonlandi');

    transcriptOutput.value = finalText;
    analyzeBtn.disabled = transcriptOutput.value.trim().length === 0;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const chunkInfo = totalChunks > 1 ? ` - ${totalChunks} parcada islendi` : '';
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
