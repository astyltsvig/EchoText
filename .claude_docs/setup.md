# EchoText - Opsætning og Development

## Forudsætninger
- Node.js (v18+)
- npm eller yarn
- Cloudflare account
- Wrangler CLI installeret globalt

## 1. Opret konti og få API keys

### Deepgram (Speech-to-Text)
1. Gå til https://deepgram.com
2. Opret konto
3. Naviger til API Keys sektion
4. Opret ny API key
5. Gem key sikkert (bruges senere)
6. **Note:** $200 gratis credits ved signup

### Google Cloud (Text-to-Speech)
1. Gå til https://console.cloud.google.com
2. Opret nyt projekt (eller vælg eksisterende)
3. Aktiver "Cloud Text-to-Speech API"
4. Gå til "APIs & Services" → "Credentials"
5. Opret API key
6. Gem key sikkert
7. **Note:** Gratis tier: 0-4 millioner tegn/måned

### Twilio (Telefoni)
1. Gå til https://www.twilio.com
2. Opret konto
3. Gå til "Phone Numbers" → "Buy a number"
4. Køb et dansk nummer (+45) - koster ~$15/måned
5. Noter Account SID og Auth Token fra Dashboard
6. **Note:** Twilio giver gratis trial credits

### Cloudflare (Hosting)
1. Gå til https://dash.cloudflare.com
2. Opret konto
3. Installer Wrangler CLI: `npm install -g wrangler`
4. Login: `wrangler login`
5. **Note:** Workers free tier er tilstrækkelig til PoC

## 2. Lokal opsætning

### Installer dependencies
```bash
cd worker
npm install
```

### Konfigurer secrets
```bash
cd worker

# Sæt Deepgram API key
wrangler secret put DEEPGRAM_API_KEY
# Paste din Deepgram API key når prompted

# Sæt Google TTS API key
wrangler secret put GOOGLE_TTS_API_KEY
# Paste din Google Cloud API key når prompted
```

### Konfigurer wrangler.toml
Tjek at [wrangler.toml](../worker/wrangler.toml) har korrekte indstillinger:
```toml
name = "echotext"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[durable_objects]
bindings = [
  { name = "CALL_SESSION", class_name = "CallSession" }
]

[[migrations]]
tag = "v1"
new_classes = ["CallSession"]
```

## 3. Development

### Lokal udvikling med Wrangler
```bash
cd worker
npm run dev
# eller
wrangler dev
```

Dette starter en lokal server på `http://localhost:8787`

**Note:** Nogle features (som Durable Objects) fungerer bedst i production/staging miljø.

### Test lokalt
1. Åbn `http://localhost:8787` i browser
2. For at teste med rigtige opkald skal worker deployes (se næste sektion)

## 4. Deploy til Cloudflare

### Deploy worker
```bash
cd worker
npm run deploy
# eller
wrangler deploy
```

Dette deployer til: `https://echotext.<din-subdomain>.workers.dev`

### Verificer deployment
```bash
curl https://echotext.<din-subdomain>.workers.dev/
```

## 5. Konfigurer Twilio webhook

1. Log ind på Twilio Console
2. Gå til "Phone Numbers" → "Manage" → "Active numbers"
3. Vælg dit danske nummer
4. Under "Voice Configuration" → "A call comes in":
   - **Webhook URL:** `https://echotext.<din-subdomain>.workers.dev/incoming-call`
   - **HTTP Method:** POST
5. Klik "Save"

## 6. Test systemet

### Komplet test
1. Åbn `https://echotext.<din-subdomain>.workers.dev/` i browser
2. Ring til dit Twilio nummer fra en anden telefon
3. Du skulle se:
   - Browser viser live transskription af det du siger
   - Du kan skrive et svar i tekstfeltet
   - Klik "Send" - opkalder hører dit svar som tale

### Debugging
Hvis noget ikke virker:
1. Tjek Cloudflare Worker logs: `wrangler tail`
2. Tjek Twilio logs: Twilio Console → "Monitor" → "Logs" → "Call Logs"
3. Tjek browser console for fejl

## 7. Prisestimat (PoC)

Baseret på ~10 opkald á 5 minutter per måned:

| Service | Pris/måned |
|---------|------------|
| Twilio nummer | ~$15 |
| Twilio tale | ~$1 |
| Deepgram | ~$0.20 (gratis credits) |
| Google TTS | ~$0.05 |
| Cloudflare | Gratis |
| **Total** | **~$16 (~110 kr)** |

## Environment variables

Worker skal bruge følgende secrets (sættes via `wrangler secret put`):
- `DEEPGRAM_API_KEY` - API key fra Deepgram
- `GOOGLE_TTS_API_KEY` - API key fra Google Cloud

## Troubleshooting

### "Durable Object not found"
Kør migrations igen:
```bash
wrangler deploy
```

### Ingen transskription vises
- Tjek at Deepgram API key er sat korrekt
- Tjek worker logs: `wrangler tail`
- Verificer at Deepgram har credits tilbage

### TTS virker ikke
- Tjek at Google TTS API key er sat korrekt
- Verificer at Text-to-Speech API er aktiveret i Google Cloud Console
- Tjek worker logs for fejlmeddelelser

### Twilio webhook fejler
- Verificer at webhook URL er korrekt i Twilio Console
- Tjek at worker er deployed og tilgængelig
- Test webhook URL manuelt med curl

## Næste skridt efter PoC

Når PoC virker:
1. Test kvalitet af transskription
2. Test TTS kvalitet
3. Mål latency
4. Planlæg v1.1 features (notifikationer)
