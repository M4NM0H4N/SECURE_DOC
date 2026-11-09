---
name: ui-ux-pro-max
description: Guidelines for building modern, premium, high-end UI/UX designs (glassmorphism, tailored palettes, premium fonts, rich animations).
---
# UI/UX Pro Max Guidelines

Use these instructions when designing or implementing user interfaces to ensure a premium, modern, and engaging user experience.

## Aesthetic Core

1. **Color Palette**:
   - Avoid plain browser defaults or raw primary colors (e.g., `#FF0000`, `#0000FF`).
   - Use curated, harmonious palettes using HSL or CSS variables.
   - Always support sleek dark mode by default, or provide a high-contrast elegant toggle.
   - Use soft gradients (e.g., `linear-gradient(135deg, #667eea 0%, #764ba2 100%)`).

2. **Typography**:
   - Avoid generic serif/sans-serif system fonts unless heavily styled.
   - Load premium, modern web fonts (e.g., Inter, Outfit, Plus Jakarta Sans, Playfair Display) from Google Fonts.
   - Set appropriate line-height (e.g., 1.5 - 1.6 for body) and letter-spacing for clean scannability.

3. **Visual Effects**:
   - **Glassmorphism**: Use translucent backdrops (`backdrop-filter: blur(10px)`) combined with thin, semi-transparent borders (`border: 1px solid rgba(255,255,255,0.1)`).
   - **Glow & Shadows**: Apply soft, layered box-shadows (e.g., `box-shadow: 0 10px 30px -10px rgba(0,0,0,0.3)`).
   - **Rounded Corners**: Use modern border-radius ratios (e.g., `8px`, `12px`, `16px`).

4. **Interactivity & Micro-animations**:
   - Ensure all interactive elements (buttons, cards, links) have transition properties (e.g., `transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1)`).
   - Add scale on hover (e.g., `transform: translateY(-2px) scale(1.02)`).
   - Use SVG icons (e.g., Lucide, Heroicons) instead of text or raw emojis for UI elements.
