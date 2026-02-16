# EchoText - QuickStart (5 minutter)

Hurtig opsætning for dem der bare vil i gang. Detaljeret guide: [SETUP.md](SETUP.md)

## Forudsætninger
- Node.js 18+ installeret
- Kreditkort til Twilio (~110 kr/md)

## 1. Opret konti og få API keys (10 min)

### Cloudflare
```bash
npm install -g wrangler
wrangler login
```

### Deepgram
1. Opret konto: https://console.deepgram.com ($200 gratis)
2. Gå til Keys → Create API Key
3. Kopier nøglen

### Google Cloud
1. Opret projekt: https://console.cloud.google.com
2. Enable API: https://console.cloud.google.com/apis/library/texttospeech.googleapis.com
3. Create credentials → API key
4. Kopier nøglen

### Twilio
1. Opret konto: https://www.twilio.com
2. **Opgrader til paid** (vigtigt!): https://console.twilio.com/billing
3. Køb dansk nummer (+45): https://console.twilio.com/us1/develop/phone-numbers/manage/search
4. Noter nummeret

## 2. Deploy (2 min)

```bash
cd echotext/worker
npm install

# Sæt API keys
wrangler secret put DEEPGRAM_API_KEY
# → Indsæt Deepgram key
wrangler secret put GOOGLE_TTS_API_KEY
# → Indsæt Google key

# Deploy
wrangler deploy
```

Noter din worker URL: `https://echotext.XXX.workers.dev`

## 3. Konfigurer Twilio (1 min)

1. Gå til: https://console.twilio.com/us1/develop/phone-numbers/manage/incoming
2. Klik på dit nummer
3. Under "Voice Configuration" → "A call comes in":
   - Webhook: `https://echotext.XXX.workers.dev/incoming-call`
   - Method: POST
4. Klik Save

## 4. Test (1 min)

1. Åbn: `https://echotext.XXX.workers.dev/`
2. Ring til dit Twilio nummer
3. Sig noget på dansk
4. Se transskription i browseren
5. Skriv et svar og klik Send

## ✅ Færdig!

Virker det ikke? Se [SETUP.md](SETUP.md#9-troubleshooting) for troubleshooting.

## Common issues

### "No phone numbers found" i Twilio
→ Opgrader kontoen fra trial til paid

### Ingen transskription vises
→ Åbn F12 console og se efter fejl
→ Kør `wrangler tail` i terminal

### TTS virker ikke
→ Tjek at Google Text-to-Speech API er enabled

---

## Hvad koster det?

~110 kr/md for 10 opkald á 5 minutter:
- Twilio nummer: ~105 kr/md
- Twilio tale: ~7 kr
- Deepgram: Gratis ($200 credits)
- Google TTS: Gratis ($300 credits)
- Cloudflare: Gratis

## Næste skridt

- Se [README.md](README.md) for arkitektur og roadmap
- Se [SETUP.md](SETUP.md) for detaljeret guide
- Byg frontend: [web/](web/)
