# EchoText - Setup Guide

Denne guide hjælper dig med at få EchoText op at køre fra bunden.

## Forudsætninger

- Node.js 18+ installeret
- npm eller yarn
- En computer med terminal/kommandolinje adgang

## 1. Cloudflare Opsætning

### 1.1 Opret Cloudflare konto
1. Gå til https://dash.cloudflare.com
2. Tilmeld dig med din email
3. Verificer din email

### 1.2 Installer Wrangler CLI
```bash
npm install -g wrangler
```

### 1.3 Login til Cloudflare
```bash
wrangler login
```
Dette åbner en browser hvor du godkender adgang.

### 1.4 Verificer login
```bash
wrangler whoami
```

## 2. Deepgram Opsætning (Speech-to-Text)

### 2.1 Opret konto
1. Gå til https://console.deepgram.com
2. Tilmeld dig (få $200 gratis credits)
3. Verificer din email

### 2.2 Opret API key
1. Gå til https://console.deepgram.com/project/default/keys
2. Klik "Create New API Key"
3. Giv den et navn (f.eks. "EchoText")
4. Vælg "Member" role
5. Kopier API key (den vises kun én gang!)

### 2.3 Test Deepgram (valgfrit)
```bash
curl -X POST https://api.deepgram.com/v1/listen?model=nova-2&language=da \
  -H "Authorization: Token DIN_API_KEY" \
  -H "Content-Type: audio/wav" \
  --data-binary @test.wav
```

## 3. Google Cloud Opsætning (Text-to-Speech)

### 3.1 Opret Google Cloud konto
1. Gå til https://console.cloud.google.com
2. Log ind med din Google konto
3. Accepter vilkår og betingelser
4. Eventuelt: Tilføj betalingsmetode (gratis tier rækker langt)

### 3.2 Opret nyt projekt
1. Klik på projekt dropdown (øverst)
2. Klik "New Project"
3. Navn: "EchoText"
4. Klik "Create"

### 3.3 Aktiver Text-to-Speech API
1. Gå til https://console.cloud.google.com/apis/library/texttospeech.googleapis.com
2. Sørg for at dit "EchoText" projekt er valgt
3. Klik "Enable"

### 3.4 Opret API key
1. Gå til https://console.cloud.google.com/apis/credentials
2. Klik "Create Credentials" → "API key"
3. Kopier API key
4. (Anbefalet) Klik "Restrict Key"
   - Under "API restrictions" vælg "Restrict key"
   - Vælg "Cloud Text-to-Speech API"
   - Klik "Save"

## 4. Twilio Opsætning (Telefoni)

### 4.1 Opret Twilio konto
1. Gå til https://www.twilio.com/try-twilio
2. Tilmeld dig (får $15 trial credit)
3. Verificer din email og telefonnummer

### 4.2 Aktiver din konto ⚠️
**VIGTIGT:** Twilio trial-konti har begrænsninger. For at kunne:
- Købe danske (+45) numre
- Modtage opkald fra alle numre (ikke kun verificerede)
- Fjerne "trial account" beskeder i opkald

Du skal **opgradere kontoen**:

1. Gå til https://console.twilio.com/us1/billing/manage-billing/billing-overview
2. Klik "Upgrade" eller "Add payment method"
3. Tilføj et kreditkort
4. Accepter vilkår

**Note:** Du betaler kun for det du bruger - ingen månedlig fast pris (udover telefonnummeret).

### 4.3 Køb dansk telefonnummer
1. Gå til https://console.twilio.com/us1/develop/phone-numbers/manage/search
2. Vælg "Denmark (+45)"
3. Vælg "Voice" capabilities
4. Søg efter nummer
5. Køb nummer (~$15/md)

**Hvis du ikke kan se danske numre:**
- Sørg for at din konto er opgraderet (se 4.2)
- Nogle numre kræver Address SID (dansk adresse):
  - Gå til https://console.twilio.com/us1/develop/phone-numbers/regulatory-compliance/addresses
  - Klik "Create new Address"
  - Indtast din danske adresse
  - Verificer (kan tage et par timer)

### 4.4 Noter credentials
1. Gå til https://console.twilio.com
2. Se dashboard
3. Noter "Account SID" og "Auth Token"
4. **Gem disse sikkert** - du skal bruge dem senere (valgfrit for PoC)

## 5. Klon og konfigurer projektet

### 5.1 Klon repository
```bash
git clone https://github.com/DIT-BRUGERNAVN/echotext.git
cd echotext
```

Eller hvis du allerede har det:
```bash
cd echotext
```

### 5.2 Installer dependencies
```bash
cd worker
npm install
```

### 5.3 Opsæt secrets
```bash
# Fra worker/ mappen:
wrangler secret put DEEPGRAM_API_KEY
# Indsæt din Deepgram API key når prompted

wrangler secret put GOOGLE_TTS_API_KEY
# Indsæt din Google Cloud API key når prompted
```

### 5.4 Opsæt development environment (valgfrit)
For lokal udvikling kan du oprette en `.dev.vars` fil:

```bash
# Fra worker/ mappen:
cat > .dev.vars << 'EOF'
DEEPGRAM_API_KEY=din_deepgram_key
GOOGLE_TTS_API_KEY=din_google_key
TWILIO_ACCOUNT_SID=din_twilio_account_sid
TWILIO_AUTH_TOKEN=din_twilio_auth_token
EOF
```

**⚠️ OBS:** Commit ALDRIG `.dev.vars` til git! Den er allerede i `.gitignore`.

## 6. Deploy Worker

### 6.1 Deploy til Cloudflare
```bash
# Fra worker/ mappen:
wrangler deploy
```

Du får output som:
```
Published echotext (X.XX sec)
  https://echotext.DIN-SUBDOMAIN.workers.dev
```

**Noter denne URL!** Du skal bruge den i næste trin.

### 6.2 Verificer deployment
```bash
curl https://echotext.DIN-SUBDOMAIN.workers.dev/health
```

Forventet svar:
```json
{"status": "ok"}
```

## 7. Konfigurer Twilio Webhook

### 7.1 Find dit Twilio nummer
1. Gå til https://console.twilio.com/us1/develop/phone-numbers/manage/incoming
2. Klik på dit danske nummer

### 7.2 Opsæt Voice webhook
1. Scroll ned til "Voice Configuration"
2. Under "A call comes in":
   - Webhook: `https://echotext.DIN-SUBDOMAIN.workers.dev/incoming-call`
   - HTTP Method: `POST`
3. Klik "Save"

## 8. Test systemet

### 8.1 Åbn webside
Åbn i din browser:
```
https://echotext.DIN-SUBDOMAIN.workers.dev/
```

Du skulle se en simpel side med:
- Status: "Waiting for call..."
- Et tekstfelt
- En "Send" knap

### 8.2 Ring til dit Twilio nummer
1. Tag din telefon
2. Ring til dit Twilio nummer (+45 XX XX XX XX)
3. Sig noget på dansk
4. Se transskriptionen dukke op i browseren i realtid

### 8.3 Send et svar
1. Skriv noget i tekstfeltet (f.eks. "Hej, kan du høre mig?")
2. Klik "Send"
3. Du skulle høre Google TTS læse din tekst op

## 9. Troubleshooting

### ❌ Kan ikke købe dansk Twilio nummer
**Problem:** "No phone numbers found" eller danske numre vises ikke.

**Løsning:**
1. Sørg for at din Twilio konto er opgraderet (ikke trial)
2. Tilføj betalingsmetode: https://console.twilio.com/billing
3. Nogle numre kræver dansk adresse - opret Address SID
4. Vent 1-2 timer efter opgradering

### ❌ Trial account besked i opkald
**Problem:** Twilio siger "You have a trial account" når du ringer.

**Løsning:**
- Opgrader din Twilio konto fra trial til paid account
- Gå til https://console.twilio.com/billing
- Tilføj kreditkort

### ❌ Worker deployer ikke
**Problem:** `wrangler deploy` fejler.

**Løsning:**
```bash
# Tjek at du er logget ind
wrangler whoami

# Tjek wrangler.toml er korrekt
cat wrangler.toml

# Deploy med verbose output
wrangler deploy --verbose
```

### ❌ Ingen transskription vises
**Problem:** Browser viser intet når nogen taler.

**Løsning:**
1. Åbn browser console (F12 → Console tab)
2. Se efter WebSocket fejl eller connection errors
3. Tjek at sessionId matcher mellem Twilio og browser
4. Verificer Deepgram API key virker: https://console.deepgram.com
5. Se worker logs: `wrangler tail`

### ❌ TTS virker ikke (intet lyd når du sender)
**Problem:** Dit tekstsvar bliver ikke læst op.

**Løsning:**
1. Verificer Google Cloud API key er korrekt
2. Tjek at Text-to-Speech API er aktiveret i GCP projektet
3. Se worker logs for fejlmeddelelser: `wrangler tail`
4. Test API key manuelt:
```bash
curl -X POST "https://texttospeech.googleapis.com/v1/text:synthesize?key=DIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":{"text":"Hej"},"voice":{"languageCode":"da-DK"},"audioConfig":{"audioEncoding":"MP3"}}'
```

### ❌ Twilio webhook fejler
**Problem:** Opkald forbinder ikke til din worker.

**Løsning:**
1. Gå til https://console.twilio.com/us1/monitor/logs/debugger
2. Find fejl-logs for dit nummer
3. Tjek at webhook URL er korrekt: `https://echotext.DIN-SUBDOMAIN.workers.dev/incoming-call`
4. Tjek at HTTP method er POST (ikke GET)
5. Test webhook manuelt: `curl -X POST https://echotext.DIN-SUBDOMAIN.workers.dev/incoming-call`

### ❌ WebSocket forbindelse fejler
**Problem:** Browser kan ikke connecte til worker.

**Løsning:**
```bash
# Test worker health endpoint
curl https://echotext.DIN-SUBDOMAIN.workers.dev/health

# Se real-time worker logs
wrangler tail

# Test med verbose output
wrangler tail --format json
```

### ❌ "Secrets not found" fejl
**Problem:** Worker kan ikke finde DEEPGRAM_API_KEY eller GOOGLE_TTS_API_KEY.

**Løsning:**
```bash
# List alle secrets
wrangler secret list

# Sæt secrets igen hvis de mangler
wrangler secret put DEEPGRAM_API_KEY
wrangler secret put GOOGLE_TTS_API_KEY

# Deploy igen
wrangler deploy
```

### 💡 Debug tips
```bash
# Se real-time logs fra din deployed worker
wrangler tail

# Test om worker kører
curl https://echotext.DIN-SUBDOMAIN.workers.dev/

# Se alle dine Twilio opkald
# https://console.twilio.com/us1/monitor/logs/calls

# Tjek Deepgram usage
# https://console.deepgram.com/usage

# Tjek Google Cloud quotas
# https://console.cloud.google.com/apis/api/texttospeech.googleapis.com/quotas
```

## 10. Development workflow

### 10.1 Lokal udvikling
```bash
# Fra worker/ mappen:
npm run dev
```

Dette starter en lokal server på `http://localhost:8787`

### 10.2 Se logs
```bash
# Real-time logs fra production
wrangler tail

# Eller med filter
wrangler tail --format json
```

### 10.3 Test durable objects lokalt
```bash
# Dev mode med durable objects
wrangler dev --local
```

### 10.4 Deploy ændringer
```bash
wrangler deploy
```

## 11. Priser og omkostninger

### Estimat for 10 opkald/md á 5 minutter:

| Service | Pris | Note |
|---------|------|------|
| **Cloudflare Workers** | Gratis | Op til 100k req/dag |
| **Cloudflare Durable Objects** | Gratis | Op til 1M req/md |
| **Twilio nummer** | ~$15/md | Dansk nummer |
| **Twilio opkald** | ~$0.013/min | Indgående opkald |
| **Deepgram** | ~$0.0043/min | Nova-2 model |
| **Google TTS** | ~$16/1M chars | Wavenet |

**Total for 50 min/md:** ~$16-17/md (~115 kr/md)

### Gratis tiers:
- Cloudflare: Generøs gratis tier
- Deepgram: $200 gratis credits ved signup
- Google Cloud: $300 gratis credits første år

## 12. Næste skridt

### Forbedringer du kan lave:
- [ ] Tilføj styling til web interface
- [ ] Implementer samtalehistorik
- [ ] Tilføj PWA support for notifikationer
- [ ] Understøt udgående opkald
- [ ] Tilføj hurtigsvar ("Jeg ringer tilbage", osv.)

Se [README.md](README.md) for fuld roadmap.

## Support

Hvis du støder på problemer:

1. **Tjek logs:**
   ```bash
   wrangler tail
   ```

2. **Twilio debugger:**
   https://console.twilio.com/us1/monitor/logs/debugger

3. **Deepgram console:**
   https://console.deepgram.com/usage

4. **Browser console:**
   F12 → Console tab

## Nyttige links

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Deepgram API Reference](https://developers.deepgram.com/reference/)
- [Google TTS Documentation](https://cloud.google.com/text-to-speech/docs)
- [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams)
