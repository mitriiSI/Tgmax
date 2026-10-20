import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { downloadUrlResilient } from './resilient-http.js';

const MIB = 1024 * 1024;
const DEFAULT_SOURCE_LIMIT_BYTES = 2000 * MIB;
const AUDIO_BITRATE_KBPS = 64;

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} завершился с кодом ${code}: ${stderr.trim()}`));
    });
  });
}

function extensionFromUrl(url, fallback) {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.[a-z0-9]{1,6}$/.test(extension)) return extension;
  } catch {
    // Use the media-type fallback below.
  }
  return fallback;
}

function contentTypeForExtension(extension, fallback) {
  const types = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm'
  };
  return types[extension] ?? fallback;
}

export async function probeVideo(filePath) {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
    '-of', 'json',
    filePath
  ]);
  const payload = JSON.parse(stdout || '{}');
  const video = (payload.streams ?? []).find((stream) => stream.codec_type === 'video');
  const duration = Number(payload.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('ffprobe не смог определить параметры видео');
  }
  return {
    duration,
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    codec: video.codec_name ?? '',
    hasAudio: (payload.streams ?? []).some((stream) => stream.codec_type === 'audio')
  };
}

function minBitrateForHeight(height) {
  if (height >= 1080) return 1200;
  if (height >= 720) return 750;
  if (height >= 480) return 500;
  return 320;
}

function maxBitrateForHeight(height) {
  if (height >= 1080) return 6000;
  if (height >= 720) return 3500;
  if (height >= 480) return 1800;
  return 1200;
}

function resolutionLadder(sourceHeight) {
  if (sourceHeight < 360) return [Math.max(2, sourceHeight - (sourceHeight % 2))];
  return [...new Set([Math.min(sourceHeight, 1080), 720, 480, 360])]
    .filter((height) => height <= sourceHeight && height >= 360)
    .sort((left, right) => right - left);
}

/**
 * Chooses the highest resolution that can fit into one Telegram-safe part.
 * Splitting starts only when a complete 360p encode would have too little bitrate.
 */
export function chooseVideoRelayPlan({ duration, sourceHeight, targetBytes }) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('duration must be positive');
  if (!Number.isFinite(targetBytes) || targetBytes <= 0) throw new Error('targetBytes must be positive');
  const ladder = resolutionLadder(sourceHeight || 360);
  const totalBudgetKbps = (targetBytes * 8 / duration / 1000) * 0.80;
  const availableVideoKbps = Math.max(1, totalBudgetKbps - AUDIO_BITRATE_KBPS);
  const selectedHeight = ladder.find((height) => minBitrateForHeight(height) <= availableVideoKbps);
  if (selectedHeight) {
    return {
      parts: 1,
      height: selectedHeight,
      videoBitrateKbps: Math.max(
        minBitrateForHeight(selectedHeight),
        Math.min(maxBitrateForHeight(selectedHeight), Math.floor(availableVideoKbps))
      )
    };
  }

  const minimumHeight = ladder.at(-1);
  const minimumTotalKbps = minBitrateForHeight(minimumHeight) + AUDIO_BITRATE_KBPS;
  const parts = Math.max(2, Math.ceil(minimumTotalKbps / Math.max(1, totalBudgetKbps)));
  const partDuration = duration / parts;
  const partBudgetKbps = (targetBytes * 8 / partDuration / 1000) * 0.80 - AUDIO_BITRATE_KBPS;
  return {
    parts,
    height: minimumHeight,
    videoBitrateKbps: Math.max(
      minBitrateForHeight(minimumHeight),
      Math.min(maxBitrateForHeight(minimumHeight), Math.floor(partBudgetKbps))
    )
  };
}

async function encodeVideoPart({
  inputPath,
  outputPath,
  startSeconds,
  durationSeconds,
  height,
  videoBitrateKbps,
  hasAudio
}) {
  const evenHeight = Math.max(2, Math.floor(height / 2) * 2);
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', startSeconds.toFixed(3),
    '-i', inputPath,
    '-t', durationSeconds.toFixed(3),
    '-map', '0:v:0',
    ...(hasAudio ? ['-map', '0:a:0?'] : []),
    '-vf', `scale=-2:${evenHeight}:flags=lanczos,setsar=1`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', `${Math.max(120, Math.floor(videoBitrateKbps))}k`,
    '-maxrate', `${Math.max(140, Math.floor(videoBitrateKbps * 1.08))}k`,
    '-bufsize', `${Math.max(280, Math.floor(videoBitrateKbps * 2))}k`,
    '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', `${AUDIO_BITRATE_KBPS}k`] : ['-an']),
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    '-y', outputPath
  ];
  await runProcess('ffmpeg', args);
}

async function transcodeVideoForTelegram({ inputPath, directory, targetBytes, baseName = 'video' }) {
  const probe = await probeVideo(inputPath);
  const plan = chooseVideoRelayPlan({
    duration: probe.duration,
    sourceHeight: probe.height,
    targetBytes
  });
  const outputs = [];
  let sequence = 0;

  async function encodeRange(startSeconds, durationSeconds, depth = 0) {
    sequence += 1;
    const partBudget = chooseVideoRelayPlan({
      duration: durationSeconds,
      sourceHeight: plan.height,
      targetBytes
    });
    const outputPath = path.join(directory, `${baseName}-part-${String(sequence).padStart(3, '0')}-${randomUUID()}.mp4`);
    await encodeVideoPart({
      inputPath,
      outputPath,
      startSeconds,
      durationSeconds,
      height: plan.height,
      videoBitrateKbps: Math.max(plan.videoBitrateKbps, partBudget.videoBitrateKbps),
      hasAudio: probe.hasAudio
    });
    const outputStat = await stat(outputPath);
    if (outputStat.size <= targetBytes) {
      outputs.push(outputPath);
      return;
    }
    await rm(outputPath, { force: true });
    if (durationSeconds <= 4 || depth >= 6) {
      throw new Error('не удалось уменьшить часть видео до лимита Telegram');
    }
    const firstDuration = durationSeconds / 2;
    await encodeRange(startSeconds, firstDuration, depth + 1);
    await encodeRange(startSeconds + firstDuration, durationSeconds - firstDuration, depth + 1);
  }

  const nominalDuration = probe.duration / plan.parts;
  for (let index = 0; index < plan.parts; index += 1) {
    const startSeconds = nominalDuration * index;
    const durationSeconds = index === plan.parts - 1
      ? probe.duration - startSeconds
      : nominalDuration;
    await encodeRange(startSeconds, durationSeconds);
  }
  return outputs;
}

async function compressPhoto({ inputPath, directory, targetBytes, baseName }) {
  const attempts = [
    { width: 2560, quality: 3 },
    { width: 1920, quality: 5 },
    { width: 1280, quality: 7 }
  ];
  for (const [index, attempt] of attempts.entries()) {
    const outputPath = path.join(directory, `${baseName}-compressed-${index + 1}.jpg`);
    await runProcess('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', `scale='min(${attempt.width},iw)':-2:flags=lanczos`,
      '-q:v', String(attempt.quality),
      '-y', outputPath
    ]);
    if ((await stat(outputPath)).size <= targetBytes) return outputPath;
    await rm(outputPath, { force: true });
  }
  throw new Error('не удалось уменьшить фотографию до лимита Telegram');
}

export async function prepareWebPostMedia({
  post,
  dataDir,
  targetBytes,
  timeoutMs = 30 * 60 * 1000,
  sourceLimitBytes = DEFAULT_SOURCE_LIMIT_BYTES,
  log = console
}) {
  await mkdir(dataDir, { recursive: true });
  const directory = await mkdtemp(path.join(dataDir, 'web-relay-'));
  const items = [];
  const failures = [];

  try {
    const media = (post.media ?? []).filter((item) => item.kind === 'photo' || item.kind === 'video');
    for (const [index, item] of media.entries()) {
      try {
        const fallbackExtension = item.kind === 'photo' ? '.jpg' : '.mp4';
        const extension = extensionFromUrl(item.url, fallbackExtension);
        const rawPath = path.join(directory, `source-${String(index + 1).padStart(2, '0')}${extension}`);
        const downloaded = await downloadUrlResilient(item.url, rawPath, {
          timeoutMs,
          maxBytes: sourceLimitBytes,
          attempts: 3,
          forceResilientDns: true
        });
        const rawStat = await stat(rawPath);

        if (item.kind === 'photo') {
          const filePath = rawStat.size <= targetBytes
            ? rawPath
            : await compressPhoto({
                inputPath: rawPath,
                directory,
                targetBytes,
                baseName: `photo-${index + 1}`
              });
          const outputExtension = path.extname(filePath).toLowerCase() || '.jpg';
          items.push({
            kind: 'photo',
            filePath,
            fileName: `photo-${index + 1}${outputExtension}`,
            contentType: contentTypeForExtension(outputExtension, downloaded.contentType || 'image/jpeg')
          });
          continue;
        }

        const isCompatibleMp4 = extension === '.mp4' || downloaded.contentType === 'video/mp4';
        if (rawStat.size <= targetBytes && isCompatibleMp4) {
          items.push({
            kind: 'video',
            filePath: rawPath,
            fileName: `video-${index + 1}.mp4`,
            contentType: 'video/mp4'
          });
          continue;
        }

        const parts = await transcodeVideoForTelegram({
          inputPath: rawPath,
          directory,
          targetBytes,
          baseName: `video-${index + 1}`
        });
        for (const [partIndex, filePath] of parts.entries()) {
          items.push({
            kind: 'video',
            filePath,
            fileName: parts.length === 1
              ? `video-${index + 1}.mp4`
              : `video-${index + 1}-part-${partIndex + 1}-of-${parts.length}.mp4`,
            contentType: 'video/mp4'
          });
        }
      } catch (error) {
        failures.push({ item, error });
        log.warn?.(`Web relay media ${index + 1} could not be prepared`, error.message);
      }
    }
    return {
      directory,
      items,
      failures,
      async cleanup() {
        await rm(directory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
