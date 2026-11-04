const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { EdgeTTS } = require('node-edge-tts');

const windowsSpeech = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$speech = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $speech.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet,
    [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [Globalization.CultureInfo]::GetCultureInfo('ru-RU'))
  $speech.SetOutputToWaveFile($env:TCHAT_TTS_OUTPUT)
  $speech.Speak($text)
} finally {
  $speech.Dispose()
}
`;

function synthesizeWindows(text, output) {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsSpeech], {
      windowsHide: true,
      timeout: 20000,
      env: { ...process.env, TCHAT_TTS_OUTPUT: output },
    }, (error) => error ? reject(error) : resolve());
    child.stdin.on('error', reject);
    child.stdin.end(Buffer.from(text, 'utf8').toString('base64'));
  });
}

async function isAudioFile(file) {
  return (await fs.stat(file).catch(() => null))?.size > 1024;
}

async function cacheAudio(file, synthesize) {
  if (await isAudioFile(file)) return file;
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  try {
    await synthesize(temporaryFile);
    if (!(await isAudioFile(temporaryFile))) throw new Error('Синтез вернул пустой аудиофайл');
    await fs.rename(temporaryFile, file);
    return file;
  } finally {
    await fs.rm(temporaryFile, { force: true });
  }
}

function createDonationTtsHandler(cacheDirectory) {
  const pending = new Map();
  return async (request, response) => {
    const text = String(request.query.text || '').replace(/\s+/g, ' ').trim().slice(0, 700);
    if (!text) return response.status(400).json({ ok: false, error: 'text is required' });

    const options = {
      voice: /^[\w-]+$/.test(request.query.voice || '') ? String(request.query.voice) : 'ru-RU-SvetlanaNeural',
      lang: 'ru-RU',
      rate: /^[+-]?\d+%$/.test(request.query.rate || '') ? String(request.query.rate) : '+0%',
      volume: /^[+-]?\d+%$/.test(request.query.volume || '') ? String(request.query.volume) : '+0%',
      pitch: /^[+-]?\d+Hz$/.test(request.query.pitch || '') ? String(request.query.pitch) : '+0Hz',
      timeout: 10000,
    };
    const hash = createHash('sha1').update(JSON.stringify({ text, ...options })).digest('hex');
    if (!pending.has(hash)) {
      const synthesize = async () => {
        await fs.mkdir(cacheDirectory, { recursive: true });
        const mp3 = path.join(cacheDirectory, `${hash}.mp3`);
        const wav = path.join(cacheDirectory, `${hash}.wav`);
        if (await isAudioFile(mp3)) return mp3;
        if (process.platform === 'win32' && await isAudioFile(wav)) return wav;
        try {
          return await cacheAudio(mp3, (file) => new EdgeTTS(options).ttsPromise(text, file));
        } catch (error) {
          if (process.platform !== 'win32') throw error;
          return cacheAudio(wav, (file) => synthesizeWindows(text, file));
        }
      };
      pending.set(hash, synthesize().finally(() => pending.delete(hash)));
    }
    try {
      const file = await pending.get(hash);
      response.set('Cache-Control', 'no-store');
      response.type(file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav').sendFile(file);
    } catch (error) {
      console.error(`Ошибка озвучки доната: ${error.message || error}`);
      response.status(503).json({ ok: false, error: 'Озвучка недоступна' });
    }
  };
}

module.exports = { createDonationTtsHandler };
