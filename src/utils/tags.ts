import { getCollection, type CollectionEntry } from 'astro:content';

// "Hardware" and "hardware " both become "hardware"; "AI & ML" becomes "ai-ml".
// Returns '' for tags with no letters or numbers (those are shown but not linked).
export function tagSlug(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface TagInfo {
  slug: string;
  label: string;
  posts: CollectionEntry<'blog'>[];
  projects: CollectionEntry<'projects'>[];
  count: number;
}

// Every tag used by a published (non-draft) post or project, with the entries
// that use it. Newest entries first; most-used tags first.
export async function getTagIndex(): Promise<TagInfo[]> {
  const posts = (await getCollection('blog', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf()
  );
  const projects = (await getCollection('projects', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.date.valueOf() - a.data.date.valueOf()
  );

  const tags = new Map<string, TagInfo>();
  function entryFor(rawTag: string): TagInfo | undefined {
    const slug = tagSlug(rawTag);
    if (!slug) return undefined;
    let info = tags.get(slug);
    if (!info) {
      info = { slug, label: rawTag.trim(), posts: [], projects: [], count: 0 };
      tags.set(slug, info);
    }
    return info;
  }

  for (const post of posts) {
    for (const tag of post.data.tags) {
      const info = entryFor(tag);
      if (info && !info.posts.includes(post)) info.posts.push(post);
    }
  }
  for (const project of projects) {
    for (const tag of project.data.tags) {
      const info = entryFor(tag);
      if (info && !info.projects.includes(project)) info.projects.push(project);
    }
  }

  const list = [...tags.values()];
  for (const info of list) info.count = info.posts.length + info.projects.length;
  return list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
