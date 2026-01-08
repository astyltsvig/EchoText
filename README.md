# EchoText

Live transskription af telefonopkald for døve med mulighed for at svare via tekst-til-tale.

**Dansk alternativ til [Nagish](https://www.nagish.com)** - fordi Nagish ikke understøtter danske telefonnumre.

## Koncept

```
Opkalder ringer → Twilio streamer audio → Deepgram transskriberer →
Du ser teksten i browser → Du skriver svar → Google TTS læser op for opkalderen
```

## PoC Scope

### In scope
- Indgående opkald til Twilio-nummer
- Live transskription (dansk) via Deepgram Nova-2
- Tekstsvar via Google TTS (Wavenet, naturlig stemme)
- Simpel webside i browser

### Out of scope (v2)
- Udgående opkald
- Push notifikationer / PWA
- Multi-user / brugeroprettelse
- Persistent samtalehistorik
- Dialekthåndtering

## Arkitektur

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Opkalder ringer til Twilio nummer (+45 XX XX XX XX)       │
│                         │                                   │
│                         ▼                                   │
│                    ┌─────────┐                              │
│                    │ TWILIO  │                              │
│                    └────┬────┘                              │
│                         │ WebSocket (mulaw 8kHz)            │
│                         ▼                                   │
│   ┌─────────────────────────────────────────────┐          │
│   │      CLOUDFLARE DURABLE OBJECT              │          │
│   │                                             │          │
│   │  • Modtager audio fra Twilio                │◄── WS ──┐│
│   │  • Streamer til Deepgram                    │         ││
│   │  • Sender transskription til browser        │         ││
│   │  • Modtager tekstsvar fra browser           │         ││
│   │  • Kalder Google TTS                        │         ││
│   │  • Sender TTS audio til Twilio              │         ││
│   └─────────────────────────────────────────────┘         ││
│         │                   │                              ││
│         ▼                   ▼                              ││
│   ┌──────────┐        ┌──────────┐                        ││
│   │ DEEPGRAM │        │  GOOGLE  │                        ││
│   │ Nova-2   │        │   TTS    │                        ││
│   │ (da)     │        │ Wavenet  │                        ││
│   └──────────┘        └──────────┘                        ││
│                                                            ││
│   ┌─────────────────────────────────────────────┐         ││
│   │            BROWSER (din telefon)            │─────────┘│
│   │                                             │          │
│   │  • Viser live transskription                │          │
│   │  • Tekstfelt til svar                       │          │
│   │  • Send-knap                                │          │
│   └─────────────────────────────────────────────┘          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Komponent | Teknologi | Formål |
|-----------|-----------|--------|
| Telefoni | Twilio | Modtager opkald, streamer audio |
| Speech-to-Text | Deepgram Nova-2 | Dansk transskription i realtid |
| Text-to-Speech | Google Cloud TTS | Naturlig dansk stemme (Wavenet) |
| Backend | Cloudflare Workers + Durable Objects | WebSocket håndtering |
| Frontend | Simpel HTML/JS | Viser transskription, input til svar |

## Projektstruktur

```
echotext/
├── worker/                 # Cloudflare Worker
│   ├── src/
│   │   └── index.ts       # Worker + Durable Object
│   ├── wrangler.toml      # Cloudflare config
│   └── package.json
│
├── web/                    # Frontend
│   └── index.html         # Simpel webside
│
└── README.md
```

## API Endpoints

| Endpoint | Metode | Formål |
|----------|--------|--------|
| `/incoming-call` | POST | Twilio webhook ved indgående opkald |
| `/media-stream/:sessionId` | WebSocket | Twilio audio stream |
| `/client/:sessionId` | WebSocket | Browser forbindelse |

## Opsætning

### 1. Opret konti og få API keys

**Deepgram** (speech-to-text)
- Opret konto: https://deepgram.com
- Opret API key
- $200 gratis credits ved signup

**Google Cloud** (text-to-speech)
- Opret projekt: https://console.cloud.google.com
- Aktiver "Cloud Text-to-Speech API"
- Opret API key

**Twilio** (telefoni)
- Opret konto: https://www.twilio.com
- Køb dansk nummer (+45)
- Noter Account SID og Auth Token

**Cloudflare** (hosting)
- Opret konto: https://dash.cloudflare.com
- Installer Wrangler: `npm install -g wrangler`
- Login: `wrangler login`

### 2. Konfigurer secrets

```bash
cd worker
wrangler secret put DEEPGRAM_API_KEY
wrangler secret put GOOGLE_TTS_API_KEY
```

### 3. Deploy worker

```bash
cd worker
npm install
wrangler deploy
```

### 4. Konfigurer Twilio webhook

1. Gå til Twilio Console → Phone Numbers → Dit nummer
2. Under "Voice & Fax" → "A call comes in":
   - Webhook URL: `https://echotext.<din-subdomain>.workers.dev/incoming-call`
   - HTTP Method: POST

### 5. Test

1. Åbn `https://echotext.<din-subdomain>.workers.dev/` i browser
2. Ring til dit Twilio nummer
3. Se transskription i browseren
4. Skriv svar og send

## Prisestimat (PoC)

Baseret på ~10 opkald á 5 minutter per måned:

| Service | Pris |
|---------|------|
| Twilio nummer | ~$15/md |
| Twilio tale | ~$1/md |
| Deepgram | ~$0.20/md (gratis credits) |
| Google TTS | ~$0.05/md |
| Cloudflare | Gratis |
| **Total** | **~$16/md (~110 kr)** |

## Succeskriterier

1. **Transskription:** Kan du forstå hvad opkalder siger?
2. **TTS:** Kan opkalder forstå dine svar?
3. **Latency:** Er forsinkelsen acceptabel for samtale?

## Næste skridt (v2)

- [ ] Push notifikationer ved indgående opkald
- [ ] Udgående opkald
- [ ] PWA med offline support
- [ ] Samtalehistorik
- [ ] Multi-user support
- [ ] Viderestilling fra eget nummer

## Licens

MIT
