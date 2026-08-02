/**
 * @purpose Audio transcription using LLM API with Ed25519 authentication
 * @llm-note
 *   Dependencies: imports from [./address-browser] | imported by [src/index.ts, src/react/useVoiceInput.ts]
 *   Data flow: receives audioBlob: Blob → converts to wav → base64 → calls OpenOnion API → returns transcribed text
 *   State/Effects: makes API request | uses browser keys from localStorage
 *   Integration: exposes transcribe(audioBlob, options?) | uses Ed25519 auth (same as agent connection)
 */

import { loadBrowser, signBrowser, type AddressData } from './address-browser';

export interface TranscribeOptions {
  /** Context hints for better accuracy (e.g., "Technical AI discussion. Names: Aaron, Lisa") */
  prompt?: string
  /** Model to use (default: co/gemini-2.5-flash - Gemini supports audio transcription) */
  model?: string
  /** Include [MM:SS] timestamps in output */
  timestamps?: boolean
  /** API key for authentication (if not using Ed25519 signed auth) */
  apiKey?: string
  /** Explicit address data for Ed25519 auth (optional - will load from localStorage if not provided) */
  addressData?: AddressData
  /** Base URL for API (default: https://oo.openonion.ai). Use proxy URL to avoid CORS issues in browser. */
  baseUrl?: string
}

/**
 * Convert audio blob to wav format using Web Audio API.
 * Required because OpenAI/Gemini only accept wav/mp3, not webm.
 */
async function convertToWav(audioBlob: Blob): Promise<Blob> {
  const audioContext = new AudioContext();
  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  // Convert to mono, 16kHz for smaller file size (sufficient for speech)
  const sampleRate = 16000;
  const numChannels = 1;
  const offlineContext = new OfflineAudioContext(numChannels, audioBuffer.duration * sampleRate, sampleRate);

  const source = offlineContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineContext.destination);
  source.start(0);

  const renderedBuffer = await offlineContext.startRendering();
  const wavBlob = audioBufferToWav(renderedBuffer);

  await audioContext.close();
  return wavBlob;
}

/**
 * Convert AudioBuffer to WAV blob.
 */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  const samples = buffer.getChannelData(0);
  const dataLength = samples.length * bytesPerSample;
  const bufferLength = 44 + dataLength;

  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Write audio data
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    offset += 2;
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Create canonical JSON for signing.
 */
function canonicalJSON(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedObj[key] = obj[key];
  }
  return JSON.stringify(sortedObj);
}

/**
 * Transcribe audio to text.
 * Automatically converts webm/ogg to wav for API compatibility.
 *
 * @example
 * ```typescript
 * // Simple transcription (uses keys from localStorage)
 * const text = await transcribe(audioBlob)
 *
 * // With context hints
 * const text = await transcribe(audioBlob, {
 *   prompt: "Technical meeting. Names: Aaron, Lisa"
 * })
 *
 * // With timestamps
 * const text = await transcribe(audioBlob, { timestamps: true })
 * ```
 */
export async function transcribe(
  audioBlob: Blob,
  options: TranscribeOptions = {}
): Promise<string> {
  const {
    prompt,
    model = 'co/gemini-2.5-flash',
    timestamps = false,
    apiKey,
    addressData: providedAddressData,
    baseUrl: providedBaseUrl
  } = options

  // Get auth from apiKey or Ed25519 keys
  const addressData = providedAddressData || loadBrowser();
  if (!apiKey && !addressData) {
    throw new Error('No authentication found. Please set OPENONION_API_KEY in settings or connect to an agent first.')
  }

  // Convert to wav if needed (webm/ogg not supported by OpenAI/Gemini)
  const originalFormat = audioBlob.type.split('/')[1]?.split(';')[0] || 'webm'
  let finalBlob = audioBlob
  let format = originalFormat

  if (originalFormat === 'webm' || originalFormat === 'ogg') {
    finalBlob = await convertToWav(audioBlob)
    format = 'wav'
  }

  // Convert blob to base64
  const arrayBuffer = await finalBlob.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)
  let base64 = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.slice(i, i + chunkSize)
    base64 += String.fromCharCode(...chunk)
  }
  base64 = btoa(base64)

  // Build transcription prompt
  let systemPrompt = timestamps
    ? 'Transcribe this audio with timestamps in [MM:SS] format.'
    : 'Transcribe this audio accurately.'
  if (prompt) systemPrompt += ` Context: ${prompt}`

  // Default to production OpenOnion API
  const baseUrl = providedBaseUrl || 'https://oo.openonion.ai'

  // Strip co/ prefix for actual API call
  const actualModel = model.startsWith('co/') ? model.slice(3) : model

  // Build auth headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (addressData) {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = {
      action: 'transcribe',
      model: actualModel,
      timestamp,
    };
    const canonicalMessage = canonicalJSON(payload);
    const signature = signBrowser(addressData, canonicalMessage);
    headers['X-Signature'] = signature;
    headers['X-From'] = addressData.address;
    headers['X-Timestamp'] = timestamp.toString();
  }

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: actualModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: systemPrompt },
          { type: 'input_audio', input_audio: { data: base64, format } },
        ],
      }],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Transcription failed: ${response.status} - ${errorText}`)
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content || ''
}
