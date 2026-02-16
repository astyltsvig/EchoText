# EchoText - Arkitektur

## Overordnet flow
```
Opkalder ringer → Twilio streamer audio → Deepgram transskriberer →
Bruger ser teksten i browser → Bruger skriver svar → Google TTS læser op for opkalderen
```

## Komponenter

### 1. Twilio (Telefoni)
- Modtager indgående opkald til dansk nummer (+45)
- Streamer audio via WebSocket (mulaw 8kHz format)
- Sender TTS audio tilbage til opkalder

### 2. Cloudflare Worker + Durable Object
**Central orchestrator** - håndterer al kommunikation

Ansvar:
- Modtager audio fra Twilio via WebSocket
- Streamer audio videre til Deepgram
- Sender transskription til browser via WebSocket
- Modtager tekstsvar fra browser
- Kalder Google TTS for at konvertere tekst til tale
- Sender TTS audio tilbage til Twilio

### 3. Deepgram Nova-2 (Speech-to-Text)
- Modtager audio stream fra Durable Object
- Transskriberer til dansk tekst i realtid
- Returnerer transskription løbende

### 4. Google Cloud TTS (Text-to-Speech)
- Modtager tekstsvar fra bruger
- Genererer naturlig dansk tale (Wavenet)
- Returnerer audio til Durable Object

### 5. Browser (Frontend)
- Viser live transskription
- Tekstfelt til at skrive svar
- Send-knap til at aflevere svar
- Simpel HTML/JS implementation

## API Endpoints

| Endpoint | Type | Formål |
|----------|------|--------|
| `/incoming-call` | POST webhook | Twilio kalder ved indgående opkald |
| `/media-stream/:sessionId` | WebSocket | Twilio audio stream |
| `/client/:sessionId` | WebSocket | Browser forbindelse |

## Data Flow

### Indgående audio (opkalder → bruger)
1. Opkalder taler
2. Twilio streamer mulaw audio → Durable Object
3. Durable Object streamer → Deepgram
4. Deepgram transskriberer → dansk tekst
5. Durable Object sender tekst → Browser
6. Bruger læser tekst

### Udgående audio (bruger → opkalder)
1. Bruger skriver svar i browser
2. Browser sender tekst → Durable Object
3. Durable Object kalder Google TTS
4. Google TTS genererer audio
5. Durable Object sender audio → Twilio
6. Twilio afspiller audio for opkalder

## Tech Stack

| Komponent | Teknologi | Begrundelse |
|-----------|-----------|-------------|
| Telefoni | Twilio | Understøtter danske numre, god WebSocket support |
| Speech-to-Text | Deepgram Nova-2 | Bedste dansk transskription, low latency |
| Text-to-Speech | Google Cloud TTS | Naturlig dansk Wavenet stemme |
| Backend | Cloudflare Workers + Durable Objects | WebSocket håndtering, global distribution, gratis tier |
| Frontend | Simpel HTML/JS | Minimal kompleksitet for PoC |

## Projektstruktur

```
echotext/
├── worker/                 # Cloudflare Worker
│   ├── src/
│   │   └── index.ts       # Worker + Durable Object implementation
│   ├── wrangler.toml      # Cloudflare configuration
│   └── package.json
│
├── web/                    # Frontend
│   └── index.html         # Simpel webside
│
├── .claude_docs/          # Claude AI documentation
└── README.md
```

## Sikkerhed og privatliv
- Session-baseret kommunikation via WebSocket
- Ingen persistent lagring af samtaler (PoC fase)
- API keys gemmes som Cloudflare secrets
- HTTPS/WSS kryptering på alle forbindelser

## Skalerbarhed
**PoC fase:** Single user, ingen deling
**Fremtid (v3.0):** Multi-user med brugeroprettelse og separate telefonnumre

## Latency considerations
Kritiske faktorer for samtaleflow:
1. Deepgram streaming latency (~200-500ms)
2. Google TTS generation (~500-1000ms)
3. Network latency (minimeret via Cloudflare global edge)

**Målsætning:** Under 2 sekunder total latency fra tale til transskription
