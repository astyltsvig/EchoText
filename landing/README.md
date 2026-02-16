# EchoText Landing Page

Professionel landing page bygget med Astro til at præsentere og pitche EchoText projektet.

## Quick Start

```bash
npm install
npm run dev
```

Åbn http://localhost:4321

## Features

- 🚀 Astro SSG - Ultra hurtig
- 📱 Fully responsive
- 🎨 Moderne gradient design
- 💰 Transparent pricing
- ✨ Zero JavaScript
- 🌐 SEO optimeret

## Deploy

### Cloudflare Pages
```bash
npm run build
wrangler pages deploy dist
```

Configuration:
- Build command: `npm run build`
- Build output: `dist`
- Root: `landing`

## Customization

Rediger `src/pages/index.astro`:
- Hero text (linje 34)
- Problem cards (linje 70-93)
- Pricing (linje 206-279)
- Søg & erstat `dit-brugernavn` med dit GitHub username

## License

MIT
