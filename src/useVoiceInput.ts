/**
 * @purpose React hook for voice recording and transcription
 * @llm-note
 *   Dependencies: imports from [react, ../transcribe] | imported by [src/react/index.ts]
 *   Data flow: user triggers recording → MediaRecorder captures audio → stops → transcribe() API call → returns text
 *   State/Effects: manages recording state, MediaRecorder refs, transcription status
 *   Integration: exposes useVoiceInput(options?) hook with startRecording, stopRecording, status, text, duration
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { transcribe } from 'connectonion/transcribe'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing' | 'error'

export interface UseVoiceInputOptions {
  /** Context hints for better accuracy */
  prompt?: string
  /** Model to use (default: co/gemini-2.5-flash) */
  model?: string
  /** Include timestamps in output */
  timestamps?: boolean
  /** API key for authentication */
  apiKey?: string
  /** Base URL for API (use proxy URL to avoid CORS in browser) */
  baseUrl?: string
  /** Called when transcription completes successfully */
  onTranscribed?: (text: string) => void
  /** Called when an error occurs */
  onError?: (error: Error) => void
}

export interface UseVoiceInputReturn {
  /** Current status */
  status: VoiceInputStatus
  /** Convenience: true when recording */
  isRecording: boolean
  /** Convenience: true when transcribing */
  isTranscribing: boolean
  /** Recording duration in seconds */
  duration: number
  /** Last error, if any */
  error: Error | null
  /** Start recording - call on mousedown/touchstart */
  startRecording: () => Promise<void>
  /** Stop recording and transcribe - call on mouseup/touchend */
  stopRecording: () => void
  /** Cancel recording without transcribing */
  cancelRecording: () => void
  /** Last transcribed text */
  text: string
}

/**
 * React hook for voice input with transcription.
 *
 * @example
 * ```tsx
 * function VoiceInput() {
 *   const { isRecording, isTranscribing, duration, startRecording, stopRecording } = useVoiceInput({
 *     onTranscribed: (text) => console.log('Got:', text),
 *   })
 *
 *   return (
 *     <div>
 *       {isRecording && <span>Recording: {duration}s</span>}
 *       {isTranscribing && <span>Transcribing...</span>}
 *       <button
 *         onMouseDown={startRecording}
 *         onMouseUp={stopRecording}
 *       >
 *         🎤
 *       </button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [duration, setDuration] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const startTimeRef = useRef<number>(0)
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelledRef = useRef(false)

  // Memoize options to avoid re-creating callbacks
  const optionsRef = useRef(options)
  optionsRef.current = options

  // Update duration while recording
  useEffect(() => {
    if (status === 'recording') {
      startTimeRef.current = Date.now()
      setDuration(0)
      durationIntervalRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000))
      }, 100)
    } else {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current)
        durationIntervalRef.current = null
      }
    }
    return () => {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current)
      }
    }
  }, [status])

  const startRecording = useCallback(async () => {
    // Prevent starting if already recording or transcribing
    if (status === 'recording' || status === 'transcribing') return

    cancelledRef.current = false

    try {
      setError(null)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Determine best supported mime type
      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : MediaRecorder.isTypeSupported('audio/ogg')
            ? 'audio/ogg'
            : ''

      const recorderOptions = mimeType ? { mimeType } : undefined
      const mediaRecorder = new MediaRecorder(stream, recorderOptions)
      mediaRecorderRef.current = mediaRecorder
      chunksRef.current = []

      mediaRecorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data)
        }
      }

      mediaRecorder.onstop = async () => {
        // Stop all tracks to release microphone
        streamRef.current?.getTracks().forEach((track: MediaStreamTrack) => track.stop())

        // If cancelled, just reset
        if (cancelledRef.current) {
          setStatus('idle')
          setDuration(0)
          return
        }

        // Create blob from chunks
        const actualMimeType = mediaRecorder.mimeType || 'audio/webm'
        const audioBlob = new Blob(chunksRef.current, { type: actualMimeType })

        // Skip if no audio data
        if (audioBlob.size === 0) {
          setStatus('idle')
          return
        }

        setStatus('transcribing')

        try {
          const { onTranscribed, onError, ...transcribeOpts } = optionsRef.current
          const transcribedText = await transcribe(audioBlob, transcribeOpts)
          setText(transcribedText)
          onTranscribed?.(transcribedText)
          setStatus('idle')
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err))
          setError(e)
          optionsRef.current.onError?.(e)
          setStatus('error')
          // Reset to idle after brief error state
          setTimeout(() => setStatus('idle'), 2000)
        }
      }

      mediaRecorder.start()
      setStatus('recording')
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      setError(e)
      optionsRef.current.onError?.(e)
      setStatus('error')
      // Reset to idle after brief error state
      setTimeout(() => setStatus('idle'), 2000)
    }
  }, [status])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
  }, [])

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    streamRef.current?.getTracks().forEach((track: MediaStreamTrack) => track.stop())
    setStatus('idle')
    setDuration(0)
  }, [])

  return {
    status,
    isRecording: status === 'recording',
    isTranscribing: status === 'transcribing',
    duration,
    error,
    startRecording,
    stopRecording,
    cancelRecording,
    text,
  }
}
