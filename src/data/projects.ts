export type ProjectStatus = 'Active research' | 'In development' | 'Exploration';
export interface Project { name: string; slug: string; status: ProjectStatus; technologies: string[]; summary: string; links: { label: string; href: string }[]; featured: boolean; }

export const projects: Project[] = [
  { name: 'Ship of Theseus Workstation', slug: 'ship-of-theseus-workstation', status: 'Active research', technologies: ['Linux', 'GPU compute', 'Self-hosting', 'Reproducible systems'], summary: 'An AI/HPC research node and self-hosted engineering environment designed for hands-on systems work, experiments, and durable local workflows.', links: [], featured: true },
  { name: 'Synthetic Factory', slug: 'synthetic-factory', status: 'In development', technologies: ['Python', 'Deterministic pipelines', 'Provenance', 'Validation'], summary: 'Deterministic infrastructure for building provenance-focused synthetic engineering data, with an emphasis on executable sources and inspectable generation paths.', links: [], featured: true },
  { name: 'Grok-1/SAAQ research', slug: 'grok-1-saaq-research', status: 'Exploration', technologies: ['Quantization', 'Neuromorphic computing', 'Research engineering'], summary: 'An ongoing exploration of quantization and neuromorphic, brain-inspired systems through careful research and prototype-oriented engineering.', links: [], featured: true },
];
