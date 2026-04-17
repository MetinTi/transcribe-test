import 'dotenv/config';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const app = express();

const port = Number(process.env.PORT || 8787);
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 500);
const maxUploadBytes = maxUploadMb * 1024 * 1024;
const corsOrigin = process.env.CORS_ORIGIN || '*';
const chunkSeconds = Number(process.env.CHUNK_SECONDS || 600);
const openAiChunkSafeBytes = 24 * 1024 * 1024;
const transcribeModel = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';

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
  res.json({ ok: true, maxUploadMb, chunkSeconds, transcribeModel });
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const createdChunkPaths = [];
  const uploadedPath = req.file?.path || null;

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY tanimli degil' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'audio dosyasi gerekli' });
    }

    const stats = await fsp.stat(uploadedPath);
    const needsChunking = stats.size > openAiChunkSafeBytes;

    let chunkPaths;
    if (needsChunking) {
      const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tr-chunks-'));
      chunkPaths = await splitAudioToChunks({
        inputPath: uploadedPath,
        workDir,
        chunkSeconds,
      });
      createdChunkPaths.push(...chunkPaths, workDir);
    } else {
      chunkPaths = [uploadedPath];
    }

    const results = [];
    for (let i = 0; i < chunkPaths.length; i += 1) {
      const chunkPath = chunkPaths[i];
      const transcriptPart = await transcribeSingleChunk({
        chunkPath,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      });
      results.push(transcriptPart);
    }

    const joined = results.map((r) => r.trim()).filter(Boolean).join('\n\n');
    return res.json({
      text: joined,
      chunks: chunkPaths.length,
      originalSizeBytes: stats.size,
    });
  } catch (error) {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `Dosya boyutu limiti asildi. Mevcut limit: ${maxUploadMb} MB`,
      });
    }
    console.error('Transcribe error:', error);
    return res.status(500).json({ error: error?.message || 'Bilinmeyen hata' });
  } finally {
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
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'Sen toplanti notlarini net ve kisa ozetleyen bir asistansin. Turkce yaz.',
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
    let stderr = '';
    ffmpeg(inputPath)
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)
      .audioChannels(1)
      .outputOptions([
        '-vn',
        '-f segment',
        `-segment_time ${chunkSeconds}`,
        '-reset_timestamps 1',
      ])
      .output(outputPattern)
      .on('stderr', (line) => {
        stderr += `${line}\n`;
      })
      .on('end', async () => {
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
      })
      .on('error', (err) => {
        const msg = `ffmpeg hatasi: ${err.message}\n${stderr.trim().split('\n').slice(-5).join(' | ')}`;
        reject(new Error(msg));
      })
      .run();
  });
}

async function transcribeSingleChunk({ chunkPath, originalName, mimeType }) {
  const buffer = await fsp.readFile(chunkPath);
  const ext = path.extname(chunkPath) || '.wav';
  const fileName = originalName ? `${path.basename(originalName, path.extname(originalName))}${ext}` : `audio${ext}`;
  const blobType = ext === '.wav' ? 'audio/wav' : ext === '.mp3' ? 'audio/mpeg' : mimeType || 'application/octet-stream';

  const audioBlob = new Blob([buffer], { type: blobType });
  const audioFile = new File([audioBlob], fileName, { type: blobType });

  const openAiForm = new FormData();
  openAiForm.append('file', audioFile);
  openAiForm.append('model', transcribeModel);
  openAiForm.append('response_format', 'json');

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

  return parsed?.text || '';
}

app.listen(port, () => {
  console.log(`Transcribe backend running on port ${port}`);
  console.log(`Max upload: ${maxUploadMb} MB`);
  console.log(`Chunk seconds: ${chunkSeconds}`);
  console.log(`FFmpeg path: ${ffmpegPath || '(system)'}`);
});
