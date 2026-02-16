# EchoText - Projekt Oversigt

## Projektets formål
Live transskription af telefonopkald for døve med mulighed for at svare via tekst-til-tale.
Dansk alternativ til Nagish, da Nagish ikke understøtter danske telefonnumre.

## Use Cases
1. **Jobsamtaler** - Modtag opkald fra rekrutterer og svar professionelt
2. **Læge og sundhed** - Modtag prøvesvar og aftaler fra hospitalet
3. **Bank og myndigheder** - Håndter officielle opkald selvstændigt
4. **Håndværkere og service** - Koordiner praktiske ting direkte
5. **Familie og venner** - Hold kontakten med dem der foretrækker at ringe

## Sprog og lokalisering
- **Primært sprog:** Dansk
- Transskription via Deepgram Nova-2 (dansk model)
- Text-to-Speech via Google TTS Wavenet (dansk stemme)

## Nuværende status
**PoC fase (v1.0)** - Validering af teknologi til danske telefonopkald

Færdigt:
- ✅ Deepgram dansk transskription test

I gang:
- Cloudflare Worker med Durable Object
- Twilio Media Streams integration
- Google TTS integration
- Simpel webside til transskription

## Succeskriterier for PoC
1. Transskription: Kan brugeren forstå hvad opkalder siger?
2. TTS: Kan opkalder forstå brugerens svar?
3. Latency: Er forsinkelsen acceptabel for en samtale?

## Fremtidige versioner
- v1.1: Notifikationer (PWA, push, vibration)
- v1.2: Udgående opkald
- v2.0: Brug dit eget nummer
- v2.1: Samtalehistorik
- v3.0: Multi-user platform
