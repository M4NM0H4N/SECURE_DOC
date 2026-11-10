'use strict';

const Tenant = require('../models/Tenant');
const AppError = require('../utils/AppError');

const MAX_LOGO_BYTES = 100 * 1024;
const HEX = /^#[0-9a-fA-F]{6}$/;

// WCAG relative luminance and contrast ratio.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrastWithWhite = (hex) => 1.05 / (luminance(hex) + 0.05);

// The brand colour is used for buttons and links on a white page, so it must be readable against
// white (WCAG AA, 4.5:1). Colours that are too light are refused with a clear message.
function validateColor(color) {
  if (!HEX.test(color)) throw new AppError(400, 'Colour must look like #1A56DB');
  if (contrastWithWhite(color) < 4.5) throw new AppError(400, 'That colour is too light to read on a white page. Choose a darker one (contrast of at least 4.5:1 with white).');
  return color.toUpperCase();
}

// Logos are tiny PNG or JPEG files (checked by their real signature, never SVG: SVG can carry script).
function logoType(buffer) {
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  return null;
}

// What the sign-in page needs before anyone is signed in. Public, and nothing sensitive.
async function publicBranding(tenant) {
  const t = await Tenant.findById(tenant._id, 'name branding logoUpdatedAt logoType');
  return {
    name: t.name,
    color: (t.branding && t.branding.color) || null,
    tagline: (t.branding && t.branding.tagline) || null,
    hasLogo: Boolean(t.logoType),
    logoVersion: t.logoUpdatedAt ? t.logoUpdatedAt.getTime() : null,
  };
}

async function setBranding(tenant, { color, tagline }) {
  const set = {};
  if (color !== undefined) set['branding.color'] = color === null || color === '' ? null : validateColor(color);
  if (tagline !== undefined) set['branding.tagline'] = tagline === null || tagline === '' ? null : tagline;
  if (Object.keys(set).length) await Tenant.updateOne({ _id: tenant._id }, { $set: set });
  return publicBranding(tenant);
}

async function setLogo(tenant, file) {
  if (!file || !file.buffer || file.size === 0) throw new AppError(400, 'Choose a logo file (field "logo")');
  if (file.size > MAX_LOGO_BYTES) throw new AppError(413, 'The logo is larger than 100 KB');
  const type = logoType(file.buffer);
  if (!type) throw new AppError(400, 'The logo must be a PNG or JPEG image');
  await Tenant.updateOne({ _id: tenant._id }, { $set: { logo: file.buffer, logoType: type, logoUpdatedAt: new Date() } });
  return publicBranding(tenant);
}

async function removeLogo(tenant) {
  await Tenant.updateOne({ _id: tenant._id }, { $set: { logoType: null, logoUpdatedAt: new Date() }, $unset: { logo: '' } });
  return publicBranding(tenant);
}

async function getLogo(tenant) {
  const t = await Tenant.findById(tenant._id).select('+logo logoType');
  if (!t || !t.logoType || !t.logo) throw new AppError(404, 'No logo');
  return { type: t.logoType, data: t.logo };
}

module.exports = { publicBranding, setBranding, setLogo, removeLogo, getLogo, validateColor, contrastWithWhite, logoType, MAX_LOGO_BYTES };
