import 'dotenv/config';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import multer from 'multer';

console.log('[boot] starting transcribe backend...');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ffmpegBinary = process.env.FFMPEG_PATH || 'ffmpeg';

const app = express();

const port = Number(process.env.PORT || 8787);
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 500);
const maxUploadBytes = maxUploadMb * 1024 * 1024;
const corsOrigin = process.env.CORS_ORIGIN || '*';
const chunkSeconds = Number(process.env.CHUNK_SECONDS || 1380);
const openAiChunkSafeBytes = 24 * 1024 * 1024;
const transcribeModel = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe-diarize';
const analyzeModel = process.env.ANALYZE_MODEL || 'gpt-4o';

if (!process.env.OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY is missing. Transcribe requests will fail.');
}

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const safeName = (file.originalname || 'audio').replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `upload-${Date.now()}-${safeName}`);
    },
  }),
  limits: {
    fileSize: maxUploadBytes,
  },
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, maxUploadMb, chunkSeconds, transcribeModel, analyzeModel });
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const createdChunkPaths = [];
  const uploadedPath = req.file?.path || null;

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const writeEvent = (obj) => {
    try {
      res.write(`${JSON.stringify(obj)}\n`);
    } catch {}
  };

  const heartbeat = setInterval(() => {
    writeEvent({ type: 'heartbeat', ts: Date.now() });
  }, 15000);

  try {
    if (!process.env.OPENAI_API_KEY) {
      writeEvent({ type: 'error', error: 'OPENAI_API_KEY tanimli degil' });
      return;
    }
    if (!req.file) {
      writeEvent({ type: 'error', error: 'audio dosyasi gerekli' });
      return;
    }

    const stats = await fsp.stat(uploadedPath);
    writeEvent({
      type: 'status',
      stage: 'uploaded',
      sizeBytes: stats.size,
      message: `Dosya alindi (${(stats.size / 1024 / 1024).toFixed(1)} MB)`,
    });

    const needsChunking = stats.size > openAiChunkSafeBytes;

    let chunkPaths;
    if (needsChunking) {
      writeEvent({ type: 'status', stage: 'chunking', message: 'Ses parcalaniyor...' });
      const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tr-chunks-'));
      chunkPaths = await splitAudioToChunks({
        inputPath: uploadedPath,
        workDir,
        chunkSeconds,
      });
      createdChunkPaths.push(...chunkPaths, workDir);
      writeEvent({
        type: 'status',
        stage: 'chunked',
        total: chunkPaths.length,
        message: `${chunkPaths.length} parcaya bolundu`,
      });
    } else {
      chunkPaths = [uploadedPath];
    }

    const results = [];
    for (let i = 0; i < chunkPaths.length; i += 1) {
      const chunkPath = chunkPaths[i];
      writeEvent({
        type: 'status',
        stage: 'transcribing',
        index: i + 1,
        total: chunkPaths.length,
        message: `Parca ${i + 1}/${chunkPaths.length} transcribe ediliyor...`,
      });
      const transcriptPart = await transcribeSingleChunk({
        chunkPath,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      });
      results.push(transcriptPart);
      writeEvent({
        type: 'chunk',
        index: i + 1,
        total: chunkPaths.length,
        text: transcriptPart,
      });
    }

    const joined = results.map((r) => r.trim()).filter(Boolean).join('\n\n');
    writeEvent({
      type: 'done',
      text: joined,
      chunks: chunkPaths.length,
      originalSizeBytes: stats.size,
    });
  } catch (error) {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      writeEvent({
        type: 'error',
        error: `Dosya boyutu limiti asildi. Mevcut limit: ${maxUploadMb} MB`,
      });
    } else {
      console.error('Transcribe error:', error);
      writeEvent({ type: 'error', error: error?.message || 'Bilinmeyen hata' });
    }
  } finally {
    clearInterval(heartbeat);
    try { res.end(); } catch {}
    if (uploadedPath) {
      fs.promises.unlink(uploadedPath).catch(() => {});
    }
    for (const p of createdChunkPaths) {
      fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }
});

app.post('/analyze', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY tanimli degil' });
    }

    const transcript = String(req.body?.transcript || '').trim();
    if (!transcript) {
      return res.status(400).json({ error: 'transcript gerekli' });
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

    const openAiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: analyzeModel,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'Sen toplanti notlarini net ve kisa ozetleyen bir asistansin. Turkce yaz. Metinde "Konusmaci A", "Konusmaci B" gibi etiketler varsa bunlari ozette de koru, kim ne dedi ayrimini yap.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const text = await openAiResp.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!openAiResp.ok) {
      return res
        .status(openAiResp.status)
        .json({ error: parsed?.error?.message || parsed?.error || text || 'OpenAI hatasi' });
    }

    const analysis = parsed?.choices?.[0]?.message?.content || '';
    return res.json({ analysis });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Bilinmeyen hata' });
  }
});

function splitAudioToChunks({ inputPath, workDir, chunkSeconds }) {
  return new Promise((resolve, reject) => {
    const outputPattern = path.join(workDir, 'chunk-%03d.wav');
    const args = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'segment',
      '-segment_time', String(chunkSeconds),
      '-reset_timestamps', '1',
      outputPattern,
    ];

    let stderr = '';
    const proc = spawn(ffmpegBinary, args);

    proc.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg calistirilamadi (${ffmpegBinary}): ${err.message}`));
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-8).join(' | ');
        reject(new Error(`ffmpeg exit code ${code}: ${tail}`));
        return;
      }
      try {
        const files = await fsp.readdir(workDir);
        const chunkFiles = files
          .filter((f) => f.startsWith('chunk-') && f.endsWith('.wav'))
          .sort()
          .map((f) => path.join(workDir, f));
        if (chunkFiles.length === 0) {
          reject(new Error('Parcalama basarisiz: hic chunk uretilmedi'));
          return;
        }
        resolve(chunkFiles);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function transcribeSingleChunk({ chunkPath, originalName, mimeType }) {
  const buffer = await fsp.readFile(chunkPath);
  const ext = path.extname(chunkPath) || '.wav';
  const fileName = originalName ? `${path.basename(originalName, path.extname(originalName))}${ext}` : `audio${ext}`;
  const blobType = ext === '.wav' ? 'audio/wav' : ext === '.mp3' ? 'audio/mpeg' : mimeType || 'application/octet-stream';

  const audioBlob = new Blob([buffer], { type: blobType });
  const audioFile = new File([audioBlob], fileName, { type: blobType });

  const isDiarize = /diarize/i.test(transcribeModel);

  const openAiForm = new FormData();
  openAiForm.append('file', audioFile);
  openAiForm.append('model', transcribeModel);
  openAiForm.append('response_format', isDiarize ? 'diarized_json' : 'json');
  if (isDiarize) {
    openAiForm.append('chunking_strategy', 'auto');
  }

  const openAiResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: openAiForm,
  });

  const text = await openAiResp.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (!openAiResp.ok) {
    const errorMsg = parsed?.error?.message || parsed?.error || text || 'OpenAI hatasi';
    throw new Error(errorMsg);
  }

  if (isDiarize && Array.isArray(parsed?.segments)) {
    const lines = [];
    let lastSpeaker = null;
    for (const seg of parsed.segments) {
      const speaker = seg?.speaker ?? seg?.speaker_id ?? '?';
      const segText = String(seg?.text || '').trim();
      if (!segText) continue;
      if (speaker !== lastSpeaker) {
        lines.push(`Konusmaci ${speaker}: ${segText}`);
        lastSpeaker = speaker;
      } else {
        lines.push(segText);
      }
    }
    if (lines.length > 0) return lines.join('\n');
  }

  return parsed?.text || '';
}

app.listen(port, () => {
  console.log(`Transcribe backend running on port ${port}`);
  console.log(`Max upload: ${maxUploadMb} MB`);
  console.log(`Chunk seconds: ${chunkSeconds}`);
  console.log(`FFmpeg binary: ${ffmpegBinary}`);
});
