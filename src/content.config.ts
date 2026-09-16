import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const notes = defineCollection({
  loader: glob({ base: './src/content/notes', pattern: '**/*.{md,mdx}' }),
  schema: z.object({ title: z.string(), description: z.string(), draft: z.boolean().default(true), published: z.coerce.date() }),
});
export const collections = { notes };
