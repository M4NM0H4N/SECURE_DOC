---
name: responsive-mobile-first
description: Guidelines for building responsive, mobile-first layouts with smooth breakpoints and touch target optimizations.
---
# Responsive Mobile-First Guidelines

This skill enforces mobile-first styling practices to guarantee layouts scale perfectly from tiny mobile screens to large desktop monitors.

## Guidelines

1. **Mobile-First CSS**:
   - Write styles for mobile screens first (default styles).
   - Use min-width media queries (e.g., `@media (min-width: 768px)`) to add desktop-specific layout improvements.

2. **Fluid Layouts**:
   - Avoid fixed pixel widths for containers (e.g., `width: 800px`). Use max-width and percentage or viewport units (e.g., `width: 100%`, `max-width: 1200px`).
   - Use CSS Grid and Flexbox for modular, self-adjusting grid columns (e.g., `grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))`).

3. **Touch Targets & Clickables**:
   - Ensure all interactive elements on mobile have a minimum tap target size of `48px x 48px` to prevent misclicks.
   - Use margins/paddings to increase hit areas without necessarily making the element icons/text visually bloated.
