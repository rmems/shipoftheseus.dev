export const site = {
  name: 'Ship of Theseus',
  fullName: 'Raul Cardenas Montoya',
  title: 'AI/ML systems engineer',
  description: 'AI/ML systems engineering across agentic systems, GPU compute, neuromorphic research, and reproducible software.',
  email: null,
  social: {
    github: 'https://github.com/rmems',
    linkedin: 'https://www.linkedin.com/in/raul-cardenas-montoya-8aa09839a',
    huggingface: 'https://huggingface.co/rmems',
  },
  resumePath: null,
} as const;

export const navigation = [
  { href: '/work/', label: 'Work' },
  { href: '/about/', label: 'About' },
  { href: '/notes/', label: 'Notes' },
  { href: '/contact/', label: 'Contact' },
] as const;
