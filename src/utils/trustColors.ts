import type { TrustTier } from '../types'

export const tierColors: Record<TrustTier, { bg: string; text: string; border: string; hex: string; mapColor: string }> = {
  green: {
    bg: 'bg-green-100',
    text: 'text-green-800',
    border: 'border-green-400',
    hex: '#16a34a',
    mapColor: '#16a34a',
  },
  amber: {
    bg: 'bg-amber-100',
    text: 'text-amber-800',
    border: 'border-amber-400',
    hex: '#d97706',
    mapColor: '#d97706',
  },
  red: {
    bg: 'bg-red-100',
    text: 'text-red-800',
    border: 'border-red-400',
    hex: '#dc2626',
    mapColor: '#dc2626',
  },
}

export const damageLevelLabel: Record<string, string> = {
  minimal: 'Minimal Damage',
  partial: 'Partially Damaged',
  destroyed: 'Completely Destroyed',
}

export const infraTypeLabel: Record<string, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
  government: 'Government',
  utility: 'Utility',
  transport: 'Transport / Communication',
  community: 'Community',
  public_space: 'Public Space',
  other: 'Other',
}

export const channelLabel: Record<string, string> = {
  pwa: 'PWA (Route A)',
  browser: 'Browser (Route B)',
  whatsapp: 'WhatsApp (Route C)',
}
