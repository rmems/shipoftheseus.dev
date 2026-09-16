export type ProjectStatus = 'Active research' | 'In development' | 'Exploration';
export interface Project {
  name: string;
  slug: string;
  status: ProjectStatus;
  category: string;
  technologies: string[];
  summary: string;
  questions: string[];
  links: { label: string; href: string }[];
  featured: boolean;
}

export const projects: Project[] = [
  {
    name: 'Ship of Theseus Workstation',
    slug: 'ship-of-theseus-workstation',
    status: 'Active research',
    category: 'Research infrastructure',
    technologies: ['Linux', 'GPU compute', 'Self-hosting', 'Reproducible systems'],
    summary: 'An AI/HPC research node and self-hosted engineering environment designed for hands-on systems work, experiments, and durable local workflows.',
    questions: [
      'How can a local research environment make experiments easier to inspect and repeat?',
      'Which parts of the system should be reproducible rather than dependent on workstation state?',
    ],
    links: [],
    featured: true,
  },
  {
    name: 'Synthetic Factory',
    slug: 'synthetic-factory',
    status: 'In development',
    category: 'Data systems',
    technologies: ['Python', 'Deterministic pipelines', 'Provenance', 'Validation'],
    summary: 'Deterministic infrastructure for building provenance-focused synthetic engineering data, with an emphasis on executable sources and inspectable generation paths.',
    questions: [
      'How can generated engineering data retain a clear path back to executable sources?',
      'What validation makes a deterministic pipeline easier to inspect and revise?',
    ],
    links: [],
    featured: true,
  },
  {
    name: 'Grok-1/SAAQ research',
    slug: 'grok-1-saaq-research',
    status: 'Exploration',
    category: 'Research exploration',
    technologies: ['Quantization', 'Neuromorphic computing', 'Research engineering'],
    summary: 'An ongoing exploration of quantization and neuromorphic, brain-inspired systems through careful research and prototype-oriented engineering.',
    questions: [
      'Where do quantization and brain-inspired architectures create useful research questions?',
      'How can prototype-oriented engineering keep exploratory work legible?',
    ],
    links: [],
    featured: true,
  },
];
