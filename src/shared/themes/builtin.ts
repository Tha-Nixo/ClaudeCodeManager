import type { Theme } from '../theme'

/**
 * Temi integrati. Il primo è il predefinito.
 *
 * Ogni palette è costruita perché il terminale e la cornice condividano la
 * stessa famiglia di grigi: è la differenza fra un tema e due tavolozze
 * accostate. I 16 colori ANSI sono desaturati verso il fondo, così l'output
 * colorato di Claude Code non stona con l'interfaccia.
 */
export const BUILTIN_THEMES: Theme[] = [
  {
    id: 'claude-dark',
    name: 'Claude Dark',
    description: 'grigio caldo e terracotta',
    dark: true,
    ui: {
      desktop: '#1F1E1D',
      panel: '#262625',
      panelRaised: '#2E2D2B',
      borderIdle: '#3A3937',
      borderFocus: '#D97757',
      text: '#F0EEE6',
      textDim: '#8C8B87',
      accent: '#D97757',
      ok: '#7DA87B',
      waiting: '#E0A458',
      error: '#C15F3C'
    },
    terminal: {
      background: '#1A1917',
      foreground: '#F0EEE6',
      cursor: '#D97757',
      selection: '#3E3C38',
      ansi: [
        '#2B2A28', '#C15F3C', '#7DA87B', '#E0A458',
        '#6E9CB8', '#A98BB5', '#79A8A0', '#D6D3C9',
        '#5C5A55', '#D97757', '#96C293', '#EFBE77',
        '#8AB6D0', '#C0A5CA', '#93C0B8', '#F0EEE6'
      ]
    }
  },
  {
    id: 'claude-light',
    name: 'Claude Light',
    description: 'la stessa palette, su carta',
    dark: false,
    ui: {
      desktop: '#EDEAE2',
      panel: '#F7F5EF',
      panelRaised: '#E8E4DA',
      borderIdle: '#D3CEC2',
      borderFocus: '#C15F3C',
      text: '#26251F',
      textDim: '#6E6B62',
      accent: '#C15F3C',
      ok: '#4E7A4C',
      waiting: '#9A6B1E',
      error: '#A8442A'
    },
    terminal: {
      background: '#FBF9F4',
      foreground: '#26251F',
      cursor: '#C15F3C',
      selection: '#DCD6C8',
      ansi: [
        '#3B392F', '#A8442A', '#4E7A4C', '#9A6B1E',
        '#3F6A87', '#7A5A89', '#3F7A70', '#B8B2A4',
        '#6E6B62', '#C15F3C', '#5F9A5C', '#B98430',
        '#5289A8', '#977BA6', '#54948A', '#26251F'
      ]
    }
  },
  {
    id: 'mezzanotte',
    name: 'Mezzanotte',
    description: 'blu freddo, poco contrasto',
    dark: true,
    ui: {
      desktop: '#16181D',
      panel: '#1E2128',
      panelRaised: '#272B34',
      borderIdle: '#2E3440',
      borderFocus: '#7AA2F7',
      text: '#C0CAF5',
      textDim: '#6B7394',
      accent: '#7AA2F7',
      ok: '#9ECE6A',
      waiting: '#E0AF68',
      error: '#F7768E'
    },
    terminal: {
      background: '#131519',
      foreground: '#C0CAF5',
      cursor: '#7AA2F7',
      selection: '#2E3440',
      ansi: [
        '#1E2128', '#F7768E', '#9ECE6A', '#E0AF68',
        '#7AA2F7', '#BB9AF7', '#7DCFFF', '#A9B1D6',
        '#414868', '#FF9FB0', '#B4DA85', '#EDC08A',
        '#9BBAF9', '#CDB4F9', '#9BDCFF', '#C0CAF5'
      ]
    }
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    description: 'caldo, retro, alto contrasto',
    dark: true,
    ui: {
      desktop: '#1D2021',
      panel: '#282828',
      panelRaised: '#32302F',
      borderIdle: '#3C3836',
      borderFocus: '#FE8019',
      text: '#EBDBB2',
      textDim: '#928374',
      accent: '#FE8019',
      ok: '#B8BB26',
      waiting: '#FABD2F',
      error: '#FB4934'
    },
    terminal: {
      background: '#1D2021',
      foreground: '#EBDBB2',
      cursor: '#FE8019',
      selection: '#504945',
      ansi: [
        '#282828', '#CC241D', '#98971A', '#D79921',
        '#458588', '#B16286', '#689D6A', '#A89984',
        '#928374', '#FB4934', '#B8BB26', '#FABD2F',
        '#83A598', '#D3869B', '#8EC07C', '#EBDBB2'
      ]
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'grigio-azzurro, riposante',
    dark: true,
    ui: {
      desktop: '#2E3440',
      panel: '#3B4252',
      panelRaised: '#434C5E',
      borderIdle: '#4C566A',
      borderFocus: '#88C0D0',
      text: '#ECEFF4',
      textDim: '#8894A8',
      accent: '#88C0D0',
      ok: '#A3BE8C',
      waiting: '#EBCB8B',
      error: '#BF616A'
    },
    terminal: {
      background: '#2B303B',
      foreground: '#ECEFF4',
      cursor: '#88C0D0',
      selection: '#4C566A',
      ansi: [
        '#3B4252', '#BF616A', '#A3BE8C', '#EBCB8B',
        '#81A1C1', '#B48EAD', '#88C0D0', '#E5E9F0',
        '#4C566A', '#D08770', '#B5CF9F', '#F0D9A4',
        '#9BB6D4', '#C6A4C1', '#9FD0DD', '#ECEFF4'
      ]
    }
  },
  {
    id: 'alto-contrasto',
    name: 'Alto contrasto',
    description: 'massima leggibilità',
    dark: true,
    ui: {
      desktop: '#000000',
      panel: '#0D0D0D',
      panelRaised: '#1A1A1A',
      borderIdle: '#4D4D4D',
      borderFocus: '#FFB000',
      text: '#FFFFFF',
      textDim: '#B3B3B3',
      accent: '#FFB000',
      ok: '#00E676',
      waiting: '#FFD400',
      error: '#FF5252'
    },
    terminal: {
      background: '#000000',
      foreground: '#FFFFFF',
      cursor: '#FFB000',
      selection: '#404040',
      ansi: [
        // Il nero ANSI non può coincidere con lo sfondo: era '#000000' su
        // fondo '#000000', cioè invisibile, e qualunque output che lo usa —
        // cornici, barre di avanzamento, diff — spariva del tutto. Proprio nel
        // tema che promette la massima leggibilità.
        '#4D4D4D', '#FF5252', '#00E676', '#FFD400',
        '#40A9FF', '#E066FF', '#00E5FF', '#D9D9D9',
        '#808080', '#FF8A80', '#69F0AE', '#FFEA00',
        '#82CFFF', '#EA96FF', '#84FFFF', '#FFFFFF'
      ]
    }
  }
]

export const DEFAULT_THEME_ID = BUILTIN_THEMES[0].id
