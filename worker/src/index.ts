/**
 * EchoText Worker
 * Handles incoming calls from Twilio, transcribes audio via Deepgram STT,
 * and converts text responses to speech via Google Cloud TTS
 */

export interface Env {
  CALL_SESSION: DurableObjectNamespace;
  DEEPGRAM_API_KEY: string;
  GOOGLE_TTS_API_KEY: string;
}

// G.711 µ-law encoder (16-bit signed PCM → 8-bit mulaw)
function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = 0;
  if (sample < 0) {
    sample = -sample;
    sign = 0x80;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  let expMask = 0x4000;
  while ((sample & expMask) === 0 && exponent > 0) {
    exponent--;
    expMask >>= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// Generates a short, soft "tap" as base64 mulaw (8kHz, ~30ms) so the caller
// gets a gentle audible cue that the user is typing. Warmer tone (650Hz),
// reduced amplitude and almost no noise to keep it unobtrusive on phone audio.
function generateClickAudioBase64(): string {
  const sampleRate = 8000;
  const numSamples = 240; // 30ms
  const bytes = new Uint8Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // 3ms attack ramp avoids a hard "pop", then exponential decay
    const attack = Math.min(1, t / 0.003);
    const envelope = attack * Math.exp(-t * 110);
    const tone = Math.sin(2 * Math.PI * 650 * t) * 0.85 + (Math.random() - 0.5) * 0.15;
    const sample = Math.round(envelope * tone * 8500); // ~26% of full scale
    bytes[i] = linearToMulaw(sample);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const CLICK_AUDIO_BASE64 = generateClickAudioBase64();

/**
 * Main Worker - routes requests to appropriate handlers
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    console.log(`[MAIN] Incoming request: ${request.method} ${url.pathname}`);

    // Serve frontend HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
      console.log('[MAIN] Serving frontend HTML');
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Twilio incoming call webhook
    if (url.pathname === '/incoming-call' && request.method === 'POST') {
      console.log('[MAIN] Handling incoming call from Twilio');
      const formData = await request.formData();
      console.log('[MAIN] Twilio webhook data:', Object.fromEntries(formData));
      return handleIncomingCall(request, env);
    }

    // WebSocket for Twilio media stream
    if (url.pathname.startsWith('/media-stream/')) {
      const sessionId = url.pathname.split('/')[2];
      console.log(`[MAIN] Media stream WebSocket request for session: ${sessionId}`);
      return handleMediaStream(request, env, sessionId);
    }

    // WebSocket for browser client
    if (url.pathname.startsWith('/client/')) {
      const sessionId = url.pathname.split('/')[2];
      console.log(`[MAIN] Client WebSocket request for session: ${sessionId}`);
      return handleClientConnection(request, env, sessionId);
    }

    console.log(`[MAIN] 404 Not Found: ${url.pathname}`);
    return new Response('Not Found', { status: 404 });
  },
};

/**
 * Handles incoming call from Twilio
 * Returns TwiML to start media stream
 */
async function handleIncomingCall(request: Request, env: Env): Promise<Response> {
  // Use "default" session ID so browser client can connect to the same session
  // In production, you'd want a way to route multiple calls to different sessions
  const sessionId = 'default';
  const url = new URL(request.url);
  const wsUrl = `wss://${url.host}/media-stream/${sessionId}`;

  console.log(`[INCOMING] Using session ID: ${sessionId}`);
  console.log(`[INCOMING] WebSocket URL: ${wsUrl}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="da-DK" voice="Google.da-DK-Wavenet-F">Velkommen til Smartlinjen. Vent venligst mens opkaldet besvares.</Say>
  <Connect>
    <Stream url="${wsUrl}" track="inbound_track" />
  </Connect>
</Response>`;

  console.log('[INCOMING] Sending TwiML response');
  return new Response(twiml, {
    headers: { 'Content-Type': 'text/xml' },
  });
}

/**
 * Handles WebSocket connection from Twilio media stream
 */
async function handleMediaStream(
  request: Request,
  env: Env,
  sessionId: string
): Promise<Response> {
  const id = env.CALL_SESSION.idFromName(sessionId);
  const stub = env.CALL_SESSION.get(id);
  return stub.fetch(request);
}

/**
 * Handles WebSocket connection from browser client
 */
async function handleClientConnection(
  request: Request,
  env: Env,
  sessionId: string
): Promise<Response> {
  const id = env.CALL_SESSION.idFromName(sessionId);
  const stub = env.CALL_SESSION.get(id);
  return stub.fetch(request);
}

/**
 * Durable Object - manages a single call session
 * Coordinates between Twilio audio stream, Deepgram transcription, and browser client
 */
export class CallSession {
  private state: DurableObjectState;
  private env: Env;
  private twilioWs: WebSocket | null = null;
  private clientWs: WebSocket | null = null;
  private deepgramWs: WebSocket | null = null;
  private sessionId: string = '';
  private callActive: boolean = false;
  private deepgramConnected: boolean = false;
  private twilioStreamStarted: boolean = false;
  private streamSid: string = '';
  private callAccepted: boolean = false;
  private callTimeout: ReturnType<typeof setTimeout> | null = null;
  private typingClickInterval: ReturnType<typeof setInterval> | null = null;
  private callStartedAt: number = 0;
  private audioPacketCount: number = 0;
  private audioBytesToDeepgram: number = 0;
  private finalTranscriptCount: number = 0;
  private ttsRequestCount: number = 0;
  private callerInfo: { from?: string; to?: string; callSid?: string } = {};

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.sessionId = url.pathname.split('/').pop() || 'unknown';
    console.log(`[DO] Durable Object fetch: ${url.pathname} (sessionId: ${this.sessionId})`);

    // Handle WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      console.log('[DO] WebSocket upgrade request');
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Determine if this is Twilio or browser client
      if (url.pathname.includes('/media-stream/')) {
        console.log('[DO] Handling Twilio media stream WebSocket');
        await this.handleTwilioWebSocket(server);
      } else if (url.pathname.includes('/client/')) {
        console.log('[DO] Handling browser client WebSocket');
        await this.handleClientWebSocket(server);
      }

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    console.log('[DO] Expected WebSocket but got regular request');
    return new Response('Expected WebSocket', { status: 400 });
  }

  /**
   * Handles WebSocket connection from Twilio media stream
   */
  async handleTwilioWebSocket(ws: WebSocket): Promise<void> {
    console.log(`[TWILIO-WS] Accepting WebSocket connection (session: ${this.sessionId})`);
    this.twilioWs = ws;
    ws.accept();

    // Connect to Deepgram when Twilio connects
    console.log('[TWILIO-WS] Connecting to Deepgram...');
    await this.connectToDeepgram();

    ws.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data as string);
        console.log(`[TWILIO-WS] Received message: ${message.event} (streamSid: ${message.streamSid || 'N/A'})`);

        // Handle different Twilio message types
        switch (message.event) {
          case 'start':
            console.log('[TWILIO-WS] Stream started:', JSON.stringify(message.start));
            this.streamSid = message.streamSid || message.start?.streamSid || '';
            this.callStartedAt = Date.now();
            this.audioPacketCount = 0;
            this.audioBytesToDeepgram = 0;
            this.finalTranscriptCount = 0;
            this.ttsRequestCount = 0;
            this.callerInfo = {
              from: message.start?.customParameters?.From || message.start?.callerName,
              to: message.start?.customParameters?.To,
              callSid: message.start?.callSid,
            };
            console.log(`[TWILIO-WS] StreamSid: ${this.streamSid}`);
            console.log(`[TWILIO-WS] CallSid: ${this.callerInfo.callSid || 'unknown'}`);
            console.log(`[TWILIO-WS] Caller: ${this.callerInfo.from || 'unknown'} → ${this.callerInfo.to || 'unknown'}`);
            console.log(`[TWILIO-WS] Media format: ${JSON.stringify(message.start?.mediaFormat)}`);
            this.twilioStreamStarted = true;
            this.callActive = true;
            this.callAccepted = false;
            // Notify browser of incoming call - user must accept
            this.notifyClient({
              type: 'call-incoming',
              data: message.start,
              debug: {
                deepgramConnected: this.deepgramConnected,
                sessionId: this.sessionId
              }
            });
            // Auto-timeout after 30 seconds if not accepted
            this.callTimeout = setTimeout(() => {
              if (!this.callAccepted && this.callActive) {
                console.log('[TWILIO-WS] Call timeout - not accepted within 30s');
                this.notifyClient({ type: 'call-timeout' });
                this.cleanup();
              }
            }, 30000);
            break;

          case 'media':
            // Only forward audio to Deepgram if call has been accepted
            if (!this.callAccepted) break;
            if (this.deepgramWs && this.deepgramConnected && message.media.payload) {
              try {
                // Twilio sends base64 encoded mulaw audio
                // Deepgram requires raw binary data, not JSON
                const audioBuffer = Uint8Array.from(atob(message.media.payload), c => c.charCodeAt(0));
                this.deepgramWs.send(audioBuffer);
                this.audioPacketCount++;
                this.audioBytesToDeepgram += audioBuffer.length;
                // Log every 250 packets (~5s of audio at Twilio's 50Hz cadence)
                if (this.audioPacketCount % 250 === 0) {
                  const elapsedSec = ((Date.now() - this.callStartedAt) / 1000).toFixed(1);
                  console.log(`[TWILIO-WS] Audio flowing: ${this.audioPacketCount} packets, ${(this.audioBytesToDeepgram / 1024).toFixed(1)} KB → Deepgram (${elapsedSec}s elapsed)`);
                }
              } catch (err) {
                console.error('[TWILIO-WS] Error decoding/sending audio:', err);
              }
            } else {
              if (!this.deepgramWs) {
                console.warn('[TWILIO-WS] No Deepgram WebSocket instance');
              } else if (!this.deepgramConnected) {
                console.warn('[TWILIO-WS] Deepgram not connected yet');
              } else if (!message.media.payload) {
                console.warn('[TWILIO-WS] No payload in media message');
              }
            }
            break;

          case 'stop':
            console.log('[TWILIO-WS] Stream stopped');
            this.twilioStreamStarted = false;
            this.callActive = false;
            this.notifyClient({ type: 'call-ended' });
            this.cleanup();
            break;
        }
      } catch (err) {
        console.error('[TWILIO-WS] Error processing message:', err);
        this.notifyClient({
          type: 'error',
          message: 'Error processing Twilio message',
          details: String(err)
        });
      }
    });

    ws.addEventListener('close', (event) => {
      console.log(`[TWILIO-WS] WebSocket closed (code: ${event.code}, reason: ${event.reason || 'none'})`);
      this.twilioWs = null;
      this.twilioStreamStarted = false;
      this.callActive = false;
      this.notifyClient({ type: 'twilio-disconnected', code: event.code, reason: event.reason });
      this.cleanup();
    });

    ws.addEventListener('error', (event) => {
      console.error('[TWILIO-WS] WebSocket error:', event);
      this.notifyClient({ type: 'error', message: 'Twilio WebSocket error' });
      this.cleanup();
    });
  }

  /**
   * Handles WebSocket connection from browser client
   */
  async handleClientWebSocket(ws: WebSocket): Promise<void> {
    console.log(`[CLIENT-WS] Accepting client connection (session: ${this.sessionId})`);
    this.clientWs = ws;
    ws.accept();

    // Send initial state to client
    this.notifyClient({
      type: 'connected',
      sessionId: this.sessionId,
      state: {
        callActive: this.callActive,
        twilioConnected: !!this.twilioWs,
        deepgramConnected: this.deepgramConnected
      }
    });

    ws.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data as string);
        console.log(`[CLIENT-WS] Received message type: ${message.type}`);

        // Handle call accept/reject
        if (message.type === 'call-accept') {
          console.log('[CLIENT-WS] Call accepted by user');
          this.callAccepted = true;
          if (this.callTimeout) {
            clearTimeout(this.callTimeout);
            this.callTimeout = null;
          }
          this.notifyClient({
            type: 'call-started',
            debug: {
              deepgramConnected: this.deepgramConnected,
              sessionId: this.sessionId
            }
          });
          // Tell the caller they're connected — explain the format so they know what to expect
          await this.synthesizeSpeech(
            'Hej, og velkommen. Samtalen her bliver transskriberet, så jeg kan læse alt det du siger. Når jeg svarer dig skriftligt, vil du høre en let kliklyd mens jeg skriver — så ved du at jeg er i gang. Du må gerne begynde at tale.'
          );
        } else if (message.type === 'call-reject') {
          console.log('[CLIENT-WS] Call rejected by user');
          this.notifyClient({ type: 'call-rejected' });
          this.cleanup();
        // Handle text response from user
        } else if (message.type === 'user-response' && message.text) {
          console.log(`[CLIENT-WS] User response: ${message.text}`);
          await this.synthesizeSpeech(message.text);
        } else if (message.type === 'typing-start') {
          this.startTypingClicks();
        } else if (message.type === 'typing-stop') {
          this.stopTypingClicks();
        } else if (message.type === 'ping') {
          // Respond to ping with state info
          this.notifyClient({
            type: 'pong',
            state: {
              callActive: this.callActive,
              twilioConnected: !!this.twilioWs,
              deepgramConnected: this.deepgramConnected
            }
          });
        }
      } catch (err) {
        console.error('[CLIENT-WS] Error processing client message:', err);
        this.notifyClient({
          type: 'error',
          message: 'Error processing message',
          details: String(err)
        });
      }
    });

    ws.addEventListener('close', (event) => {
      console.log(`[CLIENT-WS] WebSocket closed (code: ${event.code}, reason: ${event.reason || 'none'})`);
      this.clientWs = null;
    });

    ws.addEventListener('error', (event) => {
      console.error('[CLIENT-WS] WebSocket error:', event);
    });
  }

  /**
   * Connects to Deepgram for live transcription
   */
  async connectToDeepgram(): Promise<void> {
    // Deepgram streaming API parameters
    // See: https://developers.deepgram.com/reference/speech-to-text/listen-streaming
    const params = new URLSearchParams({
      language: 'da',           // Danish
      encoding: 'mulaw',        // Twilio uses mulaw encoding
      sample_rate: '8000',      // Twilio uses 8kHz
      model: 'nova-2',          // Latest streaming model
      interim_results: 'true',  // Get partial results as they come
      punctuate: 'true',        // Add punctuation
      vad_events: 'true',       // Voice activity detection events
    });

    // IMPORTANT: Use https:// not wss:// in Cloudflare Workers!
    // Cloudflare automatically handles WebSocket upgrade
    const deepgramUrl = `https://api.deepgram.com/v1/listen?${params.toString()}`;

    try {
      console.log(`[DEEPGRAM] Connecting to Deepgram (session: ${this.sessionId})...`);
      console.log('[DEEPGRAM] URL:', deepgramUrl);

      const response = await fetch(deepgramUrl, {
        headers: {
          'Authorization': `Token ${this.env.DEEPGRAM_API_KEY}`,
          'Upgrade': 'websocket',
        },
      });

      console.log('[DEEPGRAM] Response status:', response.status);
      console.log('[DEEPGRAM] Has webSocket:', !!response.webSocket);

      if (response.webSocket) {
        this.deepgramWs = response.webSocket;
        this.deepgramWs.accept();
        this.deepgramConnected = true;
        console.log('[DEEPGRAM] WebSocket accepted and ready');

        this.notifyClient({
          type: 'deepgram-connected',
          sessionId: this.sessionId
        });

        this.deepgramWs.addEventListener('message', (event) => {
          try {
            const data = JSON.parse(event.data as string);

            // Handle different Deepgram message types
            if (data.type === 'Metadata') {
              console.log('[DEEPGRAM] Metadata received:', JSON.stringify(data));
            } else if (data.type === 'SpeechStarted') {
              console.log('[DEEPGRAM] Speech started detected');
              this.notifyClient({ type: 'speech-started' });
            } else if (data.type === 'UtteranceEnd') {
              console.log('[DEEPGRAM] Utterance end detected');
              this.notifyClient({ type: 'utterance-end' });
            } else if (data.type === 'Results') {
              console.log('[DEEPGRAM] Results received, is_final:', data.is_final);

              // Extract transcript
              if (data.channel?.alternatives?.[0]?.transcript) {
                const transcript = data.channel.alternatives[0].transcript;
                const confidence = data.channel.alternatives[0].confidence || 0;

                if (transcript.trim()) {
                  if (data.is_final) {
                    this.finalTranscriptCount++;
                  }
                  const elapsed = this.callStartedAt ? `${((Date.now() - this.callStartedAt) / 1000).toFixed(1)}s` : '?';
                  console.log(`[DEEPGRAM] [${elapsed}] ${data.is_final ? 'FINAL  ' : 'interim'} (${(confidence * 100).toFixed(0)}%): "${transcript}"`);
                  this.notifyClient({
                    type: 'transcription',
                    text: transcript,
                    is_final: data.is_final || false,
                    confidence: confidence,
                  });
                }
              } else {
                console.log('[DEEPGRAM] Results with no transcript (silence/noise)');
              }
            } else {
              console.log('[DEEPGRAM] Unknown message type:', data.type || 'undefined');
            }
          } catch (err) {
            console.error('[DEEPGRAM] Error processing message:', err);
            this.notifyClient({
              type: 'error',
              message: 'Deepgram processing error',
              details: String(err)
            });
          }
        });

        this.deepgramWs.addEventListener('close', (event) => {
          console.log(`[DEEPGRAM] WebSocket closed (code: ${event.code}, reason: ${event.reason || 'none'})`);
          this.deepgramWs = null;
          this.deepgramConnected = false;
          this.notifyClient({
            type: 'deepgram-disconnected',
            code: event.code,
            reason: event.reason
          });
        });

        this.deepgramWs.addEventListener('error', (event) => {
          console.error('[DEEPGRAM] WebSocket error:', event);
          this.deepgramConnected = false;
          this.notifyClient({
            type: 'error',
            message: 'Deepgram WebSocket error'
          });
        });
      } else {
        console.error('[DEEPGRAM] No webSocket in response');
        this.notifyClient({ type: 'error', message: 'Failed to get Deepgram WebSocket' });
      }
    } catch (err) {
      console.error('[DEEPGRAM] Error connecting:', err);
      this.notifyClient({
        type: 'error',
        message: 'Failed to connect to Deepgram',
        details: String(err)
      });
    }
  }

  /**
   * Synthesizes speech from text using Google Cloud TTS and plays it to caller
   */
  async synthesizeSpeech(text: string): Promise<void> {
    const ttsStart = Date.now();
    try {
      this.ttsRequestCount++;
      console.log(`[TTS] Request #${this.ttsRequestCount} (${text.length} chars): "${text}"`);

      if (!this.twilioWs) {
        console.error('[TTS] No Twilio WebSocket connection');
        this.notifyClient({ type: 'error', message: 'No active call to send audio to' });
        return;
      }

      // Call Google Cloud TTS API
      // See: https://cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize
      const response = await fetch(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${this.env.GOOGLE_TTS_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { text },
            voice: {
              languageCode: 'da-DK',
              name: 'da-DK-Neural2-F',
              ssmlGender: 'FEMALE',
            },
            audioConfig: {
              audioEncoding: 'MULAW',    // Twilio uses mulaw encoding
              sampleRateHertz: 8000,     // Twilio uses 8kHz
            },
          }),
        }
      );

      const ttsLatency = Date.now() - ttsStart;
      console.log(`[TTS] Google TTS response status: ${response.status} (${ttsLatency}ms)`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[TTS] Google TTS error:', errorText);
        this.notifyClient({
          type: 'error',
          message: 'TTS API error',
          details: errorText
        });
        return;
      }

      const data = await response.json() as { audioContent?: string };

      if (data.audioContent && this.twilioWs) {
        console.log(`[TTS] Sending audio to Twilio (${(data.audioContent.length / 1024).toFixed(1)} KB base64, total round-trip ${Date.now() - ttsStart}ms)`);

        // Google TTS returns base64 encoded audio directly
        // Send it back to Twilio - streamSid is required
        if (!this.streamSid) {
          console.error('[TTS] No streamSid available - cannot send audio');
          this.notifyClient({ type: 'error', message: 'No active stream to send audio to' });
          return;
        }

        this.twilioWs.send(
          JSON.stringify({
            event: 'media',
            streamSid: this.streamSid,
            media: {
              payload: data.audioContent,
            },
          })
        );

        this.notifyClient({ type: 'speech-sent', text });
      } else {
        console.error('[TTS] No audio content in response or Twilio disconnected');
        this.notifyClient({ type: 'error', message: 'No audio content received from TTS' });
      }
    } catch (err) {
      console.error('[TTS] Error synthesizing speech:', err);
      this.notifyClient({
        type: 'error',
        message: 'Failed to synthesize speech',
        details: String(err)
      });
    }
  }

  /**
   * Plays a single soft click immediately, then a gentle reminder click every
   * 10 seconds while the user is still typing. One-and-done on short replies,
   * but for longer messages the caller gets periodic confirmation that the
   * user is still composing.
   */
  startTypingClicks(): void {
    if (this.typingClickInterval) return;
    if (!this.callAccepted || !this.twilioWs || !this.streamSid) return;
    console.log('[TYPING] Starting click sound (initial + every 10s)');
    this.sendClick();
    this.typingClickInterval = setInterval(() => this.sendClick(), 10000);
  }

  stopTypingClicks(): void {
    if (this.typingClickInterval) {
      console.log('[TYPING] Stopping click sound');
      clearInterval(this.typingClickInterval);
      this.typingClickInterval = null;
    }
  }

  private sendClick(): void {
    if (!this.twilioWs || !this.streamSid) return;
    this.twilioWs.send(
      JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: CLICK_AUDIO_BASE64 },
      })
    );
  }

  /**
   * Sends a message to the browser client
   */
  notifyClient(message: any): void {
    if (this.clientWs) {
      this.clientWs.send(JSON.stringify(message));
    }
  }

  /**
   * Cleans up call-related connections (but keeps client WebSocket alive)
   */
  cleanup(): void {
    if (this.callStartedAt) {
      const durationSec = ((Date.now() - this.callStartedAt) / 1000).toFixed(1);
      console.log('[CLEANUP] ─────── CALL SUMMARY ───────');
      console.log(`[CLEANUP] Caller:           ${this.callerInfo.from || 'unknown'} → ${this.callerInfo.to || 'unknown'}`);
      console.log(`[CLEANUP] CallSid:          ${this.callerInfo.callSid || 'unknown'}`);
      console.log(`[CLEANUP] Duration:         ${durationSec}s`);
      console.log(`[CLEANUP] Audio packets:    ${this.audioPacketCount} (${(this.audioBytesToDeepgram / 1024).toFixed(1)} KB to Deepgram)`);
      console.log(`[CLEANUP] Final transcripts: ${this.finalTranscriptCount}`);
      console.log(`[CLEANUP] TTS requests:     ${this.ttsRequestCount}`);
      console.log('[CLEANUP] ────────────────────────────');
    } else {
      console.log('[CLEANUP] Cleaning up call connections (no active call)...');
    }
    this.stopTypingClicks();
    if (this.deepgramWs) {
      this.deepgramWs.close();
      this.deepgramWs = null;
      this.deepgramConnected = false;
    }
    if (this.twilioWs) {
      this.twilioWs.close();
      this.twilioWs = null;
    }
    // DON'T close clientWs - keep browser connection alive for next call
    this.callActive = false;
    this.twilioStreamStarted = false;
    this.streamSid = '';
    this.callAccepted = false;
    this.callStartedAt = 0;
    if (this.callTimeout) {
      clearTimeout(this.callTimeout);
      this.callTimeout = null;
    }
  }
}

/**
 * Returns the HTML for the browser client
 */
function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="da">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Smartlinjen</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' style='stop-color:%23667eea;stop-opacity:1' /%3E%3Cstop offset='100%25' style='stop-color:%23764ba2;stop-opacity:1' /%3E%3C/linearGradient%3E%3C/defs%3E%3Ccircle cx='50' cy='50' r='48' fill='url(%23grad)'/%3E%3Cpath d='M35 25 C35 22 37 20 40 20 L60 20 C63 20 65 22 65 25 L65 75 C65 78 63 80 60 80 L40 80 C37 80 35 78 35 75 Z' fill='white' opacity='0.95'/%3E%3Crect x='38' y='28' width='24' height='36' rx='1' fill='url(%23grad)' opacity='0.3'/%3E%3Cline x1='42' y1='35' x2='56' y2='35' stroke='url(%23grad)' stroke-width='2' stroke-linecap='round'/%3E%3Cline x1='42' y1='42' x2='54' y2='42' stroke='url(%23grad)' stroke-width='2' stroke-linecap='round'/%3E%3Cline x1='42' y1='49' x2='58' y2='49' stroke='url(%23grad)' stroke-width='2' stroke-linecap='round'/%3E%3Cline x1='42' y1='56' x2='52' y2='56' stroke='url(%23grad)' stroke-width='2' stroke-linecap='round'/%3E%3Ccircle cx='50' cy='72' r='3' fill='%23667eea' opacity='0.4'/%3E%3C/svg%3E">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
      background: linear-gradient(135deg, #0f0f1e 0%, #1a1a2e 100%);
      color: #fff;
      padding: 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    h1 {
      margin-bottom: 0;
      font-size: 32px;
      font-weight: 700;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      letter-spacing: -0.5px;
    }
    .status {
      padding: 20px 24px;
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 12px;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
    }
    .status.connected {
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.15) 0%, rgba(22, 163, 74, 0.1) 100%);
      border-color: rgba(34, 197, 94, 0.3);
    }
    .status.calling {
      background: linear-gradient(135deg, rgba(96, 165, 250, 0.2) 0%, rgba(59, 130, 246, 0.15) 100%);
      border-color: rgba(96, 165, 250, 0.4);
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.8; }
    }
    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #666;
      transition: all 0.3s ease;
    }
    .status.connected .status-indicator {
      background: #4ade80;
      box-shadow: 0 0 10px #4ade80;
    }
    .status.calling .status-indicator {
      background: #60a5fa;
      box-shadow: 0 0 10px #60a5fa;
      animation: blink 1s infinite;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .transcription-box {
      background: #2a2a2a;
      border-radius: 8px;
      padding: 20px;
      min-height: 300px;
      margin-bottom: 20px;
      max-height: 500px;
      overflow-y: auto;
      position: relative;
    }
    .listening-indicator {
      position: sticky;
      top: 0;
      display: none;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      margin: -20px -20px 16px -20px;
      background: linear-gradient(135deg, rgba(96, 165, 250, 0.25) 0%, rgba(59, 130, 246, 0.18) 100%);
      border-bottom: 2px solid #60a5fa;
      font-size: 15px;
      font-weight: 600;
      color: #93c5fd;
      z-index: 5;
      backdrop-filter: blur(8px);
    }
    .listening-indicator.active {
      display: flex;
    }
    .listening-dot {
      width: 12px;
      height: 12px;
      background: #60a5fa;
      border-radius: 50%;
      box-shadow: 0 0 12px #60a5fa;
      animation: pulse-dot 1.5s infinite;
    }
    .listening-wave {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      margin-left: auto;
    }
    .listening-wave span {
      display: block;
      width: 3px;
      height: 14px;
      background: #60a5fa;
      border-radius: 2px;
      animation: wave 1s ease-in-out infinite;
    }
    .listening-wave span:nth-child(2) { animation-delay: 0.15s; }
    .listening-wave span:nth-child(3) { animation-delay: 0.3s; }
    .listening-wave span:nth-child(4) { animation-delay: 0.45s; }
    @keyframes wave {
      0%, 100% { transform: scaleY(0.4); }
      50% { transform: scaleY(1); }
    }
    @keyframes pulse-dot {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.3); opacity: 0.7; }
    }
    .transcript-line {
      margin-bottom: 10px;
      padding: 16px 18px;
      background: #333;
      border-radius: 6px;
      border-left: 3px solid transparent;
      transition: all 0.3s ease;
      animation: slideIn 0.3s ease;
      font-size: 20px;
      line-height: 1.5;
    }
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(-10px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    .transcript-line.interim {
      background: #2d3748;
      border-left-color: #60a5fa;
      font-style: italic;
      opacity: 0.8;
    }
    .transcript-line.final {
      background: #3a3a3a;
      border-left-color: #4ade80;
    }
    .transcript-line.user-response {
      background: #1e3a5f;
      border-left-color: #3b82f6;
    }
    .transcript-confidence {
      font-size: 10px;
      color: #888;
      margin-top: 4px;
    }
    .response-form {
      display: flex;
      gap: 12px;
      align-items: stretch;
    }
    input[type="text"] {
      flex: 1;
      padding: 18px 20px;
      font-size: 17px;
      border: 2px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      background: #2a2a2a;
      color: #fff;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: rgba(102, 126, 234, 0.6);
      box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.12);
    }
    input[type="text"].typing {
      border-color: rgba(96, 165, 250, 0.7);
      box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.18);
    }
    button {
      padding: 15px 30px;
      font-size: 16px;
      font-weight: bold;
      border: none;
      border-radius: 8px;
      background: #0066ff;
      color: #fff;
      cursor: pointer;
    }
    button:hover { background: #0052cc; }
    button:disabled {
      background: #444;
      cursor: not-allowed;
    }
    button.btn-send {
      padding: 18px 28px;
      font-size: 17px;
      font-weight: 700;
      border-radius: 12px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
      box-shadow: 0 4px 16px rgba(102, 126, 234, 0.35);
      transition: transform 0.15s, box-shadow 0.2s, opacity 0.2s;
      min-width: 170px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    button.btn-send:hover:not(:disabled) {
      background: linear-gradient(135deg, #5568d3 0%, #6a4296 100%);
      transform: translateY(-1px);
      box-shadow: 0 6px 24px rgba(102, 126, 234, 0.5);
    }
    button.btn-send:active:not(:disabled) {
      transform: translateY(0);
    }
    button.btn-send:disabled {
      background: #333;
      box-shadow: none;
    }
    .typing-status {
      display: none;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      padding: 8px 14px;
      font-size: 13px;
      color: #93c5fd;
      background: rgba(96, 165, 250, 0.1);
      border: 1px solid rgba(96, 165, 250, 0.3);
      border-radius: 999px;
      width: fit-content;
    }
    .typing-status.active {
      display: inline-flex;
    }
    .typing-status .typing-dots {
      display: inline-flex;
      gap: 3px;
    }
    .typing-status .typing-dots span {
      width: 5px;
      height: 5px;
      background: #60a5fa;
      border-radius: 50%;
      animation: typing-bounce 1.2s infinite;
    }
    .typing-status .typing-dots span:nth-child(2) { animation-delay: 0.15s; }
    .typing-status .typing-dots span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes typing-bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-4px); opacity: 1; }
    }
    .send-hint {
      font-size: 12px;
      color: #666;
      margin-top: 8px;
      text-align: right;
    }
    .send-hint kbd {
      display: inline-block;
      padding: 2px 6px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      font-family: inherit;
      font-size: 11px;
      color: #aaa;
    }
    /* Incoming call overlay */
    .incoming-call {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      background: linear-gradient(135deg, rgba(96, 165, 250, 0.15) 0%, rgba(59, 130, 246, 0.1) 100%);
      border: 2px solid rgba(96, 165, 250, 0.4);
      border-radius: 16px;
      margin-bottom: 24px;
      animation: incoming-pulse 2s ease-in-out infinite;
    }
    .incoming-call.active {
      display: flex;
    }
    @keyframes incoming-pulse {
      0%, 100% { border-color: rgba(96, 165, 250, 0.4); box-shadow: 0 0 20px rgba(96, 165, 250, 0.1); }
      50% { border-color: rgba(96, 165, 250, 0.8); box-shadow: 0 0 40px rgba(96, 165, 250, 0.3); }
    }
    .incoming-call-icon {
      font-size: 64px;
      margin-bottom: 16px;
      animation: ring 1.5s ease-in-out infinite;
    }
    @keyframes ring {
      0% { transform: rotate(0deg); }
      10% { transform: rotate(15deg); }
      20% { transform: rotate(-15deg); }
      30% { transform: rotate(10deg); }
      40% { transform: rotate(-10deg); }
      50% { transform: rotate(5deg); }
      60% { transform: rotate(0deg); }
      100% { transform: rotate(0deg); }
    }
    .incoming-call-text {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .incoming-call-timer {
      font-size: 14px;
      color: #888;
      margin-bottom: 24px;
    }
    .incoming-call-buttons {
      display: flex;
      gap: 16px;
    }
    .btn-accept {
      padding: 16px 40px;
      font-size: 18px;
      font-weight: 700;
      border: none;
      border-radius: 50px;
      background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
      color: #fff;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn-accept:hover {
      transform: scale(1.05);
      box-shadow: 0 4px 20px rgba(34, 197, 94, 0.4);
    }
    .btn-reject {
      padding: 16px 40px;
      font-size: 18px;
      font-weight: 700;
      border: none;
      border-radius: 50px;
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      color: #fff;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn-reject:hover {
      transform: scale(1.05);
      box-shadow: 0 4px 20px rgba(239, 68, 68, 0.4);
    }

    /* Demo badge in header */
    .demo-badge {
      display: inline-block;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      background: rgba(102, 126, 234, 0.18);
      border: 1px solid rgba(102, 126, 234, 0.5);
      color: #a5b4fc;
      border-radius: 999px;
      vertical-align: middle;
      margin-left: 12px;
      -webkit-text-fill-color: #a5b4fc;
    }

    /* Slim info card (replaces big yellow warning) */
    .info-card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 14px 18px;
      margin-bottom: 24px;
      font-size: 14px;
      color: #aab;
      line-height: 1.6;
    }
    .info-card strong {
      color: #60a5fa;
      font-weight: 600;
    }

    /* Quick-reply chips */
    .quick-replies {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
      opacity: 0.4;
      pointer-events: none;
      transition: opacity 0.3s;
    }
    .quick-replies.active {
      opacity: 1;
      pointer-events: auto;
    }
    .quick-replies-label {
      width: 100%;
      font-size: 12px;
      color: #888;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
    }
    .quick-reply-chip {
      padding: 10px 18px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #fff;
      border-radius: 999px;
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
    }
    .quick-reply-chip:hover {
      background: rgba(102, 126, 234, 0.25);
      border-color: rgba(102, 126, 234, 0.6);
      transform: translateY(-1px);
    }
    .quick-reply-chip:active {
      transform: translateY(0);
    }

    /* Presenter panel (kun synlig med ?presenter i URL) */
    .presenter-panel {
      display: none;
      position: fixed;
      top: 20px;
      right: 20px;
      width: 320px;
      max-height: calc(100vh - 40px);
      overflow-y: auto;
      background: rgba(15, 15, 30, 0.95);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(102, 126, 234, 0.4);
      border-radius: 14px;
      padding: 20px 20px 16px 20px;
      font-size: 13px;
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
      z-index: 1000;
    }
    .presenter-panel.visible {
      display: block;
    }
    .presenter-panel h3 {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #a5b4fc;
      margin-bottom: 14px;
    }
    .presenter-panel .script-section {
      margin-bottom: 14px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .presenter-panel .script-section:last-child {
      border-bottom: none;
      margin-bottom: 0;
      padding-bottom: 0;
    }
    .presenter-panel .script-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #888;
      margin-bottom: 6px;
      font-weight: 600;
    }
    .presenter-panel .script-line {
      color: #eee;
      line-height: 1.5;
      margin-bottom: 4px;
    }
    .presenter-panel .close-btn {
      position: absolute;
      top: 10px;
      right: 10px;
      background: none;
      border: none;
      color: #888;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      padding: 4px 8px;
    }
    .presenter-panel .close-btn:hover {
      color: #fff;
    }
  </style>
</head>
<body>
  <div class="container">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
      <h1 style="margin-bottom: 0;">Smartlinjen<span class="demo-badge">DEMO</span></h1>
    </div>

    <div class="info-card">
      Ring til <strong>+45 52 51 36 34</strong> for at teste live transskription og tekst-til-tale. Hold denne side åben under opkaldet.
    </div>

    <div class="status" id="status">
      <div class="status-indicator"></div>
      <span id="statusText">Venter på opkald...</span>
    </div>

    <div class="incoming-call" id="incomingCall">
      <div class="incoming-call-icon">📞</div>
      <div class="incoming-call-text">Indgående opkald</div>
      <div class="incoming-call-timer" id="incomingTimer"></div>
      <div class="incoming-call-buttons">
        <button class="btn-accept" id="btnAccept">Tag opkald</button>
        <button class="btn-reject" id="btnReject">Afvis</button>
      </div>
    </div>

    <div class="transcription-box" id="transcription">
      <div class="listening-indicator" id="listeningIndicator">
        <div class="listening-dot"></div>
        <span>🎙️ Modparten taler...</span>
        <div class="listening-wave"><span></span><span></span><span></span><span></span></div>
      </div>
      <p style="color: #888;">Transskription vises her når opkaldet starter...</p>
    </div>

    <div class="quick-replies" id="quickReplies">
      <div class="quick-replies-label">Hurtigsvar — klik for at læse op for opkalder</div>
      <button type="button" class="quick-reply-chip" data-reply="Ja tak.">Ja tak</button>
      <button type="button" class="quick-reply-chip" data-reply="Nej tak.">Nej tak</button>
      <button type="button" class="quick-reply-chip" data-reply="Kan du gentage det?">Kan du gentage?</button>
      <button type="button" class="quick-reply-chip" data-reply="Lige et øjeblik, jeg skriver et svar.">Et øjeblik</button>
      <button type="button" class="quick-reply-chip" data-reply="Kan du ringe tilbage om lidt?">Ring tilbage senere</button>
      <button type="button" class="quick-reply-chip" data-reply="Vil du sende det på SMS eller mail i stedet?">Send SMS/mail i stedet</button>
    </div>

    <form class="response-form" id="responseForm">
      <input
        type="text"
        id="responseInput"
        placeholder="Venter på opkald..."
        disabled
        style="opacity: 0.5;"
        autocomplete="off"
      />
      <button type="submit" class="btn-send" id="sendBtn" disabled style="opacity: 0.5;">
        <span>📤</span><span>Send &amp; oplæs</span>
      </button>
    </form>
    <div class="typing-status" id="typingStatus">
      <span>🔊 Modparten hører kliklyd</span>
      <span class="typing-dots"><span></span><span></span><span></span></span>
    </div>
    <div class="send-hint">Tryk <kbd>Enter</kbd> for at sende og læse op</div>
  </div>

  <aside class="presenter-panel" id="presenterPanel">
    <button class="close-btn" type="button" id="presenterClose" aria-label="Luk">&times;</button>
    <h3>Præsentations-script</h3>

    <div class="script-section">
      <div class="script-title">Åbning (sig når opkald tages)</div>
      <div class="script-line">"Hej, det er Kasper fra Jobcenter Aarhus."</div>
      <div class="script-line">"Jeg ringer angående din ansøgning."</div>
    </div>

    <div class="script-section">
      <div class="script-title">Tal &amp; navne (vis nøjagtighed)</div>
      <div class="script-line">"Mit telefonnummer er 28 45 17 93."</div>
      <div class="script-line">"Adressen er Jagtvej 172, 2100 København Ø."</div>
      <div class="script-line">"Sagsbehandleren hedder Mette Sørensen."</div>
    </div>

    <div class="script-section">
      <div class="script-title">Fagsprog (læge-scenarie)</div>
      <div class="script-line">"Dine blodprøver viser forhøjet kolesterol."</div>
      <div class="script-line">"Vi skal bestille ny tid på tirsdag klokken 14."</div>
    </div>

    <div class="script-section">
      <div class="script-title">Talking points til Anne &amp; Claus</div>
      <div class="script-line">• Dansk Nova-2 — Nagish gør det ikke på dansk</div>
      <div class="script-line">• Under 2 sek. latency</div>
      <div class="script-line">• Twilio-nummer i dag, eget nummer i v2</div>
      <div class="script-line">• 4.000 døve + 800.000 hørehæmmede</div>
      <div class="script-line">• § 112 hjælpemiddel-spor?</div>
    </div>
  </aside>

  <script>
    let ws = null;
    let reconnectAttempts = 0;
    let maxReconnectDelay = 30000; // Max 30 seconds
    let reconnectTimer = null;
    let pingInterval = null;
    let incomingTimerInterval = null;
    let incomingTimerSeconds = 30;
    const sessionId = 'default'; // In production, generate unique session ID

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = \`\${protocol}//\${window.location.host}/client/\${sessionId}\`;

      console.log('[CLIENT] Connecting to:', wsUrl, '(attempt', reconnectAttempts + 1 + ')');

      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        console.error('[CLIENT] Failed to create WebSocket:', err);
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        console.log('[CLIENT] Connected to Smartlinjen');
        reconnectAttempts = 0; // Reset on successful connection
        updateStatus('Forbundet - venter på opkald', 'connected');

        // Start ping/pong heartbeat
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            console.log('[CLIENT] Sending ping');
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 15000); // Ping every 15 seconds
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log('[CLIENT] Received message:', message.type, message);

          switch (message.type) {
            case 'connected':
              console.log('[CLIENT] Initial connection state:', message.state);
              updateStatus('Forbundet - venter på opkald', 'connected');
              break;

            case 'call-incoming':
              console.log('[CLIENT] Incoming call!', message.debug);
              updateStatus('📞 Indgående opkald...', 'calling');
              showIncomingCall();
              break;

            case 'call-started':
              console.log('[CLIENT] Call started, debug:', message.debug);
              hideIncomingCall();
              updateStatus('📞 Opkald i gang', 'calling');
              document.getElementById('responseInput').disabled = false;
              document.getElementById('responseInput').style.opacity = '1';
              document.getElementById('responseInput').placeholder = 'Skriv dit svar her...';
              document.getElementById('sendBtn').disabled = false;
              document.getElementById('sendBtn').style.opacity = '1';
              document.getElementById('quickReplies').classList.add('active');
              // Remove "waiting" message if present
              {
                const waitingMsg = document.getElementById('transcription').querySelector('p[style]');
                if (waitingMsg) waitingMsg.remove();
              }
              break;

            case 'call-ended':
              hideIncomingCall();
              updateStatus('Opkald afsluttet', 'connected');
              document.getElementById('responseInput').disabled = true;
              document.getElementById('responseInput').style.opacity = '0.5';
              document.getElementById('responseInput').placeholder = 'Venter på opkald...';
              document.getElementById('responseInput').value = '';
              document.getElementById('sendBtn').disabled = true;
              document.getElementById('sendBtn').style.opacity = '0.5';
              document.getElementById('quickReplies').classList.remove('active');
              stopTyping();
              break;

            case 'call-timeout':
              console.log('[CLIENT] Call timed out');
              hideIncomingCall();
              updateStatus('Opkald ikke besvaret', 'connected');
              addDebugMessage('Opkald ikke besvaret (timeout)');
              break;

            case 'call-rejected':
              console.log('[CLIENT] Call rejected');
              hideIncomingCall();
              updateStatus('Opkald afvist', 'connected');
              break;

            case 'transcription':
              addTranscription(message.text, message.is_final, message.confidence);
              break;

            case 'deepgram-connected':
              console.log('[CLIENT] Deepgram connected');
              // Don't show debug message - connection is implicit
              break;

            case 'deepgram-disconnected':
              console.log('[CLIENT] Deepgram disconnected:', message.code, message.reason);
              // Only show if unexpected disconnection
              if (message.code !== 1000) {
                addDebugMessage('⚠️ Deepgram afbrudt');
              }
              break;

            case 'speech-started':
              console.log('[CLIENT] Speech detection started');
              document.getElementById('listeningIndicator').classList.add('active');
              // Don't add debug message - just show animation
              break;

            case 'utterance-end':
              console.log('[CLIENT] Utterance ended');
              document.getElementById('listeningIndicator').classList.remove('active');
              // Don't add debug message - just hide animation
              break;

            case 'twilio-disconnected':
              console.log('[CLIENT] Twilio disconnected:', message.code, message.reason);
              // Only show if unexpected disconnection during active call
              if (message.code !== 1000 && message.code !== 1001) {
                addDebugMessage('⚠️ Opkald afbrudt uventet');
              }
              break;

            case 'speech-sent':
              console.log('[CLIENT] Speech sent to caller');
              // Visual feedback is already shown in transcript
              break;

            case 'pong':
              console.log('[CLIENT] Pong received, state:', message.state);
              break;

            case 'error':
              console.error('[CLIENT] Error:', message.message, message.details);
              addDebugMessage('❌ Fejl: ' + message.message);
              if (message.details) {
                console.error('[CLIENT] Error details:', message.details);
              }
              break;

            default:
              console.log('[CLIENT] Unknown message type:', message.type);
          }
        } catch (err) {
          console.error('[CLIENT] Error processing message:', err);
        }
      };

      ws.onclose = (event) => {
        console.log('[CLIENT] WebSocket closed (code:', event.code, ', reason:', event.reason || 'none', ')');

        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }

        // Code 1001 = going away (often happens during worker upgrade)
        if (event.code === 1001) {
          updateStatus('Worker blev opgraderet - genopret forbindelse...', 'reconnecting');
          addDebugMessage('⚠️ Worker upgrade detekteret - genopret forbindelse');
        } else {
          updateStatus('Forbindelse afbrudt - prøver igen...', 'reconnecting');
        }

        scheduleReconnect();
      };

      ws.onerror = (error) => {
        console.error('[CLIENT] WebSocket error:', error);
        addDebugMessage('❌ WebSocket fejl');
      };
    }

    function scheduleReconnect() {
      if (reconnectTimer) return; // Already scheduled

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, up to max
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
      reconnectAttempts++;

      console.log('[CLIENT] Scheduling reconnect in', delay, 'ms (attempt', reconnectAttempts, ')');
      updateStatus(\`Genopret forbindelse om \${Math.round(delay/1000)}s...\`, false);

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function addDebugMessage(text) {
      const transcriptionBox = document.getElementById('transcription');
      const debugLine = document.createElement('div');
      debugLine.className = 'transcript-line';
      debugLine.style.background = '#2a2a2a';
      debugLine.style.color = '#888';
      debugLine.style.fontSize = '12px';
      debugLine.style.fontStyle = 'italic';
      debugLine.textContent = '[' + new Date().toLocaleTimeString('da-DK') + '] ' + text;
      transcriptionBox.appendChild(debugLine);
      transcriptionBox.scrollTop = transcriptionBox.scrollHeight;
    }

    function updateStatus(text, state) {
      const statusEl = document.getElementById('status');
      const statusText = document.getElementById('statusText');
      statusText.textContent = text;

      // Update CSS class based on state
      statusEl.className = 'status';
      if (state === 'connected') {
        statusEl.classList.add('connected');
      } else if (state === 'calling') {
        statusEl.classList.add('calling');
      }
    }

    function addTranscription(text, isFinal, confidence) {
      const transcriptionBox = document.getElementById('transcription');

      // Remove "waiting" message if present
      const waitingMsg = transcriptionBox.querySelector('p[style]');
      if (waitingMsg) {
        waitingMsg.remove();
      }

      // Update or create transcript line
      let line = document.getElementById('current-line');
      if (isFinal || !line) {
        line = document.createElement('div');
        line.className = 'transcript-line';
        line.id = isFinal ? '' : 'current-line';

        if (isFinal) {
          line.classList.add('final');
        } else {
          line.classList.add('interim');
        }

        transcriptionBox.appendChild(line);
      }

      line.textContent = text;

      // Add confidence indicator for final transcripts
      if (isFinal && confidence !== undefined) {
        const confidenceBar = document.createElement('div');
        confidenceBar.className = 'transcript-confidence';
        const percentage = Math.round(confidence * 100);
        const emoji = percentage > 90 ? '✨' : percentage > 70 ? '👍' : '🤔';
        confidenceBar.textContent = \`\${emoji} Sikkerhed: \${percentage}%\`;
        line.appendChild(confidenceBar);
      }

      transcriptionBox.scrollTop = transcriptionBox.scrollHeight;
    }

    function showIncomingCall() {
      document.getElementById('incomingCall').classList.add('active');
      incomingTimerSeconds = 30;
      document.getElementById('incomingTimer').textContent = 'Besvares automatisk ikke om ' + incomingTimerSeconds + 's';
      if (incomingTimerInterval) clearInterval(incomingTimerInterval);
      incomingTimerInterval = setInterval(() => {
        incomingTimerSeconds--;
        if (incomingTimerSeconds <= 0) {
          clearInterval(incomingTimerInterval);
          incomingTimerInterval = null;
          return;
        }
        document.getElementById('incomingTimer').textContent = 'Besvares automatisk ikke om ' + incomingTimerSeconds + 's';
      }, 1000);
    }

    function hideIncomingCall() {
      document.getElementById('incomingCall').classList.remove('active');
      if (incomingTimerInterval) {
        clearInterval(incomingTimerInterval);
        incomingTimerInterval = null;
      }
    }

    document.getElementById('btnAccept').addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'call-accept' }));
      }
    });

    document.getElementById('btnReject').addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'call-reject' }));
      }
    });

    function sendReply(text) {
      if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
      stopTyping(); // stop click sound the moment we send the real audio
      ws.send(JSON.stringify({ type: 'user-response', text: text }));

      const transcriptionBox = document.getElementById('transcription');
      const userLine = document.createElement('div');
      userLine.className = 'transcript-line user-response';
      userLine.textContent = '💬 Du: ' + text;
      transcriptionBox.appendChild(userLine);
      transcriptionBox.scrollTop = transcriptionBox.scrollHeight;
    }

    // Typing detection — when the user is typing, send 'typing-start' so the
    // worker plays a click sound to the caller. Debounce 'typing-stop' after
    // 1.5s of inactivity so a brief pause doesn't kill the audible cue.
    let isTyping = false;
    let typingStopTimeout = null;
    const TYPING_IDLE_MS = 1500;

    function startTyping() {
      if (isTyping) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      isTyping = true;
      ws.send(JSON.stringify({ type: 'typing-start' }));
      document.getElementById('responseInput').classList.add('typing');
      document.getElementById('typingStatus').classList.add('active');
    }

    function stopTyping() {
      if (typingStopTimeout) {
        clearTimeout(typingStopTimeout);
        typingStopTimeout = null;
      }
      if (!isTyping) return;
      isTyping = false;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'typing-stop' }));
      }
      document.getElementById('responseInput').classList.remove('typing');
      document.getElementById('typingStatus').classList.remove('active');
    }

    function scheduleTypingStop() {
      if (typingStopTimeout) clearTimeout(typingStopTimeout);
      typingStopTimeout = setTimeout(stopTyping, TYPING_IDLE_MS);
    }

    document.getElementById('responseInput').addEventListener('input', (e) => {
      if (e.target.value.length === 0) {
        stopTyping();
        return;
      }
      startTyping();
      scheduleTypingStop();
    });

    document.getElementById('responseInput').addEventListener('blur', () => {
      // If field loses focus, stop typing immediately
      stopTyping();
    });

    document.getElementById('responseForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('responseInput');
      const text = input.value.trim();
      if (text) {
        sendReply(text);
        input.value = '';
      }
    });

    document.querySelectorAll('.quick-reply-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        sendReply(chip.dataset.reply);
      });
    });

    // Presenter panel toggle (vis med ?presenter i URL)
    if (new URLSearchParams(window.location.search).has('presenter')) {
      document.getElementById('presenterPanel').classList.add('visible');
    }
    document.getElementById('presenterClose').addEventListener('click', () => {
      document.getElementById('presenterPanel').classList.remove('visible');
    });

    // Connect on page load
    connect();
  </script>
</body>
</html>`;
}
