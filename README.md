# EchoText

Live transskription af telefonopkald for døve med mulighed for at svare via tekst-til-tale.

**Dansk alternativ til [Nagish](https://www.nagish.com)** - fordi Nagish ikke understøtter danske telefonnumre.

## Use Cases

### Jobsamtaler
Du søger job og venter på svar. Rekruttereren ringer fra et ukendt nummer. Med EchoText kan du:
- Se hvem der ringer og hvad de siger
- Svare professionelt via tekst-til-tale
- Aldrig misse en vigtig jobmulighed igen

### Læge og sundhed
Hospitalet ringer med prøvesvar eller aftaler. I stedet for at bede om SMS:
- Modtag opkaldet direkte
- Læs beskeden i realtid
- Still opfølgende spørgsmål via tekst

### Bank og myndigheder
Banken ringer om dit lån. SKAT har spørgsmål. Mange institutioner kræver telefonverifikation:
- Håndter officielle opkald selvstændigt
- Ingen behov for tolk eller hjælper
- Bevar privatliv i følsomme samtaler

### Håndværkere og service
Elektrikeren ringer for at aftale tid. Pakkebuddet kan ikke finde adressen:
- Koordiner praktiske ting direkte
- Hurtige svar uden forsinkelse
- Undgå misforståelser via SMS-ping-pong

### Familie og venner
Ikke alle er gode til at skrive beskeder. Bedsteforældre foretrækker måske at ringe:
- Hold kontakten med dem der ringer
- Mere naturlig samtaleflow end SMS
- De behøver ikke ændre vaner

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

## Roadmap

### v1.0 - PoC (nuværende)
**Mål:** Validere at teknologien virker til danske telefonopkald.

- [x] Deepgram dansk transskription test
- [ ] Cloudflare Worker med Durable Object
- [ ] Twilio Media Streams integration
- [ ] Google TTS integration
- [ ] Simpel webside til transskription

**Succeskriterium:** Gennemfør én samtale hvor begge parter forstår hinanden.

---

### v1.1 - Notifikationer
**Mål:** Vide når nogen ringer, selvom telefonen er i lommen.

- [ ] PWA med Service Worker
- [ ] Web Push notifikationer (VAPID)
- [ ] Vibration ved indgående opkald
- [ ] "Ring til mig" SMS når opkald starter

**Succeskriterium:** Aldrig misse et opkald fordi du ikke så browseren.

---

### v1.2 - Udgående opkald
**Mål:** Kunne ringe til andre, ikke kun modtage.

- [ ] UI til at indtaste telefonnummer
- [ ] Twilio outbound call API
- [ ] Samme transskription/TTS flow
- [ ] Opkaldshistorik

**Succeskriterium:** Ring til en ven og hav en samtale.

---

### v2.0 - Brug dit eget nummer
**Mål:** Folk ringer til dit rigtige nummer, ikke et Twilio-nummer.

- [ ] Viderestilling fra dit nummer til Twilio
- [ ] Caller ID preservation
- [ ] Fallback hvis EchoText er offline
- [ ] Eventuelt nummer-portering til Telnyx (billigere)

**Succeskriterium:** Rekrutterer ringer dit CV-nummer og du modtager via EchoText.

---

### v2.1 - Samtalehistorik
**Mål:** Gennemlæs tidligere samtaler.

- [ ] Database (Cloudflare D1 eller KV)
- [ ] Gem transskription + dine svar
- [ ] Søgefunktion
- [ ] Eksport til tekst/PDF

**Succeskriterium:** Find hvad lægen sagde for 2 uger siden.

---

### v3.0 - Multi-user
**Mål:** Andre døve kan bruge EchoText.

- [ ] Brugeroprettelse og login
- [ ] Hvert bruger får eget Twilio-nummer (eller medbring eget)
- [ ] Subscription/betaling
- [ ] Admin dashboard

**Succeskriterium:** 10 brugere der aktivt bruger systemet.

---

### Fremtidige idéer
- **Hurtigsvar:** Foruddefinerede svar ("Jeg ringer tilbage", "Send SMS i stedet")
- **AI-assistent:** Automatisk svar på simple spørgsmål
- **Flere sprog:** Engelsk, svensk, norsk
- **Dialekter:** Jysk, sønderjysk, københavnsk
- **Videoopkald:** Integration med FaceTime/WhatsApp transskription
- **Telefonsvarer:** Transskriberet voicemail

## Licens

MIT
